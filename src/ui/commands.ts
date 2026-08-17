import * as vscode from 'vscode';

import type { ServiceContainer } from '../container.js';

/**
 * Every command this extension contributes.
 *
 * The list mirrors `contributes.commands` in `package.json`; a guard test compares both
 * directions so a command declared in one place and missing in the other fails the build.
 */
export const COMMAND_IDS = [
  'rounds.createAgent',
  'rounds.editAgent',
  'rounds.duplicateAgent',
  'rounds.deleteAgent',
  'rounds.toggleAgent',
  'rounds.runNow',
  'rounds.openResultFolder',
  'rounds.showHistory',
  'rounds.checkSetup',
  'rounds.refreshView',
  'rounds.showOutput',
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

/**
 * Placeholder implementations. Each phase replaces the stubs it owns:
 * setup in phase 4, run now in phase 8, the rest in phase 10.
 */
async function notImplemented(commandId: CommandId): Promise<void> {
  await vscode.window.showInformationMessage(`${commandId} is not implemented yet.`);
}

/** Registers all commands and ties their lifetime to the extension. */
export function registerCommands(container: ServiceContainer): void {
  for (const commandId of COMMAND_IDS) {
    container.extensionContext.subscriptions.push(
      vscode.commands.registerCommand(commandId, () => notImplemented(commandId)),
    );
  }
}
