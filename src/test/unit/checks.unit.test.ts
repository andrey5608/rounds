import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SETUP_CHECKS, runSetupChecks, worstStatus } from '../../setup/checks.js';
import type { SetupCheckContext } from '../../setup/checks.js';
import { probeOutputFolder, resolveOutputFolder } from '../../setup/outputFolder.js';
import { SETTING_DEFAULTS } from '../../state/settings.js';
import type { Agent, CheckOutcome, EndpointConfig } from '../../state/types.js';

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

function endpoint(overrides: Partial<EndpointConfig> = {}): EndpointConfig {
  return {
    name: 'tracker',
    kind: 'jira',
    baseUrl: 'https://tracker.invalid',
    authScheme: 'bearer',
    ...overrides,
  };
}

function context(overrides: Partial<SetupCheckContext> = {}): SetupCheckContext {
  return {
    settings: { ...SETTING_DEFAULTS },
    agents: [],
    endpoints: {},
    hasConsent: true,
    models: [{ id: 'model-a', name: 'Model A', vendor: 'vendor', family: 'family' }],
    hasSecret: () => Promise.resolve(true),
    probeOutputFolder: () =>
      Promise.resolve({ ok: true, path: '/tmp/results', message: 'Results are written to /tmp/results.' }),
    ...overrides,
  };
}

function byId(results: CheckOutcome[], id: string): CheckOutcome {
  const found = results.find((result) => result.id === id);
  assert.ok(found, `no result for check ${id}`);
  return found;
}

