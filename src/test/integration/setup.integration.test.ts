import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

import { runSetupChecks, worstStatus } from '../../setup/checks.js';
import { probeOutputFolder, resolveOutputFolder } from '../../setup/outputFolder.js';
import { readSettings } from '../../state/settings.js';

/**
 * Runs the setup checks against the real editor: real configuration values, a real folder
 * probe, a real secret storage answer. The command's quick pick cannot be driven from a
 * test, so what is verified here is everything up to the point where the user picks an item.
 */
describe('setup checks inside the extension host', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rounds-setup-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('reads its settings from the live configuration', () => {
    const settings = readSettings(vscode.workspace.getConfiguration());
    assert.equal(settings.jitterSeconds, 600);
    assert.equal(settings.maxExecutionsPerDay, 24);
    assert.deepEqual(settings.scriptWhitelist, []);
  });

  it('reports a fresh profile as needing model access, and says why for each check', async () => {
    const results = await runSetupChecks({
      settings: readSettings(vscode.workspace.getConfiguration()),
      agents: [],
      endpoints: {},
      hasConsent: false,
      models: [],
      hasSecret: () => Promise.resolve(false),
      probeOutputFolder: () =>
        probeOutputFolder(resolveOutputFolder({ globalStorage: directory })),
    });

    assert.deepEqual(
      results.map((result) => `${result.id}:${result.status}`),
      [
        'models:fail',
        'jira:warn',
        'git:warn',
        'outputFolder:pass',
        'scriptWhitelist:warn',
        'rateLimits:pass',
      ],
    );
    assert.equal(worstStatus(results), 'fail');
    for (const result of results) {
      assert.ok(result.message.length > 0, `${result.id} has no message`);
    }
  });

  it('creates the result folder it reports as usable', async () => {
    const target = resolveOutputFolder({ globalStorage: directory });
    const probe = await probeOutputFolder(target);

    assert.equal(probe.ok, true);
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(target));
    assert.equal(stat.type, vscode.FileType.Directory);
  });
});

/**
 * Activation cost, measured rather than asserted from a design argument.
 *
 * The number is reported so a regression is visible in the CI log; the assertion is a generous
 * tripwire, because a shared runner's timing is not a benchmark and a tight bound would only produce
 * flaky failures.
 */
describe('activation cost', () => {
  it('activates promptly', async () => {
    const extension = vscode.extensions.all.find(
      (candidate) => (candidate.packageJSON as { name?: string }).name === 'rounds',
    );
    assert.ok(extension, 'the extension under test is not loaded');

    const started = Date.now();
    await extension.activate();
    const elapsed = Date.now() - started;

    // eslint-disable-next-line no-console
    console.log(`activation took ${elapsed} ms`);
    assert.ok(elapsed < 5000, `activation took ${elapsed} ms`);
  });
});
