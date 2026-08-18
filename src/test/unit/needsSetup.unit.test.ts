import * as assert from 'node:assert/strict';

import { evaluateReadiness } from '../../setup/needsSetup.js';
import type { ReadinessInput } from '../../setup/needsSetup.js';
import type { Agent } from '../../state/types.js';

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

function input(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    agent: agent(),
    hasConsent: true,
    models: [{ id: 'model-a', name: 'Model A', vendor: 'vendor', family: 'family' }],
    endpoints: {
      tracker: { name: 'tracker', kind: 'jira', baseUrl: 'https://tracker.invalid', authScheme: 'bearer' },
    },
    storedSecrets: ['jiraToken'],
    ...overrides,
  };
}

describe('agent readiness', () => {
  it('is ready when everything is in place', () => {
    assert.deepEqual(evaluateReadiness(input()), { ready: true, problems: [] });
  });

  it('is not ready before consent was granted', () => {
    const readiness = evaluateReadiness(input({ hasConsent: false }));
    assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.problems, ['noConsent']);
    assert.match(readiness.reason ?? '', /has not been granted/);
  });

  it('reports a model that is no longer in the list', () => {
    const readiness = evaluateReadiness(
      input({ models: [{ id: 'model-b', name: 'Model B', vendor: 'v', family: 'f' }] }),
    );
    assert.deepEqual(readiness.problems, ['unknownModel']);
  });

  it('does not claim the model is gone when the list was never fetched', () => {
    // An empty cache means "unknown", not "missing"; the consent problem covers that case.
    const readiness = evaluateReadiness(input({ hasConsent: false, models: [] }));
    assert.deepEqual(readiness.problems, ['noConsent']);
  });

  it('reports a source connection that does not exist', () => {
    const readiness = evaluateReadiness(input({ endpoints: {} }));
    assert.deepEqual(readiness.problems, ['missingEndpoint']);
  });

  it('reports a connection configured for the wrong kind of source', () => {
    const readiness = evaluateReadiness(
      input({
        endpoints: {
          tracker: { name: 'tracker', kind: 'git', baseUrl: 'https://git.invalid', authScheme: 'bearer' },
        },
      }),
    );
    assert.deepEqual(readiness.problems, ['missingEndpoint']);
  });

  it('reports a missing token for the source kind the agent uses', () => {
    const readiness = evaluateReadiness(input({ storedSecrets: ['gitToken'] }));
    assert.deepEqual(readiness.problems, ['missingToken']);
  });

  it('accepts the git token for a git agent', () => {
    const readiness = evaluateReadiness(
      input({
        agent: agent({
          source: { kind: 'git', baseUrlRef: 'repos', project: 'owner', repo: 'repo', mode: 'newPullRequests' },
        }),
        endpoints: {
          repos: { name: 'repos', kind: 'git', baseUrl: 'https://git.invalid', authScheme: 'bearer' },
        },
        storedSecrets: ['gitToken'],
      }),
    );
    assert.equal(readiness.ready, true);
  });

  it('reports an unwritable result folder', () => {
    const readiness = evaluateReadiness(input({ outputFolderWritable: false }));
    assert.deepEqual(readiness.problems, ['outputFolderUnwritable']);
  });

  it('marks an agent that would run commands in an untrusted workspace', () => {
    // Said now, while somebody is looking at the view, rather than at 09:00 in a log nobody reads.
    const readiness = evaluateReadiness(
      input({ agent: agent({ tools: ['runScript'] }), workspaceTrusted: false }),
    );

    assert.deepEqual(readiness.problems, ['untrustedWorkspace']);
    assert.match(readiness.reason ?? '', /not trusted/);
  });

  it('leaves an agent without runScript alone in an untrusted workspace', () => {
    const readiness = evaluateReadiness(
      input({ agent: agent({ tools: ['readFile'] }), workspaceTrusted: false }),
    );
    assert.equal(readiness.ready, true);
  });

  it('lists several problems in one readable sentence', () => {
    const readiness = evaluateReadiness(
      input({ hasConsent: false, endpoints: {}, storedSecrets: [] }),
    );
    assert.deepEqual(readiness.problems, ['noConsent', 'missingEndpoint', 'missingToken']);
    assert.match(readiness.reason ?? '', /granted, .* and no token is stored/);
  });
});
