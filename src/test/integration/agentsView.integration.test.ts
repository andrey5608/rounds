import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import {
  AgentsTreeDataProvider,
  describeAgent,
  describeDuration,
  describeRelative,
  describeRun,
  presentAgent,
} from '../../ui/agentsView.js';
import type { AgentsViewData } from '../../ui/agentsView.js';
import { renderRunDetails, runDocumentUri } from '../../ui/runDetails.js';
import { statusFor } from '../../ui/viewState.js';
import type { Agent, RunRecord } from '../../state/types.js';
import { emptyState } from '../../state/validate.js';

const NOW = new Date('2026-08-17T06:00:00.000Z');

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
    nextRunAt: '2026-08-17T09:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    agentId: 'agent-1',
    startedAt: '2026-08-17T05:00:00.000Z',
    finishedAt: '2026-08-17T05:00:10.000Z',
    status: 'succeeded',
    trigger: 'schedule',
    summary: 'Two issues need attention.',
    modelId: 'model-a',
    executionMode: 'api',
    toolCalls: [],
    sourceItemCount: 2,
    resultFilePath: '/results/morning-triage-20260817-050000.md',
    promptResolution: { source: 'inline', usedSnapshot: false },
    ...overrides,
  };
}

function data(options: { agents: Agent[]; runs?: Record<string, RunRecord[]>; running?: string[] }): AgentsViewData {
  const state = emptyState('2026-08-17');
  state.agents = options.agents;
  state.history = options.runs ?? {};
  state.endpoints = {
    tracker: { name: 'tracker', kind: 'jira', baseUrl: 'https://tracker.invalid', authScheme: 'bearer' },
  };
  state.setup.consentGrantedAt = '2026-08-01T00:00:00.000Z';
  state.setup.models = [{ id: 'model-a', name: 'Model A', vendor: 'v', family: 'f' }];
  return {
    state,
    storedSecrets: ['jiraToken'],
    settingsTimeZone: 'UTC',
    minimumIntervalWarning: 30,
    running: new Set(options.running ?? []),
  };
}

