import * as assert from 'node:assert/strict';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CLAIM_DEAD_AFTER_MS, RunClaims, deadClaims, isClaimAlive } from '../../scheduler/runClaims.js';
import { FileStateBackend } from '../../state/fileStore.js';
import { RoundsStore } from '../../state/store.js';
import { FixedClock } from '../../state/time.js';
import type { RunClaim } from '../../state/types.js';
import { emptyState } from '../../state/validate.js';

const NOW = new Date('2026-08-17T06:00:00.000Z');

function claim(overrides: Partial<RunClaim> = {}): RunClaim {
  return {
    windowId: 'window-a',
    runId: 'run-1',
    startedAt: NOW.toISOString(),
    heartbeatAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('run claims', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rounds-claims-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /**
   * Claims travel through the state file, so every window in these tests gets its own
   * store over the same directory, exactly like two editor windows do.
   */
  function windowStore(clock: FixedClock): RoundsStore {
    return new RoundsStore({
      backend: new FileStateBackend({ directory }),
      clock,
      timeZone: 'UTC',
    });
  }

  it('treats a fresh heartbeat as alive and an old one as dead', () => {
    assert.equal(isClaimAlive(claim(), NOW), true);
    const stale = claim({ heartbeatAt: new Date(NOW.getTime() - CLAIM_DEAD_AFTER_MS - 1).toISOString() });
    assert.equal(isClaimAlive(stale, NOW), false);
  });

  it('treats an unparseable heartbeat as dead rather than blocking forever', () => {
    assert.equal(isClaimAlive(claim({ heartbeatAt: 'not a date' }), NOW), false);
  });

  it('lists dead claims only', () => {
    const state = emptyState('2026-08-17');
    state.runClaims['agent-alive'] = claim();
    state.runClaims['agent-dead'] = claim({
      heartbeatAt: new Date(NOW.getTime() - CLAIM_DEAD_AFTER_MS - 1).toISOString(),
    });

    assert.deepEqual(
      deadClaims(state, NOW).map(([agentId]) => agentId),
      ['agent-dead'],
    );
  });

  it('grants a claim to the first window and refuses the second', async () => {
    const clock = new FixedClock(NOW);
    const windowA = new RunClaims({ store: windowStore(clock), windowId: 'window-a', clock });
    const windowB = new RunClaims({ store: windowStore(clock), windowId: 'window-b', clock });

    const first = await windowA.tryClaim('agent-1', 'run-1');
    const second = await windowB.tryClaim('agent-1', 'run-2');

    assert.equal(first.granted, true);
    assert.equal(second.granted, false);
    assert.equal(second.heldBy?.windowId, 'window-a');
  });

  it('lets a different agent run at the same time', async () => {
    const clock = new FixedClock(NOW);
    const claims = new RunClaims({ store: windowStore(clock), windowId: 'window-a', clock });

    assert.equal((await claims.tryClaim('agent-1', 'run-1')).granted, true);
    assert.equal((await claims.tryClaim('agent-2', 'run-2')).granted, true);
  });

  it('releases a claim so the next run can start', async () => {
    const clock = new FixedClock(NOW);
    const windowA = new RunClaims({ store: windowStore(clock), windowId: 'window-a', clock });
    const windowB = new RunClaims({ store: windowStore(clock), windowId: 'window-b', clock });

    await windowA.tryClaim('agent-1', 'run-1');
    await windowA.release('agent-1');

    assert.equal((await windowB.tryClaim('agent-1', 'run-2')).granted, true);
  });

  it('never releases a claim that belongs to another window', async () => {
    const clock = new FixedClock(NOW);
    const storeA = windowStore(clock);
    const windowA = new RunClaims({ store: storeA, windowId: 'window-a', clock });
    const windowB = new RunClaims({ store: windowStore(clock), windowId: 'window-b', clock });

    await windowA.tryClaim('agent-1', 'run-1');
    await windowB.release('agent-1');

    const state = await storeA.reload();
    assert.equal(state.runClaims['agent-1']?.windowId, 'window-a');
  });

  it('takes over a claim whose window stopped sending heartbeats', async () => {
    const clock = new FixedClock(NOW);
    const dead = new RunClaims({ store: windowStore(clock), windowId: 'window-a', clock });
    await dead.tryClaim('agent-1', 'run-1');

    // Time passes without a heartbeat, which is what a crashed window looks like.
    const laterClock = new FixedClock(new Date(NOW.getTime() + CLAIM_DEAD_AFTER_MS + 1000));
    const survivor = new RunClaims({
      store: windowStore(laterClock),
      windowId: 'window-b',
      clock: laterClock,
    });

    const result = await survivor.tryClaim('agent-1', 'run-2');
    assert.equal(result.granted, true);
  });

  it('keeps a claim alive by refreshing its heartbeat', async () => {
    const clock = new FixedClock(NOW);
    const holder = new RunClaims({ store: windowStore(clock), windowId: 'window-a', clock });
    await holder.tryClaim('agent-1', 'run-1');

    clock.advance(CLAIM_DEAD_AFTER_MS - 1000);
    await holder.refresh('agent-1');
    clock.advance(CLAIM_DEAD_AFTER_MS - 1000);

    const other = new RunClaims({ store: windowStore(clock), windowId: 'window-b', clock });
    const result = await other.tryClaim('agent-1', 'run-2');
    assert.equal(result.granted, false, 'the refreshed claim still blocks other windows');
  });

  it('refuses to refresh a claim owned by somebody else', async () => {
    const clock = new FixedClock(NOW);
    const storeA = windowStore(clock);
    const owner = new RunClaims({ store: storeA, windowId: 'window-a', clock });
    await owner.tryClaim('agent-1', 'run-1');

    const intruder = new RunClaims({ store: windowStore(clock), windowId: 'window-b', clock });
    clock.advance(60_000);
    await intruder.refresh('agent-1');

    const state = await storeA.reload();
    assert.equal(state.runClaims['agent-1']?.heartbeatAt, NOW.toISOString());
  });

  it('reports the claims held by this window', async () => {
    const clock = new FixedClock(NOW);
    const claims = new RunClaims({ store: windowStore(clock), windowId: 'window-a', clock });
    await claims.tryClaim('agent-1', 'run-1');

    assert.deepEqual((await claims.ownClaims()).map(([agentId]) => agentId), ['agent-1']);
  });
});
