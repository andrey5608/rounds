import * as assert from 'node:assert/strict';

import type { Agent } from '../../state/types.js';
import {
  CURRENT_SCHEMA_VERSION,
  emptyState,
  migrate,
  normalizeState,
  validateAgent,
} from '../../state/validate.js';

const LOCAL_DATE = '2026-08-17';

function validAgent(overrides: Partial<Agent> = {}): unknown {
  const agent: Agent = {
    id: 'agent-1',
    name: 'Morning triage',
    enabled: true,
    executionMode: 'api',
    schedule: {
      cronExpressions: ['0 9 * * *'],
      runOnStartup: false,
      missedRunPolicy: 'skip',
    },
    source: { kind: 'jira', baseUrlRef: 'tracker', jql: 'assignee = currentUser()', maxResults: 20 },
    prompt: { source: 'inline', inlineText: 'Summarize {{items}}' },
    modelId: 'some-model',
    tools: ['readFile'],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
  return agent;
}

describe('state validation', () => {
  it('accepts a well formed agent', () => {
    const result = validateAgent(validAgent());
    assert.notEqual(typeof result, 'string');
  });

  it('rejects an agent whose schedule has no expression', () => {
    const result = validateAgent(
      validAgent({ schedule: { cronExpressions: [], runOnStartup: false, missedRunPolicy: 'skip' } }),
    );
    assert.equal(typeof result, 'string');
  });

  it('rejects a file prompt without a path', () => {
    const result = validateAgent(validAgent({ prompt: { source: 'file' } }));
    assert.equal(result, 'prompt.filePath must be a non-empty string for file prompts');
  });

  it('rejects an unknown source kind', () => {
    const result = validateAgent(
      validAgent({ source: { kind: 'ftp', baseUrlRef: 'x' } as never }),
    );
    assert.equal(result, 'source.kind must be jira or git');
  });

  it('quarantines malformed agents instead of failing the whole state', () => {
    const outcome = normalizeState(
      {
        schemaVersion: 1,
        revision: 7,
        agents: [validAgent(), { id: 'broken' }],
        history: {},
        counters: { localDate: LOCAL_DATE, global: 0, perAgent: {} },
      },
      LOCAL_DATE,
    );
    assert.equal(outcome.state.agents.length, 1);
    assert.equal(outcome.state.revision, 7);
    assert.equal(outcome.quarantine.length, 1);
    assert.equal(outcome.quarantine[0]?.kind, 'agent');
  });

  it('quarantines malformed run records but keeps the good ones', () => {
    const outcome = normalizeState(
      {
        schemaVersion: 1,
        revision: 1,
        agents: [],
        history: {
          'agent-1': [
            {
              id: 'run-1',
              agentId: 'agent-1',
              startedAt: '2026-08-17T06:00:00.000Z',
              status: 'succeeded',
              trigger: 'schedule',
            },
            { id: 'run-2' },
          ],
        },
        counters: { localDate: LOCAL_DATE, global: 1, perAgent: { 'agent-1': 1 } },
      },
      LOCAL_DATE,
    );
    assert.equal(outcome.state.history['agent-1']?.length, 1);
    assert.equal(outcome.quarantine.length, 1);
    assert.equal(outcome.quarantine[0]?.kind, 'run');
  });

  it('falls back to an empty state when the stored value is not an object', () => {
    const outcome = normalizeState('not a state', LOCAL_DATE);
    assert.deepEqual(outcome.state, emptyState(LOCAL_DATE));
    assert.equal(outcome.quarantine[0]?.kind, 'envelope');
  });

  it('treats a first run with no stored state as empty and clean', () => {
    const outcome = normalizeState(undefined, LOCAL_DATE);
    assert.deepEqual(outcome.state, emptyState(LOCAL_DATE));
    assert.equal(outcome.quarantine.length, 0);
  });

  it('keeps the provider a connection was configured with, and only a known one', () => {
    // Which connector runs is this field. A value that survives a reload as something else would
    // silently send every request to paths the host has never heard of.
    const stored = (provider: unknown): unknown => ({
      schemaVersion: 1,
      revision: 1,
      agents: [],
      history: {},
      counters: { localDate: LOCAL_DATE, global: 0, perAgent: {} },
      endpoints: {
        repos: { name: 'repos', kind: 'git', baseUrl: 'https://bitbucket.example.invalid', authScheme: 'bearer', provider },
      },
    });

    for (const provider of ['github', 'bitbucketCloud', 'bitbucketServer']) {
      assert.equal(
        normalizeState(stored(provider), LOCAL_DATE).state.endpoints.repos?.provider,
        provider,
      );
    }
    assert.equal(
      normalizeState(stored('gitlab'), LOCAL_DATE).state.endpoints.repos?.provider,
      undefined,
    );
  });

  it('splits a version 1 repository string into a project and a repository', () => {
    const migrated = migrate({
      schemaVersion: 1,
      revision: 3,
      agents: [
        {
          ...(validAgent() as Record<string, unknown>),
          source: { kind: 'git', baseUrlRef: 'repos', repo: 'octo/rounds', mode: 'newPullRequests' },
        },
      ],
    }) as { schemaVersion: number; agents: { source: Record<string, unknown> }[] };

    assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(migrated.agents[0]?.source.project, 'octo');
    assert.equal(migrated.agents[0]?.source.repo, 'rounds');
  });

  it('leaves a value it cannot split alone, so the agent is quarantined with a reason', () => {
    // That value was never usable — the connectors rejected it at run time — and guessing at it
    // here would turn a visible problem into a silent one.
    const migrated = migrate({
      schemaVersion: 1,
      revision: 1,
      agents: [
        {
          ...(validAgent() as Record<string, unknown>),
          source: { kind: 'git', baseUrlRef: 'repos', repo: 'rounds', mode: 'newPullRequests' },
        },
      ],
    }) as { agents: { source: Record<string, unknown> }[] };

    assert.equal(migrated.agents[0]?.source.project, undefined);

    const outcome = normalizeState({ ...migrated, schemaVersion: CURRENT_SCHEMA_VERSION }, LOCAL_DATE);
    assert.equal(outcome.state.agents.length, 0);
    assert.match(outcome.quarantine[0]?.reason ?? '', /source\.project/);
  });

  it('leaves an agent that already has the pair untouched', () => {
    const source = { kind: 'git', baseUrlRef: 'repos', project: 'octo', repo: 'rounds', mode: 'newPullRequests' };
    const migrated = migrate({
      schemaVersion: 1,
      revision: 1,
      agents: [{ ...(validAgent() as Record<string, unknown>), source }],
    }) as { agents: { source: Record<string, unknown> }[] };

    assert.deepEqual(migrated.agents[0]?.source, source);
  });

  it('stamps the current schema version on migrated envelopes', () => {
    const migrated = migrate({ schemaVersion: 1, revision: 0 }) as { schemaVersion: number };
    assert.equal(migrated.schemaVersion, CURRENT_SCHEMA_VERSION);
  });
});
