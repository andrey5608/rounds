import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ResultWriter } from '../../agents/resultWriter.js';
import { AgentRunner } from '../../agents/runner.js';
import type { ConnectorProvider, RunnerDependencies } from '../../agents/runner.js';
import type { FetchResult } from '../../connectors/items.js';
import type { LanguageModelGateway, ModelInfo, ModelRequest, ModelTurn } from '../../model/gateway.js';
import { RunClaims } from '../../scheduler/runClaims.js';
import { ModelCatalog } from '../../setup/modelCatalog.js';
import { CountersService } from '../../state/counters.js';
import { FileStateBackend } from '../../state/fileStore.js';
import { HistoryService } from '../../state/history.js';
import { Logger, MemorySink } from '../../state/logger.js';
import { SETTING_DEFAULTS } from '../../state/settings.js';
import type { RoundsSettings } from '../../state/settings.js';
import { RoundsStore } from '../../state/store.js';
import { FixedClock } from '../../state/time.js';
import type { Agent, RunRecord } from '../../state/types.js';
import { createToolRegistry } from '../../tools/index.js';
import type { RoundsTool } from '../../tools/registry.js';

const NOW = new Date('2026-08-17T09:00:00.000Z');

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

const jiraItems: FetchResult = {
  items: [
    {
      id: 'ROUNDS-1',
      title: 'Scheduler skips a run',
      url: 'https://tracker.invalid/browse/ROUNDS-1',
      updatedAt: '2026-08-17T08:00:00.000Z',
      extra: {},
    },
    {
      id: 'ROUNDS-2',
      title: 'Leader lock heartbeat',
      url: 'https://tracker.invalid/browse/ROUNDS-2',
      updatedAt: '2026-08-16T08:00:00.000Z',
      extra: {},
    },
  ],
  truncated: false,
};

class FakeGateway implements LanguageModelGateway {
  readonly requests: ModelRequest[] = [];
  models: ModelInfo[] = [{ id: 'model-a', name: 'Model A', vendor: 'v', family: 'f' }];
  turns: (ModelTurn | Error)[] = [{ text: 'Two issues need attention.', toolCalls: [] }];

  selectModels(): Promise<ModelInfo[]> {
    return Promise.resolve(this.models);
  }

  sendRequest(request: ModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const turn = this.turns[Math.min(this.requests.length - 1, this.turns.length - 1)];
    return turn instanceof Error ? Promise.reject(turn) : Promise.resolve(turn ?? { text: '', toolCalls: [] });
  }
}

interface Harness {
  runner: AgentRunner;
  store: RoundsStore;
  gateway: FakeGateway;
  sink: MemorySink;
  resultsFolder: string;
  handedOff: { prompt: string; modelId?: string }[];
  history: HistoryService;
}

