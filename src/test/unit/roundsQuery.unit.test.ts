import * as assert from 'node:assert/strict';

import { QUERY_KINDS, runQuery } from '../../chat/roundsQuery.js';
import type { QueryContext } from '../../chat/roundsQuery.js';
import type { Agent, PersistedState, RunRecord } from '../../state/types.js';
import { emptyState } from '../../state/validate.js';

const NOW = new Date('2026-08-18T08:00:00.000Z');

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Morning triage',
    enabled: true,
    executionMode: 'api',
    schedule: {
      cronExpressions: ['0 9 * * *'],
      runOnStartup: false,
      missedRunPolicy: 'skip',
      timezone: 'UTC',
    },
    source: { kind: 'jira', baseUrlRef: 'tracker', jql: 'project = ROUNDS', maxResults: 20 },
    prompt: { source: 'inline', inlineText: 'Summarize {{items}}' },
    modelId: 'model-a',
    tools: ['readFile'],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    agentId: 'agent-1',
    startedAt: '2026-08-17T09:00:00.000Z',
    finishedAt: '2026-08-17T09:00:08.000Z',
    status: 'succeeded',
    trigger: 'schedule',
    summary: 'Two issues need attention.',
    modelId: 'model-a',
    executionMode: 'api',
    toolCalls: [],
    sourceItemCount: 12,
    promptResolution: { source: 'inline', usedSnapshot: false },
    ...overrides,
  };
}

function context(overrides: Partial<QueryContext> = {}): QueryContext {
  const state: PersistedState = {
    ...emptyState('2026-08-18'),
    agents: [agent()],
    history: { 'agent-1': [run(), run({ id: 'run-2' }), run({ id: 'run-3' })] },
    endpoints: {
      tracker: {
        name: 'tracker',
        kind: 'jira',
        baseUrl: 'https://tracker.invalid',
        authScheme: 'basic',
        username: 'alex@example.invalid',
      },
    },
    setup: { models: [{ id: 'model-a', name: 'Model A', vendor: 'vendor', family: 'family' }] },
  };
  return { state, now: NOW, timeZone: 'UTC', ...overrides };
}