describe('agents view', () => {
  it('lists agents sorted by name, with their runs underneath', () => {
    const provider = new AgentsTreeDataProvider();
    provider.setClock(() => NOW);
    provider.setData(
      data({
        agents: [agent({ id: 'b', name: 'Zebra' }), agent({ id: 'a', name: 'Alpha' })],
        runs: { a: [run({ agentId: 'a' })] },
      }),
    );

    const roots = provider.getChildren();
    assert.deepEqual(
      roots.map((node) => (node.kind === 'agent' ? node.agent.name : '')),
      ['Alpha', 'Zebra'],
    );

    const children = provider.getChildren(roots[0]);
    assert.equal(children[0]?.kind, 'run');
  });

  it('shows a placeholder under an agent that has never run', () => {
    const provider = new AgentsTreeDataProvider();
    provider.setData(data({ agents: [agent()] }));

    const [placeholder] = provider.getChildren(provider.getChildren()[0]);
    assert.ok(placeholder, 'the agent has a child node');
    assert.equal(placeholder.kind, 'message');
    assert.equal(provider.getTreeItem(placeholder).label, 'No runs yet');
  });

  it('describes the schedule and the next run in one line', () => {
    const line = describeAgent(agent(), data({ agents: [agent()] }), NOW);
    assert.match(line, /09:00/);
    assert.match(line, /next in 3 h/);
  });

  it('says an agent is disabled instead of guessing a next run', () => {
    const disabled = agent({ enabled: false });
    assert.match(describeAgent(disabled, data({ agents: [disabled] }), NOW), /disabled$/);
  });

  it('says an agent is running while it runs', () => {
    assert.match(
      describeAgent(agent(), data({ agents: [agent()], running: ['agent-1'] }), NOW),
      /running now$/,
    );
  });

  it('turns a timestamp into readable relative time', () => {
    assert.equal(describeRelative(new Date('2026-08-17T06:00:30.000Z'), NOW), 'in a moment');
    assert.equal(describeRelative(new Date('2026-08-17T06:30:00.000Z'), NOW), 'in 30 min');
    assert.equal(describeRelative(new Date('2026-08-17T09:00:00.000Z'), NOW), 'in 3 h');
    assert.equal(describeRelative(new Date('2026-08-19T06:00:00.000Z'), NOW), 'in 2 d');
    assert.equal(describeRelative(new Date('2026-08-17T05:00:00.000Z'), NOW), 'overdue');
  });

  it('shows three upcoming runs in the tooltip, not one', () => {
    // One timestamp tells you when. Three tell you whether the time zone is the one you meant,
    // which is the mistake that otherwise surfaces a day later.
    const scheduled = agent({
      schedule: {
        cronExpressions: ['0 9 * * *'],
        runOnStartup: false,
        missedRunPolicy: 'skip',
        timezone: 'UTC',
      },
    });
    const presentation = presentAgent(scheduled, data({ agents: [scheduled] }), NOW);

    assert.match(presentation.tooltip.value, /Next runs:/);
    assert.equal(presentation.tooltip.value.match(/2026/g)?.length, 3);
  });

  it('says what a run cost, not only how it ended', () => {
    assert.equal(
      describeRun(run({ sourceItemCount: 12, finishedAt: '2026-08-17T05:00:08.400Z' })),
      '12 items · 8.4 s — Two issues need attention.',
    );
    assert.equal(
      describeRun(run({ sourceItemCount: 1, finishedAt: '2026-08-17T05:00:00.250Z' })),
      '1 item · 250 ms — Two issues need attention.',
    );
  });

  it('leads a failed run with the code somebody searches the log for', () => {
    const failed = run({
      status: 'failed',
      sourceItemCount: 0,
      finishedAt: '2026-08-17T05:01:30.000Z',
      summary: 'the host refused the token',
      error: { code: 'connector.auth', message: 'the host refused the token' },
    });
    assert.equal(describeRun(failed), '1 min 30 s — connector.auth: the host refused the token');
  });

  it('says nothing about the duration of a run that never reported back', () => {
    assert.equal(describeDuration(run({ finishedAt: undefined })), undefined);
    assert.match(describeRun(run({ finishedAt: undefined, sourceItemCount: 3 })), /^3 items — /);
  });

  it('uses context values the menus can key on', () => {
    const enabled = presentAgent(agent(), data({ agents: [agent()] }), NOW);
    assert.equal(enabled.contextValue, 'rounds.agent.enabled');

    const disabled = agent({ enabled: false });
    assert.equal(
      presentAgent(disabled, data({ agents: [disabled] }), NOW).contextValue,
      'rounds.agent.disabled',
    );

    const unknownModel = agent({ modelId: 'model-that-left' });
    assert.equal(
      presentAgent(unknownModel, data({ agents: [unknownModel] }), NOW).contextValue,
      'rounds.agent.needsSetup',
    );
  });

  it('matches the context values the manifest menus expect', () => {
    const extension = vscode.extensions.all.find(
      (candidate) => (candidate.packageJSON as { name?: string }).name === 'rounds',
    );
    assert.ok(extension);
    const menus = (
      extension.packageJSON as {
        contributes: { menus: { 'view/item/context': { when: string }[] } };
      }
    ).contributes.menus['view/item/context'];

    // Every agent-scoped menu entry keys on a value the tree actually produces.
    const produced = ['rounds.agent.enabled', 'rounds.agent.disabled', 'rounds.agent.needsSetup'];
    for (const entry of menus) {
      const pattern = /viewItem =~ \/\^(?<prefix>[^/]+)\//.exec(entry.when);
      assert.ok(pattern, `menu entry has no viewItem test: ${entry.when}`);
      const prefix = (pattern.groups?.prefix ?? '').replace(/\\/g, '');
      assert.ok(
        produced.some((value) => value.startsWith(prefix)),
        `no tree item produces a context value starting with ${prefix}`,
      );
    }
  });

  it('warns about an agent that runs far too often', () => {
    const frequent = agent({
      schedule: { cronExpressions: ['*/5 * * * *'], runOnStartup: false, missedRunPolicy: 'skip' },
    });
    const presentation = presentAgent(frequent, data({ agents: [frequent] }), NOW);
    assert.match(presentation.tooltip.value, /every 5 minute/);
  });

  it('points a run with a result file at that file', () => {
    assert.equal(runDocumentUri(run()).scheme, 'file');
  });

  it('points a run without a result file at a detail document', () => {
    const uri = runDocumentUri(run({ status: 'handedOff', resultFilePath: undefined }));
    assert.equal(uri.scheme, 'rounds');
    assert.match(uri.path, /agent-1\/run-1\.md$/);
  });

  it('explains in the detail document that chat mode captures nothing', () => {
    const text = renderRunDetails(
      run({ status: 'handedOff', executionMode: 'chat', resultFilePath: undefined }),
      'Morning triage',
    );
    assert.match(text, /# Morning triage/);
    assert.match(text, /No output was captured/);
    assert.match(text, /never sees the answer/);
  });

  it('reports an error in the detail document', () => {
    const text = renderRunDetails(
      run({ status: 'failed', error: { code: 'model.quotaExceeded', message: 'slow down' }, resultFilePath: undefined }),
      'Morning triage',
    );
    assert.match(text, /## Error/);
    assert.match(text, /model\.quotaExceeded/);
    assert.match(text, /slow down/);
  });
});

describe('status bar state', () => {
  it('reports a running agent first of all', () => {
    assert.deepEqual(statusFor(data({ agents: [agent()], running: ['agent-1'] }), true), {
      kind: 'running',
      agentName: 'Morning triage',
    });
  });

  it('reports the master switch when scheduling is off', () => {
    assert.deepEqual(statusFor(data({ agents: [agent()] }), false), { kind: 'disabled' });
  });

  it('reports an agent that cannot run', () => {
    const broken = agent({ modelId: 'model-that-left' });
    assert.deepEqual(statusFor(data({ agents: [broken] }), true), { kind: 'needsSetup' });
  });

  it('reports the last failure', () => {
    const state = data({ agents: [agent()], runs: { 'agent-1': [run({ status: 'failed' })] } });
    assert.deepEqual(statusFor(state, true), { kind: 'failed', agentName: 'Morning triage' });
  });

  it('otherwise reports the earliest next run', () => {
    const soon = agent({ id: 'soon', name: 'Soon', nextRunAt: '2026-08-17T07:00:00.000Z' });
    const later = agent({ id: 'later', name: 'Later', nextRunAt: '2026-08-17T09:00:00.000Z' });
    const status = statusFor(data({ agents: [later, soon] }), true);

    assert.equal(status.kind, 'idle');
    assert.equal(
      status.kind === 'idle' ? status.nextRunAt?.toISOString() : undefined,
      '2026-08-17T07:00:00.000Z',
    );
  });
});
