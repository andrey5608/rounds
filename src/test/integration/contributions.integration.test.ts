import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

import { COMMAND_IDS } from '../../ui/commands.js';

interface ManifestShape {
  contributes: {
    commands: { command: string }[];
    views: Record<string, { id: string }[]>;
  };
}

function findExtension(): vscode.Extension<unknown> {
  const extension = vscode.extensions.all.find(
    (candidate) => (candidate.packageJSON as { name?: string }).name === 'rounds',
  );
  assert.ok(extension, 'the extension under test is not loaded');
  return extension;
}

describe('contribution guards', () => {
  let extension: vscode.Extension<unknown>;
  let registered: string[];

  before(async () => {
    extension = findExtension();
    await extension.activate();
    registered = await vscode.commands.getCommands(true);
  });

  it('activates without errors', () => {
    assert.equal(extension.isActive, true);
  });

  it('registers every command declared in the manifest', () => {
    const declared = (extension.packageJSON as ManifestShape).contributes.commands.map(
      (command) => command.command,
    );
    for (const command of declared) {
      assert.ok(registered.includes(command), `${command} is declared but not registered`);
    }
  });

  it('declares every registered command in the manifest', () => {
    const manifest = extension.packageJSON as ManifestShape;
    const declared = new Set(manifest.contributes.commands.map((command) => command.command));

    // The editor generates its own commands for contributed views and view containers,
    // for example `rounds.agentsView.open` or `rounds.agentsView.focus`. They share our
    // namespace but are not ours to declare.
    // Only view ids are used as prefixes here: the view container id is `rounds`, which
    // would swallow every command in our namespace.
    const generatedPrefixes = Object.values(manifest.contributes.views)
      .flat()
      .map((view) => `${view.id}.`);

    const ours = registered
      .filter((id) => id.startsWith('rounds.'))
      .filter((id) => !generatedPrefixes.some((prefix) => id.startsWith(prefix)));

    for (const command of ours) {
      assert.ok(declared.has(command), `${command} is registered but not declared`);
    }
    assert.equal(ours.length, declared.size);
  });

  it('keeps the command id list in the code base in sync with the manifest', () => {
    const declared = (extension.packageJSON as ManifestShape).contributes.commands
      .map((command) => command.command)
      .sort();
    assert.deepEqual([...COMMAND_IDS].sort(), declared);
  });

  it('contributes the agents view', () => {
    const views = (extension.packageJSON as ManifestShape).contributes.views;
    const ids = Object.values(views).flat().map((view) => view.id);
    assert.deepEqual(ids, ['rounds.agentsView']);
  });

  it('executes every command without throwing', async () => {
    for (const commandId of COMMAND_IDS) {
      await vscode.commands.executeCommand(commandId);
    }
  });

  it('declares limited support for an untrusted workspace', () => {
    // Without this the editor assumes the extension is safe everywhere and activates it in full,
    // while runScript stands ready to execute commands from whatever was cloned.
    const extension = vscode.extensions.getExtension('rounds.rounds');
    const capabilities = extension?.packageJSON?.capabilities?.untrustedWorkspaces;

    assert.equal(capabilities?.supported, 'limited');
    assert.deepEqual(capabilities?.restrictedConfigurations, ['rounds.scriptWhitelist']);
  });

  it('reads every contributed setting with a default value', () => {
    const configuration = vscode.workspace.getConfiguration();
    assert.equal(configuration.get('rounds.enabled'), true);
    assert.equal(configuration.get('rounds.jitterSeconds'), 600);
    assert.equal(configuration.get('rounds.maxExecutionsPerDay'), 24);
    assert.equal(configuration.get('rounds.logLevel'), 'info');
    assert.deepEqual(configuration.get('rounds.scriptWhitelist'), []);
  });
});