describe('rounds_query', () => {
  it('answers every kind it declares', () => {
    for (const kind of QUERY_KINDS) {
      const input: Record<string, unknown> = { kind };
      if (kind === 'get' || kind === 'history') {
        input.id = 'agent-1';
      }
      if (kind === 'preview_cron') {
        input.cronExpression = '0 9 * * *';
      }
      assert.equal(runQuery(input, context()).ok, true, `kind=${kind} must answer`);
    }
  });

  it('says outright that an agent has no source', () => {
    // A model that finds no `source` key cannot tell "there is none" from "not included here",
    // and answers that are true is the whole point of this tool.
    const promptOnly = context({
      state: { ...context().state, agents: [agent({ source: undefined })] },
    });

    const result = runQuery({ kind: 'get', id: 'agent-1' }, promptOnly);
    const source = (result as unknown as { agent: { source: { kind: string; note?: string } } }).agent
      .source;

    assert.equal(source.kind, 'none');
    assert.match(source.note ?? '', /runs as written/);
  });

  it('rejects an unknown kind by listing the ones that exist', () => {
    const result = runQuery({ kind: 'delete_everything' }, context());

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /list, get, history/);
  });

  it('rejects a field the kind does not take, by name', () => {
    // Silence would cost the model a turn to work out; naming the field and the alternatives
    // costs it nothing.
    const result = runQuery({ kind: 'list', cronExpression: '0 9 * * *' }, context());

    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /cronExpression/);
    assert.match(result.ok === false ? result.message : '', /Allowed: kind, enabledOnly/);
  });

  it('leaves prompt bodies out of a list, under a key nobody can write back', () => {
    const long = 'x'.repeat(400);
    const result = runQuery({ kind: 'list' }, context({
      state: { ...context().state, agents: [agent({ prompt: { source: 'inline', inlineText: long } })] },
    }));

    assert.equal(result.ok, true);
    const listed = (result as unknown as { agents: Record<string, unknown>[] }).agents[0];
    assert.equal(listed?.promptLength, 400);
    assert.ok(String(listed?.promptPreview).endsWith('…'));
    assert.equal(listed?.prompt, undefined);
    assert.match(String((result as unknown as { hint: string }).hint), /never write a promptPreview back/);
  });

  it('returns the whole prompt only when asked for one agent', () => {
    const result = runQuery({ kind: 'get', id: 'agent-1' }, context());

    assert.equal(result.ok, true);
    const found = (result as unknown as { agent: { prompt: { text: string } } }).agent;
    assert.equal(found.prompt.text, 'Summarize {{items}}');
  });

  it('finds an agent by name as well as by id, and says so when it cannot', () => {
    assert.equal(runQuery({ kind: 'get', id: 'Morning triage' }, context()).ok, true);

    const missing = runQuery({ kind: 'get', id: 'nope' }, context());
    assert.equal(missing.ok, false);
    assert.match(missing.ok === false ? missing.message : '', /Known agents: Morning triage \(agent-1\)/);
  });

  it('reports how much history there is, not only what it returned', () => {
    const result = runQuery({ kind: 'history', id: 'agent-1', limit: 2 }, context());

    assert.equal(result.ok, true);
    const payload = result as unknown as { total: number; count: number; hasMore: boolean };
    assert.equal(payload.total, 3);
    assert.equal(payload.count, 2);
    assert.equal(payload.hasMore, true);
  });

  it('previews a cron expression in the zone it was given', () => {
    const result = runQuery(
      { kind: 'preview_cron', cronExpression: '0 9 * * *', count: 2, timeZone: 'UTC' },
      context(),
    );

    assert.equal(result.ok, true);
    assert.deepEqual((result as unknown as { nextRuns: string[] }).nextRuns, [
      '2026-08-18T09:00:00.000Z',
      '2026-08-19T09:00:00.000Z',
    ]);
  });

  it('explains a cron expression that does not parse instead of returning nothing', () => {
    const result = runQuery({ kind: 'preview_cron', cronExpression: 'every so often' }, context());
    assert.equal(result.ok, false);
  });

  it('lists the models an agent may name, and the connections it may point at', () => {
    const models = runQuery({ kind: 'list_models' }, context());
    assert.deepEqual((models as unknown as { models: { id: string }[] }).models.map((model) => model.id), [
      'model-a',
    ]);

    const sources = runQuery({ kind: 'list_sources' }, context());
    const listed = (sources as unknown as { sources: Record<string, unknown>[] }).sources[0];
    assert.equal(listed?.baseUrl, 'https://tracker.invalid');
    assert.equal(listed?.token, undefined);
  });

  it('cannot leak a token, even one planted in the state', () => {
    // The same redaction the logger uses, on the same class of output leaving the process.
    const secret = 'super-secret-token-value';
    const planted = context({
      state: {
        ...context().state,
        agents: [agent({ prompt: { source: 'inline', inlineText: `use ${secret} to log in` } })],
      },
      secrets: [secret],
    });

    const result = runQuery({ kind: 'get', id: 'agent-1' }, planted);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.match(JSON.stringify(result), /\*\*\*/);
  });

  it('refuses input that is not an object at all', () => {
    assert.equal(runQuery('list', context()).ok, false);
    assert.equal(runQuery(null, context()).ok, false);
    assert.equal(runQuery([{ kind: 'list' }], context()).ok, false);
  });

  it('skips disabled agents when asked to', () => {
    const both = context({
      state: {
        ...context().state,
        agents: [agent(), agent({ id: 'agent-2', name: 'Paused', enabled: false })],
      },
    });

    assert.equal((runQuery({ kind: 'list' }, both) as unknown as { count: number }).count, 2);
    assert.equal(
      (runQuery({ kind: 'list', enabledOnly: true }, both) as unknown as { count: number }).count,
      1,
    );
  });
});
