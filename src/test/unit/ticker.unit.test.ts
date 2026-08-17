import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentRunner, RunRequest } from '../../agents/runner.js';
import { STARTUP_BURST_LIMIT, Ticker } from '../../scheduler/ticker.js';
import { FileStateBackend } from '../../state/fileStore.js';
import { Logger, MemorySink } from '../../state/logger.js';
import { SETTING_DEFAULTS } from '../../state/settings.js';
import type { RoundsSettings } from '../../state/settings.js';
import { RoundsStore } from '../../state/store.js';
import { FixedClock } from '../../state/time.js';
import type { Agent, RunRecord } from '../../state/types.js';

const NOW = new Date('2026-08-17T09:00:30.000Z');

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
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function record(agentId: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: `run-${agentId}`,
    agentId,
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    status: 'succeeded',
    trigger: 'schedule',
    summary: 'done',
    modelId: 'model-a',
    executionMode: 'api',
    toolCalls: [],
    sourceItemCount: 0,
    promptResolution: { source: 'inline', usedSnapshot: false },
    ...overrides,
  };
}

interface Harness {
  ticker: Ticker;
  store: RoundsStore;
  runs: RunRequest[];
  clock: FixedClock;
  capMessages: string[];
  frequencyWarnings: { agent: string; interval: number }[];
  sink: MemorySink;
  cleanup: () => Promise<void>;
}