describe('setup checks', () => {
  it('runs the six checks in a fixed order', async () => {
    const results = await runSetupChecks(context());
    assert.deepEqual(
      results.map((result) => result.id),
      ['models', 'jira', 'git', 'outputFolder', 'scriptWhitelist', 'rateLimits'],
    );
    assert.equal(SETUP_CHECKS.length, 6);
  });

  it('fails the model check before the editor has been asked', async () => {
    const results = await runSetupChecks(context({ hasConsent: false, models: [] }));
    const models = byId(results, 'models');
    assert.equal(models.status, 'fail');
    assert.match(models.message, /has not asked the editor/);
    // The wording must not send somebody to install a provider they already have.
    assert.ok(!/install/i.test(models.message) || /must be installed/.test(models.message));
  });

  it('blames a starting provider, not a missing one, when the list is empty', async () => {
    const results = await runSetupChecks(context({ models: [] }));
    const models = byId(results, 'models');
    assert.equal(models.status, 'fail');
    assert.match(models.message, /still be initialising/);
  });

  it('only warns about an unconfigured source nobody uses', async () => {
    const results = await runSetupChecks(context());
    assert.equal(byId(results, 'jira').status, 'warn');
    assert.equal(byId(results, 'git').status, 'warn');
  });

  it('fails when an agent uses a source that has no base URL', async () => {
    const results = await runSetupChecks(context({ agents: [agent()] }));
    const jira = byId(results, 'jira');
    assert.equal(jira.status, 'fail');
    assert.match(jira.message, /no base URL is configured/);
  });

  it('fails when a base URL has no stored token', async () => {
    const results = await runSetupChecks(
      context({
        endpoints: { tracker: endpoint() },
        hasSecret: () => Promise.resolve(false),
      }),
    );
    const jira = byId(results, 'jira');
    assert.equal(jira.status, 'fail');
    assert.match(jira.message, /no token is stored/);
  });

  it('warns when reachability cannot be verified', async () => {
    const results = await runSetupChecks(context({ endpoints: { tracker: endpoint() } }));
    const jira = byId(results, 'jira');
    assert.equal(jira.status, 'warn');
    assert.match(jira.message, /not verified/);
  });

  it('passes when every configured base URL answers', async () => {
    const results = await runSetupChecks(
      context({
        endpoints: { tracker: endpoint(), repos: endpoint({ name: 'repos', kind: 'git' }) },
        pingEndpoint: () => Promise.resolve({ ok: true, message: 'ok' }),
      }),
    );
    assert.equal(byId(results, 'jira').status, 'pass');
    assert.equal(byId(results, 'git').status, 'pass');
  });

  it('reports which base URL could not be reached', async () => {
    const results = await runSetupChecks(
      context({
        endpoints: { tracker: endpoint() },
        pingEndpoint: (target) =>
          Promise.resolve({ ok: false, message: `no answer from ${target.baseUrl}` }),
      }),
    );
    const jira = byId(results, 'jira');
    assert.equal(jira.status, 'fail');
    assert.match(jira.message, /tracker: no answer from https:\/\/tracker.invalid/);
  });

  it('fails when the result folder cannot be written to', async () => {
    const results = await runSetupChecks(
      context({
        probeOutputFolder: () =>
          Promise.resolve({ ok: false, path: '/nope', message: 'The result folder /nope cannot be written to' }),
      }),
    );
    assert.equal(byId(results, 'outputFolder').status, 'fail');
  });

  it('warns about an empty script whitelist without failing setup', async () => {
    const results = await runSetupChecks(context());
    const whitelist = byId(results, 'scriptWhitelist');
    assert.equal(whitelist.status, 'warn');
    assert.match(whitelist.message, /refuses every command/);
  });

  it('passes the whitelist check once commands are listed', async () => {
    const results = await runSetupChecks(
      context({
        settings: { ...SETTING_DEFAULTS, scriptWhitelist: [{ command: 'npm', args: ['test'] }] },
      }),
    );
    assert.equal(byId(results, 'scriptWhitelist').status, 'pass');
  });

  it('warns when jitter is switched off', async () => {
    const results = await runSetupChecks(
      context({ settings: { ...SETTING_DEFAULTS, jitterSeconds: 0 } }),
    );
    const rateLimits = byId(results, 'rateLimits');
    assert.equal(rateLimits.status, 'warn');
    assert.match(rateLimits.message, /Jitter is switched off/);
  });

  it('warns about an enabled agent that runs too often', async () => {
    const results = await runSetupChecks(
      context({
        agents: [agent({ schedule: { cronExpressions: ['*/5 * * * *'], runOnStartup: false, missedRunPolicy: 'skip' } })],
        endpoints: { tracker: endpoint() },
        minIntervalMinutes: () => 5,
      }),
    );
    const rateLimits = byId(results, 'rateLimits');
    assert.equal(rateLimits.status, 'warn');
    assert.match(rateLimits.message, /more often than the 30 minute warning threshold/);
  });

  it('ignores a disabled agent when warning about frequency', async () => {
    const results = await runSetupChecks(
      context({
        agents: [agent({ enabled: false })],
        endpoints: { tracker: endpoint() },
        minIntervalMinutes: () => 1,
      }),
    );
    assert.equal(byId(results, 'rateLimits').status, 'pass');
  });

  it('turns a throwing check into a failure instead of losing every result', async () => {
    const results = await runSetupChecks(
      context({
        probeOutputFolder: () => {
          throw new Error('disk exploded');
        },
      }),
    );
    assert.equal(results.length, 6);
    const folder = byId(results, 'outputFolder');
    assert.equal(folder.status, 'fail');
    assert.match(folder.message, /disk exploded/);
  });

  it('summarises the worst status', () => {
    const pass: CheckOutcome = { id: 'a', title: 'A', status: 'pass', message: '' };
    const warn: CheckOutcome = { id: 'b', title: 'B', status: 'warn', message: '' };
    const fail: CheckOutcome = { id: 'c', title: 'C', status: 'fail', message: '' };

    assert.equal(worstStatus([pass, pass]), 'pass');
    assert.equal(worstStatus([pass, warn]), 'warn');
    assert.equal(worstStatus([warn, fail]), 'fail');
    assert.equal(worstStatus([]), 'pass');
  });
});

describe('output folder', () => {
  it('prefers the agent folder, then the setting, then global storage', () => {
    assert.equal(
      resolveOutputFolder({ agentFolder: '/a', settingFolder: '/b', globalStorage: '/c' }),
      '/a',
    );
    assert.equal(resolveOutputFolder({ settingFolder: '/b', globalStorage: '/c' }), '/b');
    assert.equal(resolveOutputFolder({ globalStorage: '/c' }), join('/c', 'results'));
  });

  it('creates the folder it probes and leaves no probe file behind', async () => {
    const base = await mkdtemp(join(tmpdir(), 'rounds-folder-'));
    const target = join(base, 'nested', 'results');

    const probe = await probeOutputFolder(target);
    assert.equal(probe.ok, true);
    assert.match(probe.message, /Results are written to/);

    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(target), []);
    await rm(base, { recursive: true, force: true });
  });

  it('reports a folder it cannot write to', async () => {
    // A path whose parent is a file cannot become a directory.
    const base = await mkdtemp(join(tmpdir(), 'rounds-folder-'));
    const { writeFile } = await import('node:fs/promises');
    const blocker = join(base, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');

    const probe = await probeOutputFolder(join(blocker, 'results'));
    assert.equal(probe.ok, false);
    assert.match(probe.message, /cannot be written to/);
    await rm(base, { recursive: true, force: true });
  });
});