async function harness(options: {
  agent: Agent;
  settings?: Partial<RoundsSettings>;
  fetch?: () => Promise<FetchResult>;
  diff?: () => Promise<{ text: string; truncated: boolean }>;
  consent?: boolean;
  secrets?: ('jiraToken' | 'gitToken')[];
  gateway?: FakeGateway;
  resultWriter?: ResultWriter;
  /** Tools another extension would report. */
  externalTools?: RoundsTool<unknown>[];
}): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), 'rounds-runner-'));
  const resultsFolder = join(directory, 'results');
  const clock = new FixedClock(NOW);
  const store = new RoundsStore({ backend: new FileStateBackend({ directory }), clock, timeZone: 'UTC' });

  await store.update((draft) => {
    draft.agents = [options.agent];
    draft.endpoints = {
      tracker: { name: 'tracker', kind: 'jira', baseUrl: 'https://tracker.invalid', authScheme: 'bearer' },
      repos: { name: 'repos', kind: 'git', baseUrl: 'https://git.invalid', authScheme: 'bearer' },
    };
    if (options.consent !== false) {
      draft.setup.consentGrantedAt = '2026-08-01T00:00:00.000Z';
      draft.setup.models = [{ id: 'model-a', name: 'Model A', vendor: 'v', family: 'f' }];
    }
  });

  const settings: RoundsSettings = { ...SETTING_DEFAULTS, timezone: 'UTC', ...options.settings };
  const sink = new MemorySink();
  const logger = new Logger({ sink, getLevel: () => 'debug', clock });
  const gateway = options.gateway ?? new FakeGateway();
  const handedOff: { prompt: string; modelId?: string }[] = [];

  const connectors: ConnectorProvider = {
    forSource: (source) =>
      Promise.resolve(
        source.kind === 'jira'
          ? {
              tracker: {
                ping: () => Promise.resolve(),
                search: options.fetch ?? (() => Promise.resolve(jiraItems)),
                getIssue: () => Promise.reject(new Error('not used')),
                listProjects: () => Promise.reject(new Error('not used during a run')),
              },
            }
          : {
              repositoryHost: {
                ping: () => Promise.resolve(),
                listPullRequests: options.fetch ?? (() => Promise.resolve(jiraItems)),
                getDiff: options.diff ?? (() => Promise.resolve({ text: 'diff --git a/f b/f', truncated: false })),
                // The pickers only; a run never lists projects or repositories.
                listProjects: () => Promise.reject(new Error('not used during a run')),
                listRepositories: () => Promise.reject(new Error('not used during a run')),
              },
            },
      ),
  };

  const dependencies: RunnerDependencies = {
    store,
    history: new HistoryService(store, () => settings.executionHistoryLimit),
    counters: new CountersService({
      store,
      clock,
      getGlobalLimit: () => settings.maxExecutionsPerDay,
      getTimeZone: () => settings.timezone,
    }),
    claims: new RunClaims({ store, windowId: 'window-a', clock }),
    models: new ModelCatalog({ gateway, store, clock }),
    gateway,
    registry: createToolRegistry(),
    externalTools: () => options.externalTools ?? [],
    connectors,
    resultWriter: options.resultWriter,
    settings: () => settings,
    globalStorage: directory,
    workspaceFolders: [directory],
    workspaceName: 'rounds',
    logger,
    clock,
    handOffToChat: (prompt, options) => {
      handedOff.push({ prompt, modelId: options.modelId });
      return Promise.resolve();
    },
    secretNames: () => Promise.resolve(options.secrets ?? ['jiraToken', 'gitToken']),
  };

  return {
    runner: new AgentRunner(dependencies),
    store,
    gateway,
    sink,
    resultsFolder,
    handedOff,
    history: dependencies.history,
  };
}

async function lastRun(store: RoundsStore, agentId: string): Promise<RunRecord | undefined> {
  const state = await store.reload();
  return state.history[agentId]?.[0];
}