async function harness(options: {
  agents: Agent[];
  settings?: Partial<RoundsSettings>;
  result?: (request: RunRequest) => RunRecord;
  random?: () => number;
}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'rounds-ticker-'));
  const clock = new FixedClock(NOW);
  const store = new RoundsStore({ backend: new FileStateBackend({ directory }), clock, timeZone: 'UTC' });
  await store.update((draft) => {
    draft.agents = options.agents;
  });

  const settings: RoundsSettings = { ...SETTING_DEFAULTS, timezone: 'UTC', ...options.settings };
  const runs: RunRequest[] = [];
  const capMessages: string[] = [];
  const frequencyWarnings: { agent: string; interval: number }[] = [];
  const sink = new MemorySink();

  const runner = {
    run: (request: RunRequest) => {
      runs.push(request);
      return Promise.resolve(options.result?.(request) ?? record(request.agent.id));
    },
  } as unknown as AgentRunner;

  const ticker = new Ticker({
    store,
    runner,
    settings: () => settings,
    logger: new Logger({ sink, getLevel: () => 'debug', clock }),
    clock,
    random: options.random ?? (() => 0),
    // Jitter is measured, not waited out.
    sleep: () => Promise.resolve(),
    onCapReached: (message) => capMessages.push(message),
    onFrequencyWarning: (candidate, interval) =>
      frequencyWarnings.push({ agent: candidate.name, interval }),
  });

  return {
    ticker,
    store,
    runs,
    clock,
    capMessages,
    frequencyWarnings,
    sink,
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

describe('scheduler ticker', () => {
  it('runs an agent whose time has come and moves its schedule on', async () => {
    const { ticker, store, runs, cleanup } = await harness({
      agents: [agent({ nextRunAt: '2026-08-17T09:00:00.000Z' })],
    });
    ticker.start();

    const records = await ticker.tick();

    assert.equal(records.length, 1);
    assert.equal(runs[0]?.trigger, 'schedule');
    assert.equal((await store.reload()).agents[0]?.nextRunAt, '2026-08-18T09:00:00.000Z');
    ticker.stop();
    await cleanup();
  });

  it('leaves an agent alone before its time', async () => {
    const { ticker, runs, cleanup } = await harness({
      agents: [agent({ nextRunAt: '2026-08-17T18:00:00.000Z' })],
    });
    ticker.start();

    assert.deepEqual(await ticker.tick(), []);
    assert.equal(runs.length, 0);
    ticker.stop();
    await cleanup();
  });

  it('does nothing at all while scheduling is switched off', async () => {
    const { ticker, runs, cleanup } = await harness({
      agents: [agent({ nextRunAt: '2026-08-17T09:00:00.000Z' })],
      settings: { enabled: false },
    });
    ticker.start();

    assert.deepEqual(await ticker.tick(), []);
    assert.equal(runs.length, 0);
    ticker.stop();
    await cleanup();
  });

  it('skips a due agent that is outside its window and reschedules it', async () => {
    const { ticker, store, runs, cleanup } = await harness({
      agents: [
        agent({
          nextRunAt: '2026-08-17T09:00:00.000Z',
          allowedTimeStart: '22:00',
          allowedTimeEnd: '06:00',
        }),
      ],
    });
    ticker.start();

    await ticker.tick();

    assert.equal(runs.length, 0);
    assert.equal((await store.reload()).agents[0]?.nextRunAt, '2026-08-18T09:00:00.000Z');
    ticker.stop();
    await cleanup();
  });

  it('applies jitter to a scheduled run and records it', async () => {
    const { ticker, runs, cleanup } = await harness({
      agents: [agent({ nextRunAt: '2026-08-17T09:00:00.000Z' })],
      settings: { jitterSeconds: 600 },
      random: () => 0.5,
    });
    ticker.start();

    await ticker.tick();
    assert.equal(runs[0]?.jitterSeconds, 300);
    ticker.stop();
    await cleanup();
  });

  it('runs due agents one after another rather than in parallel', async () => {
    const order: string[] = [];
    const { ticker, cleanup } = await harness({
      agents: [
        agent({ id: 'agent-1', name: 'First', nextRunAt: '2026-08-17T09:00:00.000Z' }),
        agent({ id: 'agent-2', name: 'Second', nextRunAt: '2026-08-17T09:00:00.000Z' }),
      ],
      result: (request) => {
        order.push(request.agent.id);
        return record(request.agent.id);
      },
    });
    ticker.start();

    await ticker.tick();
    assert.deepEqual(order, ['agent-1', 'agent-2']);
    ticker.stop();
    await cleanup();
  });

  it('never starts a second pass while one is still working', async () => {
    const { ticker, runs, cleanup } = await harness({
      agents: [agent({ nextRunAt: '2026-08-17T09:00:00.000Z' })],
    });
    ticker.start();

    await Promise.all([ticker.tick(), ticker.tick(), ticker.tick()]);
    assert.equal(runs.length, 1, 'overlapping passes are skipped, not queued');
    ticker.stop();
    await cleanup();
  });

  it('stops ticking when told to', async () => {
    const { ticker, runs, cleanup } = await harness({
      agents: [agent({ nextRunAt: '2026-08-17T09:00:00.000Z' })],
    });
    ticker.start();
    assert.equal(ticker.isRunning, true);

    ticker.stop();
    assert.equal(ticker.isRunning, false);
    assert.deepEqual(await ticker.tick(), []);
    assert.equal(runs.length, 0);
    await cleanup();
  });

  it('survives a pass that throws', async () => {
    const { ticker, sink, cleanup } = await harness({
      agents: [agent({ nextRunAt: '2026-08-17T09:00:00.000Z' })],
      result: () => {
        throw new Error('runner exploded');
      },
    });
    ticker.start();

    assert.deepEqual(await ticker.tick(), []);
    assert.ok(sink.lines.some((line) => line.includes('scheduling pass failed')));
    // The next pass still happens.
    assert.equal(ticker.isRunning, true);
    ticker.stop();
    await cleanup();
  });

  it('tells the user once when the daily limit blocked a run', async () => {
    const { ticker, capMessages, cleanup } = await harness({
      agents: [
        agent({ id: 'agent-1', nextRunAt: '2026-08-17T09:00:00.000Z' }),
        agent({ id: 'agent-2', nextRunAt: '2026-08-17T09:00:00.000Z' }),
      ],
      result: (request) =>
        record(request.agent.id, {
          status: 'skipped',
          summary: 'Rounds has already run 24 time(s) today, which is the limit in the settings.',
        }),
    });
    ticker.start();

    await ticker.tick();
    assert.equal(capMessages.length, 1, 'one notification, not one per agent');
    assert.match(capMessages[0] ?? '', /daily run limit/);
    ticker.stop();
    await cleanup();
  });

  it('warns about an agent that runs more often than the threshold', async () => {
    const { ticker, frequencyWarnings, cleanup } = await harness({
      agents: [
        agent({
          schedule: { cronExpressions: ['*/5 * * * *'], runOnStartup: false, missedRunPolicy: 'skip' },
        }),
      ],
    });

    await ticker.catchUp();
    assert.deepEqual(frequencyWarnings, [{ agent: 'Morning triage', interval: 5 }]);
    await cleanup();
  });

  it('fills in a missing next run on catch-up', async () => {
    const { ticker, store, cleanup } = await harness({ agents: [agent()] });

    await ticker.catchUp();
    assert.equal((await store.reload()).agents[0]?.nextRunAt, '2026-08-18T09:00:00.000Z');
    await cleanup();
  });

  it('runs a missed occurrence once under the runOnce policy', async () => {
    const { ticker, runs, store, cleanup } = await harness({
      agents: [
        agent({
          nextRunAt: '2026-08-15T09:00:00.000Z',
          schedule: { cronExpressions: ['0 9 * * *'], runOnStartup: false, missedRunPolicy: 'runOnce' },
        }),
      ],
    });
    ticker.start();

    await ticker.catchUp();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.trigger, 'missedRun');
    assert.equal((await store.reload()).agents[0]?.nextRunAt, '2026-08-18T09:00:00.000Z');
    ticker.stop();
    await cleanup();
  });

  it('only reschedules a missed occurrence under the skip policy', async () => {
    const { ticker, runs, store, cleanup } = await harness({
      agents: [agent({ nextRunAt: '2026-08-15T09:00:00.000Z' })],
    });
    ticker.start();

    await ticker.catchUp();
    assert.equal(runs.length, 0);
    assert.equal((await store.reload()).agents[0]?.nextRunAt, '2026-08-18T09:00:00.000Z');
    ticker.stop();
    await cleanup();
  });

  it('runs an agent that asked to run on startup', async () => {
    const { ticker, runs, cleanup } = await harness({
      agents: [
        agent({
          nextRunAt: '2026-08-18T09:00:00.000Z',
          schedule: { cronExpressions: ['0 9 * * *'], runOnStartup: true, missedRunPolicy: 'skip' },
        }),
      ],
    });
    ticker.start();

    await ticker.catchUp();
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.trigger, 'startup');
    ticker.stop();
    await cleanup();
  });

  it('limits how many agents may fire right after taking over', async () => {
    const agents = Array.from({ length: 6 }, (_, index) =>
      agent({
        id: `agent-${index}`,
        name: `Agent ${index}`,
        nextRunAt: '2026-08-15T09:00:00.000Z',
        schedule: { cronExpressions: ['0 9 * * *'], runOnStartup: false, missedRunPolicy: 'runOnce' },
      }),
    );
    const { ticker, runs, clock, store, cleanup } = await harness({ agents });
    ticker.start();

    await ticker.catchUp();
    assert.equal(runs.length, STARTUP_BURST_LIMIT, 'a morning burst is spread out');

    // The agents that were held back keep their normal schedule rather than running late, so a
    // second pass inside the window changes nothing.
    await ticker.tick();
    assert.equal(runs.length, STARTUP_BURST_LIMIT);

    // Once the start-up window has passed, an agent that becomes due runs as usual.
    clock.advance(6 * 60 * 1000);
    await store.update((draft) => {
      const first = draft.agents[0];
      if (first) {
        first.nextRunAt = '2026-08-17T09:00:00.000Z';
      }
    });
    await ticker.tick();
    assert.equal(runs.length, STARTUP_BURST_LIMIT + 1, 'the burst guard no longer applies');
    ticker.stop();
    await cleanup();
  });

  it('recomputes every next run, for example after the time zone changed', async () => {
    const { ticker, store, cleanup } = await harness({
      agents: [agent({ nextRunAt: '2026-08-18T09:00:00.000Z' }), agent({ id: 'agent-2', enabled: false })],
    });

    await ticker.recomputeAll();
    const state = await store.reload();
    assert.equal(state.agents[0]?.nextRunAt, '2026-08-18T09:00:00.000Z');
    assert.equal(state.agents[1]?.nextRunAt, undefined, 'a disabled agent has no next run');
    await cleanup();
  });
});
