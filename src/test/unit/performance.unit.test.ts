import * as assert from 'node:assert/strict';

import type { AgentRunner } from '../../agents/runner.js';
import { Ticker } from '../../scheduler/ticker.js';
import { upsertRun } from '../../state/history.js';
import { Logger, MemorySink } from '../../state/logger.js';
import { SETTING_DEFAULTS } from '../../state/settings.js';
import { RoundsStore } from '../../state/store.js';
import type { StateBackend } from '../../state/store.js';
import { FixedClock } from '../../state/time.js';
import type { Agent, PersistedState, RunRecord } from '../../state/types.js';
import { emptyState } from '../../state/validate.js';

const NOW = new Date('2026-08-17T09:00:30.000Z');

/** A backend that counts what it was asked to do. */
class CountingBackend implements StateBackend {
  loads = 0;
  saves = 0;
  peeks = 0;
  private stored: PersistedState;

  constructor(state: PersistedState) {
    this.stored = state;
  }

  load(): Promise<unknown> {
    this.loads += 1;
    return Promise.resolve(structuredClone(this.stored));
  }

  save(state: PersistedState): Promise<void> {
    this.saves += 1;
    this.stored = structuredClone(state);
    return Promise.resolve();
  }

  peekRevision(): Promise<number> {
    this.peeks += 1;
    return Promise.resolve(this.stored.revision);
  }
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Morning triage',
    enabled: true,
    executionMode: 'api',
    schedule: { cronExpressions: ['0 9 * * *'], runOnStartup: false, missedRunPolicy: 'skip' },
    source: { kind: 'jira', baseUrlRef: 'tracker', jql: 'project = ROUNDS', maxResults: 20 },
    prompt: { source: 'inline', inlineText: 'Summarize {{items}}' },
    modelId: 'model-a',
    tools: [],
    nextRunAt: '2026-08-18T09:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function run(id: string, startedAt: string): RunRecord {
  return {
    id,
    agentId: 'agent-1',
    startedAt,
    status: 'succeeded',
    trigger: 'schedule',
    summary: 'done',
    modelId: 'model-a',
    executionMode: 'api',
    toolCalls: [],
    sourceItemCount: 0,
    promptResolution: { source: 'inline', usedSnapshot: false },
  };
}

/**
 * The cheap-when-idle properties.
 *
 * A scheduler that ticks every thirty seconds for the whole time an editor is open has to cost
 * nothing when there is nothing to do. These are the measurements that say so, rather than a claim
 * in a document that nobody re-checks.
 */
describe('resource cost', () => {
  it('reads the state once and answers from the cache afterwards', async () => {
    const backend = new CountingBackend(emptyState('2026-08-17'));
    const store = new RoundsStore({ backend, timeZone: 'UTC' });

    await store.read();
    await store.read();
    await store.read();

    assert.equal(backend.loads, 1, 'repeated reads do not go back to the backend');
  });

  it('writes nothing while no agent is due', async () => {
    const state = emptyState('2026-08-17');
    state.agents = [agent()];
    const backend = new CountingBackend(state);
    const clock = new FixedClock(NOW);
    const store = new RoundsStore({ backend, clock, timeZone: 'UTC' });
    await store.read();

    const ticker = new Ticker({
      store,
      runner: { run: () => Promise.reject(new Error('nothing should run')) } as unknown as AgentRunner,
      settings: () => ({ ...SETTING_DEFAULTS, timezone: 'UTC' }),
      logger: new Logger({ sink: new MemorySink(), getLevel: () => 'none', clock }),
      clock,
    });
    ticker.start();

    const savesBefore = backend.saves;
    for (let index = 0; index < 20; index += 1) {
      await ticker.tick();
    }

    assert.equal(backend.saves, savesBefore, 'twenty idle passes rewrote nothing');
    ticker.stop();
  });

  it('does not re-read the state file on every idle pass', async () => {
    const state = emptyState('2026-08-17');
    state.agents = [agent()];
    const backend = new CountingBackend(state);
    const clock = new FixedClock(NOW);
    const store = new RoundsStore({ backend, clock, timeZone: 'UTC' });
    await store.read();

    const ticker = new Ticker({
      store,
      runner: { run: () => Promise.reject(new Error('nothing should run')) } as unknown as AgentRunner,
      settings: () => ({ ...SETTING_DEFAULTS, timezone: 'UTC' }),
      logger: new Logger({ sink: new MemorySink(), getLevel: () => 'none', clock }),
      clock,
    });
    ticker.start();

    const loadsBefore = backend.loads;
    for (let index = 0; index < 20; index += 1) {
      await ticker.tick();
    }

    // The cached state answers every pass; a follower window's file watcher is what invalidates it.
    assert.equal(backend.loads, loadsBefore, 'idle passes are served from the cache');
    ticker.stop();
  });

  it('keeps the history bounded however many runs happen', () => {
    const state = emptyState('2026-08-17');
    for (let index = 0; index < 500; index += 1) {
      upsertRun(state, run(`run-${index}`, `2026-08-17T${String(index % 24).padStart(2, '0')}:00:00.000Z`), 50);
    }

    assert.equal(state.history['agent-1']?.length, 50, 'the cap holds under five hundred runs');
  });

  it('keeps the log bounded by its level rather than by hope', () => {
    const sink = new MemorySink();
    const logger = new Logger({ sink, getLevel: () => 'error' });

    for (let index = 0; index < 1000; index += 1) {
      logger.debug(`tick ${index}`);
      logger.info(`tick ${index}`);
    }

    assert.equal(sink.lines.length, 0, 'a quiet level writes nothing at all');
  });
});
