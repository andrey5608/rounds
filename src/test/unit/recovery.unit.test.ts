import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recoverStaleClaims } from '../../scheduler/recovery.js';
import { CLAIM_DEAD_AFTER_MS } from '../../scheduler/runClaims.js';
import { FileStateBackend } from '../../state/fileStore.js';
import { RoundsStore } from '../../state/store.js';
import { FixedClock } from '../../state/time.js';
import type { RunRecord, RunStatus } from '../../state/types.js';

const NOW = new Date('2026-08-17T06:00:00.000Z');

function runningRun(id: string, agentId: string, status: RunStatus = 'running'): RunRecord {
  return {
    id,
    agentId,
    startedAt: new Date(NOW.getTime() - 600_000).toISOString(),
    status,
    trigger: 'schedule',
    summary: '',
    modelId: 'some-model',
    executionMode: 'api',
    toolCalls: [],
    sourceItemCount: 0,
    promptResolution: { source: 'inline', usedSnapshot: false },
  };
}

describe('crash recovery', () => {
  let directory: string;
  let store: RoundsStore;
  const clock = new FixedClock(NOW);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rounds-recovery-'));
    clock.set(NOW);
    store = new RoundsStore({
      backend: new FileStateBackend({ directory }),
      clock,
      timeZone: 'UTC',
    });
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('does nothing when there is nothing to recover', async () => {
    const result = await recoverStaleClaims({ store, windowId: 'window-now', clock });
    assert.deepEqual(result, { clearedClaims: [], interruptedRuns: [] });
  });

  it('clears a claim tagged with this activation, which can only be a leftover', async () => {
    await store.update((draft) => {
      draft.runClaims['agent-1'] = {
        windowId: 'window-now',
        runId: 'run-1',
        startedAt: NOW.toISOString(),
        heartbeatAt: NOW.toISOString(),
      };
      draft.history['agent-1'] = [runningRun('run-1', 'agent-1')];
    });

    const result = await recoverStaleClaims({ store, windowId: 'window-now', clock });

    assert.deepEqual(result.clearedClaims, ['agent-1']);
    assert.deepEqual(result.interruptedRuns, ['run-1']);

    const state = await store.reload();
    assert.deepEqual(state.runClaims, {});
    assert.equal(state.history['agent-1']?.[0]?.status, 'interrupted');
    assert.equal(state.history['agent-1']?.[0]?.finishedAt, NOW.toISOString());
  });

  it('clears a claim from another window whose heartbeat stopped', async () => {
    await store.update((draft) => {
      draft.runClaims['agent-1'] = {
        windowId: 'window-gone',
        runId: 'run-1',
        startedAt: NOW.toISOString(),
        heartbeatAt: new Date(NOW.getTime() - CLAIM_DEAD_AFTER_MS - 1000).toISOString(),
      };
    });

    const result = await recoverStaleClaims({ store, windowId: 'window-now', clock });
    assert.deepEqual(result.clearedClaims, ['agent-1']);
  });

  it('leaves a live claim from another window alone', async () => {
    await store.update((draft) => {
      draft.runClaims['agent-1'] = {
        windowId: 'window-other',
        runId: 'run-1',
        startedAt: NOW.toISOString(),
        heartbeatAt: NOW.toISOString(),
      };
      draft.history['agent-1'] = [runningRun('run-1', 'agent-1')];
    });

    const result = await recoverStaleClaims({ store, windowId: 'window-now', clock });

    assert.deepEqual(result, { clearedClaims: [], interruptedRuns: [] });
    const state = await store.reload();
    assert.equal(state.runClaims['agent-1']?.windowId, 'window-other');
    assert.equal(state.history['agent-1']?.[0]?.status, 'running');
  });

  it('does not touch runs that already finished', async () => {
    await store.update((draft) => {
      draft.runClaims['agent-1'] = {
        windowId: 'window-now',
        runId: 'run-1',
        startedAt: NOW.toISOString(),
        heartbeatAt: NOW.toISOString(),
      };
      draft.history['agent-1'] = [runningRun('run-1', 'agent-1', 'succeeded')];
    });

    const result = await recoverStaleClaims({ store, windowId: 'window-now', clock });

    assert.deepEqual(result.clearedClaims, ['agent-1']);
    assert.deepEqual(result.interruptedRuns, []);
    const state = await store.reload();
    assert.equal(state.history['agent-1']?.[0]?.status, 'succeeded');
  });

  it('recovers several agents at once', async () => {
    await store.update((draft) => {
      for (const agentId of ['agent-1', 'agent-2']) {
        draft.runClaims[agentId] = {
          windowId: 'window-now',
          runId: `run-${agentId}`,
          startedAt: NOW.toISOString(),
          heartbeatAt: NOW.toISOString(),
        };
        draft.history[agentId] = [runningRun(`run-${agentId}`, agentId)];
      }
    });

    const result = await recoverStaleClaims({ store, windowId: 'window-now', clock });
    assert.deepEqual(result.clearedClaims.sort(), ['agent-1', 'agent-2']);
    assert.equal(result.interruptedRuns.length, 2);
  });
});