describe('agent runner', () => {
  afterEach(async () => {
    await rm(join(tmpdir(), 'rounds-runner-probe'), { recursive: true, force: true });
  });

  it('runs an agent end to end and writes a result file', async () => {
    const { runner, store, gateway } = await harness({ agent: agent() });

    const record = await runner.run({ agent: agent(), trigger: 'manual' });

    assert.equal(record.status, 'succeeded');
    assert.equal(record.summary, 'Two issues need attention.');
    assert.equal(record.sourceItemCount, 2);
    assert.ok(record.resultFilePath, 'a result file was written');

    const content = await readFile(record.resultFilePath ?? '', 'utf8');
    assert.match(content, /^---\n/);
    assert.match(content, /status: succeeded/);
    assert.match(content, /sourceItems: \[ROUNDS-1, ROUNDS-2\]/);
    assert.match(content, /Two issues need attention\./);

    // The rendered prompt carried the item list.
    assert.match(gateway.requests[0]?.messages[0]?.text ?? '', /ROUNDS-1/);

    const stored = await lastRun(store, 'agent-1');
    assert.equal(stored?.status, 'succeeded');
    assert.equal((await store.reload()).counters.global, 1);
    assert.equal((await store.reload()).agents[0]?.lastRunAt, NOW.toISOString());
  });

  it('releases the claim when the run is over', async () => {
    const { runner, store } = await harness({ agent: agent() });
    await runner.run({ agent: agent(), trigger: 'manual' });
    assert.deepEqual((await store.reload()).runClaims, {});
  });

  it('skips a run when consent was never granted', async () => {
    const { runner, store } = await harness({ agent: agent(), consent: false });

    const record = await runner.run({ agent: agent(), trigger: 'schedule' });

    assert.equal(record.status, 'skipped');
    assert.match(record.summary, /has not been granted/);
    assert.equal((await store.reload()).counters.global, 0, 'a skipped run costs no quota');
  });

  it('skips a run when the source token is missing', async () => {
    const { runner } = await harness({ agent: agent(), secrets: ['gitToken'] });
    const record = await runner.run({ agent: agent(), trigger: 'schedule' });

    assert.equal(record.status, 'skipped');
    assert.match(record.summary, /no token is stored/);
  });

  it('skips a run once the daily limit is reached', async () => {
    const { runner, store } = await harness({ agent: agent(), settings: { maxExecutionsPerDay: 1 } });
    await runner.run({ agent: agent(), trigger: 'manual' });

    const second = await runner.run({ agent: agent(), trigger: 'schedule' });
    assert.equal(second.status, 'skipped');
    assert.match(second.summary, /already run 1 time\(s\) today/);
    assert.equal((await store.reload()).counters.global, 1);
  });

  it('skips when another window holds the claim', async () => {
    const { runner, store } = await harness({ agent: agent() });
    await store.update((draft) => {
      draft.runClaims['agent-1'] = {
        windowId: 'window-other',
        runId: 'run-other',
        startedAt: NOW.toISOString(),
        heartbeatAt: NOW.toISOString(),
      };
    });

    const record = await runner.run({ agent: agent(), trigger: 'manual' });
    assert.equal(record.status, 'skipped');
    assert.match(record.summary, /Another window is already running this agent/);
  });

  it('fails with the valid model ids when the model is gone', async () => {
    const gateway = new FakeGateway();
    gateway.models = [{ id: 'model-b', name: 'Model B', vendor: 'v', family: 'f' }];
    const { runner } = await harness({ agent: agent(), gateway });

    const record = await runner.run({ agent: agent(), trigger: 'manual' });

    assert.equal(record.status, 'failed');
    assert.equal(record.error?.code, 'model.unavailable');
    assert.match(record.summary, /pick a model from the current list|not available/);
  });

  it('records a failed run when the source refuses', async () => {
    const { runner } = await harness({
      agent: agent(),
      fetch: () => Promise.reject(new Error('401 rejected the stored token')),
    });

    const record = await runner.run({ agent: agent(), trigger: 'schedule' });
    assert.equal(record.status, 'failed');
    assert.match(record.summary, /401 rejected the stored token/);
  });

  it('records a failed run when the prompt file is unusable', async () => {
    const fileAgent = agent({
      prompt: { source: 'file', filePath: '/nowhere/prompt.md', fallback: 'blockAlways' },
    });
    const { runner } = await harness({ agent: fileAgent });

    const record = await runner.run({ agent: fileAgent, trigger: 'schedule' });
    assert.equal(record.status, 'failed');
    assert.equal(record.error?.code, 'prompt.unavailable');
    assert.match(record.summary, /prompt file .* could not be read/);
  });

  it('skips when the source has nothing to work on', async () => {
    const { runner } = await harness({
      agent: agent({ prompt: { source: 'inline', inlineText: 'Look at {{issueKey}}' } }),
      fetch: () => Promise.resolve({ items: [], truncated: false }),
    });

    const record = await runner.run({
      agent: agent({ prompt: { source: 'inline', inlineText: 'Look at {{issueKey}}' } }),
      trigger: 'schedule',
    });
    assert.equal(record.status, 'skipped');
    assert.match(record.summary, /nothing to work on/);
  });

  it('renders a per-item prompt once per item and sections the result', async () => {
    const perItem = agent({ prompt: { source: 'inline', inlineText: 'Summarize {{issueKey}}: {{summary}}' } });
    const gateway = new FakeGateway();
    gateway.turns = [{ text: 'First answer.', toolCalls: [] }, { text: 'Second answer.', toolCalls: [] }];
    const { runner } = await harness({ agent: perItem, gateway });

    const record = await runner.run({ agent: perItem, trigger: 'manual' });

    assert.equal(gateway.requests.length, 2, 'one request per item');
    assert.match(gateway.requests[0]?.messages[0]?.text ?? '', /ROUNDS-1/);
    assert.match(gateway.requests[1]?.messages[0]?.text ?? '', /ROUNDS-2/);

    const content = await readFile(record.resultFilePath ?? '', 'utf8');
    assert.match(content, /## ROUNDS-1 Scheduler skips a run/);
    assert.match(content, /## ROUNDS-2 Leader lock heartbeat/);
  });

  it('runs an agent that has no source at all', async () => {
    // The point of the phase: a prompt on a schedule, in an installation that may have no
    // connection configured anywhere.
    const promptOnly = agent({
      source: undefined,
      prompt: { source: 'inline', inlineText: 'Report what changed in {{workspace}}.' },
    });
    const { runner, gateway, store } = await harness({ agent: promptOnly });

    const record = await runner.run({ agent: promptOnly, trigger: 'manual' });

    assert.equal(record.status, 'succeeded');
    assert.equal(record.sourceItemCount, 0);
    assert.equal(gateway.requests.length, 1, 'one rendering, as written');
    assert.equal((await store.reload()).counters.global, 1);
  });

  it('does not call the connector for an agent with no source', async () => {
    const promptOnly = agent({
      source: undefined,
      prompt: { source: 'inline', inlineText: 'Report what changed.' },
    });
    const { runner } = await harness({
      agent: promptOnly,
      fetch: () => Promise.reject(new Error('a run with no source must not fetch')),
    });

    const record = await runner.run({ agent: promptOnly, trigger: 'manual' });
    assert.equal(record.status, 'succeeded');
  });

  it('does not call an empty result a skip when there was nothing to fetch', async () => {
    // "The source returned nothing to work on" would be a lie about why nothing happened.
    const promptOnly = agent({
      source: undefined,
      prompt: { source: 'inline', inlineText: 'Report what changed.' },
    });
    const { runner } = await harness({ agent: promptOnly });

    const record = await runner.run({ agent: promptOnly, trigger: 'manual' });
    assert.notEqual(record.status, 'skipped');
  });

  it('fails a run whose tool no extension provides any more', async () => {
    // The rule the specification already applies to a model that is gone: fail and name it. A
    // tool quietly dropped from the request changes what the agent does without saying so.
    const withTool = agent({ tools: ['research'] });
    const { runner } = await harness({ agent: withTool });

    const record = await runner.run({ agent: withTool, trigger: 'manual' });

    assert.equal(record.status, 'failed');
    assert.equal(record.error?.code, 'tool.missing');
    assert.match(record.summary, /research/);
  });

  it('offers a tool another extension registered to the model', async () => {
    const withTool = agent({ tools: ['research'] });
    const { runner, gateway } = await harness({
      agent: withTool,
      externalTools: [
        {
          name: 'research',
          description: 'Looks something up',
          inputSchema: { type: 'object' },
          parseInput: (raw: unknown) => raw,
          checkPermission: () => ({ allowed: true }) as const,
          execute: () => Promise.resolve({ content: 'found it', truncated: false }),
        },
      ],
    });

    await runner.run({ agent: withTool, trigger: 'manual' });

    assert.deepEqual(gateway.requests[0]?.tools.map((tool) => tool.name), ['research']);
  });

  it('hands a chat-mode agent to the chat view and records the limitation', async () => {
    const chatAgent = agent({ executionMode: 'chat' });
    const { runner, handedOff, gateway, store } = await harness({ agent: chatAgent });

    const record = await runner.run({ agent: chatAgent, trigger: 'manual' });

    assert.equal(record.status, 'handedOff');
    assert.equal(record.resultFilePath, undefined);
    assert.match(record.summary, /does not see the answer/);
    assert.equal(handedOff.length, 1);
    assert.match(handedOff[0]?.prompt ?? '', /ROUNDS-1/);
    // The agent is pinned to a model; the chat should not open with whatever was used last.
    assert.equal(handedOff[0]?.modelId, chatAgent.modelId);
    assert.match(record.summary, /requested/);
    assert.equal(gateway.requests.length, 0, 'chat mode never calls the model directly');
    assert.equal((await store.reload()).counters.global, 1, 'a handoff still counts');
  });

  it('advances a repository cursor only after a success', async () => {
    const gitAgent = agent({
      source: { kind: 'git', baseUrlRef: 'repos', project: 'octo', repo: 'rounds', mode: 'updatedPullRequests' },
    });
    const { runner, store } = await harness({
      agent: gitAgent,
      fetch: () => Promise.resolve({ ...jiraItems, cursor: '2026-08-17T08:00:00.000Z' }),
    });

    await runner.run({ agent: gitAgent, trigger: 'manual' });
    const stored = (await store.reload()).agents[0];
    assert.equal(
      stored?.source?.kind === 'git' ? stored.source.sinceCursor : undefined,
      '2026-08-17T08:00:00.000Z',
    );
  });

  it('leaves the cursor alone when the run failed', async () => {
    const gitAgent = agent({
      source: { kind: 'git', baseUrlRef: 'repos', project: 'octo', repo: 'rounds', mode: 'updatedPullRequests' },
    });
    const gateway = new FakeGateway();
    gateway.turns = [new Error('quota exceeded')];
    const { runner, store } = await harness({ agent: gitAgent, gateway });

    const record = await runner.run({ agent: gitAgent, trigger: 'schedule' });
    assert.equal(record.status, 'failed');
    const stored = (await store.reload()).agents[0];
    assert.equal(stored?.source?.kind === 'git' ? stored.source.sinceCursor : 'unset', undefined);
  });

  it('records the tool calls a run made', async () => {
    const gateway = new FakeGateway();
    gateway.turns = [
      { text: '', toolCalls: [{ callId: 'call-1', name: 'listFiles', input: { globPattern: '**/*.md' } }] },
      { text: 'Nothing unusual.', toolCalls: [] },
    ];
    const toolAgent = agent({ tools: ['listFiles'] });
    const { runner } = await harness({ agent: toolAgent, gateway });

    const record = await runner.run({ agent: toolAgent, trigger: 'manual' });

    assert.equal(record.toolCalls.length, 1);
    assert.equal(record.toolCalls[0]?.name, 'listFiles');
    assert.equal(record.status, 'succeeded');
  });

  it('never throws, whatever the stage does', async () => {
    for (const failure of [
      { fetch: () => Promise.reject(new Error('source exploded')) },
      { gateway: (() => {
          const gateway = new FakeGateway();
          gateway.turns = [new Error('model exploded')];
          return gateway;
        })() },
    ]) {
      const { runner } = await harness({ agent: agent(), ...failure });
      const record = await runner.run({ agent: agent(), trigger: 'schedule' });
      assert.equal(record.status, 'failed');
      assert.ok(record.summary.length > 0);
      assert.ok(record.finishedAt);
    }
  });

  it('reports a run in the history even when the result file cannot be written', async () => {
    // The failure is injected rather than provoked with an unwritable path: which paths refuse a
    // write differs per platform, and a test that depends on that is a test that fails somewhere
    // else for reasons of its own.
    const failingWriter = new ResultWriter({
      mkdirImpl: () => Promise.reject(new Error('read-only file system')),
    });
    const { runner, store } = await harness({ agent: agent(), resultWriter: failingWriter });

    const record = await runner.run({ agent: agent(), trigger: 'manual' });

    assert.equal(record.status, 'succeeded');
    assert.equal(record.resultFilePath, undefined);
    assert.equal((await lastRun(store, 'agent-1'))?.status, 'succeeded');
  });
});
