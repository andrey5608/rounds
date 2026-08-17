import * as assert from 'node:assert/strict';

import {
  HistoryService,
  allRuns,
  lastRun,
  lastSuccessfulRun,
  recentRuns,
  removeAgentHistory,
  upsertRun,
} from '../../state/history.js';
import { MementoBackend, RoundsStore } from '../../state/store.js';
import type { MementoLike } from '../../state/store.js';
import type { PersistedState, RunRecord, RunStatus } from '../../state/types.js';
import { emptyState } from '../../state/validate.js';

class FakeMemento implements MementoLike {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

function run(id: string, startedAt: string, status: RunStatus = 'succeeded'): RunRecord {
  return {
    id,
    agentId: 'agent-1',
    startedAt,
    status,
    trigger: 'schedule',
    summary: `summary of ${id}`,
    modelId: 'some-model',
    executionMode: 'api',
    toolCalls: [],
    sourceItemCount: 0,
    promptResolution: { source: 'inline', usedSnapshot: false },
  };
}

function stateWith(records: RunRecord[]): PersistedState {
  const state = emptyState('2026-08-17');
  for (const record of records) {
    upsertRun(state, record, 50);
  }
  return state;
}

describe('run history', () => {
  it('keeps runs newest first', () => {
    const state = stateWith([
      run('run-1', '2026-08-17T06:00:00.000Z'),
      run('run-3', '2026-08-17T08:00:00.000Z'),
      run('run-2', '2026-08-17T07:00:00.000Z'),
    ]);
    assert.deepEqual(
      state.history['agent-1']?.map((record) => record.id),
      ['run-3', 'run-2', 'run-1'],
    );
  });

  it('replaces a run with the same id instead of duplicating it', () => {
    const state = stateWith([run('run-1', '2026-08-17T06:00:00.000Z')]);
    upsertRun(state, { ...run('run-1', '2026-08-17T06:00:00.000Z'), status: 'failed' }, 50);

    assert.equal(state.history['agent-1']?.length, 1);
    assert.equal(state.history['agent-1']?.[0]?.status, 'failed');
  });

  it('trims to the configured limit, dropping the oldest runs', () => {
    const state = emptyState('2026-08-17');
    for (let index = 0; index < 10; index += 1) {
      upsertRun(state, run(`run-${index}`, `2026-08-17T0${index}:00:00.000Z`), 3);
    }
    assert.deepEqual(
      state.history['agent-1']?.map((record) => record.id),
      ['run-9', 'run-8', 'run-7'],
    );
  });

  it('never trims below one run even with a nonsensical limit', () => {
    const state = emptyState('2026-08-17');
    upsertRun(state, run('run-1', '2026-08-17T06:00:00.000Z'), 0);
    assert.equal(state.history['agent-1']?.length, 1);
  });

  it('answers the usual queries', () => {
    const state = stateWith([
      run('run-1', '2026-08-17T06:00:00.000Z', 'succeeded'),
      run('run-2', '2026-08-17T07:00:00.000Z', 'failed'),
    ]);

    assert.equal(lastRun(state, 'agent-1')?.id, 'run-2');
    assert.equal(lastSuccessfulRun(state, 'agent-1')?.id, 'run-1');
    assert.equal(recentRuns(state, 'agent-1', 1).length, 1);
    assert.equal(allRuns(state).length, 2);
    assert.equal(lastRun(state, 'unknown-agent'), undefined);
  });

  it('forgets the history of a deleted agent', () => {
    const state = stateWith([run('run-1', '2026-08-17T06:00:00.000Z')]);
    removeAgentHistory(state, 'agent-1');
    assert.deepEqual(state.history, {});
  });

  it('records runs through the store with the current limit', async () => {
    const store = new RoundsStore({
      backend: new MementoBackend(new FakeMemento()),
      timeZone: 'UTC',
    });
    let limit = 2;
    const history = new HistoryService(store, () => limit);

    await history.record(run('run-1', '2026-08-17T06:00:00.000Z'));
    await history.record(run('run-2', '2026-08-17T07:00:00.000Z'));
    await history.record(run('run-3', '2026-08-17T08:00:00.000Z'));
    assert.deepEqual((await history.recent('agent-1')).map((record) => record.id), [
      'run-3',
      'run-2',
    ]);

    // A settings change takes effect on the next write, without a restart.
    limit = 1;
    await history.record(run('run-4', '2026-08-17T09:00:00.000Z'));
    assert.deepEqual((await history.recent('agent-1')).map((record) => record.id), ['run-4']);

    await history.forgetAgent('agent-1');
    assert.deepEqual(await history.recent('agent-1'), []);
  });
});
