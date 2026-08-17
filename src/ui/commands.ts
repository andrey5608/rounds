import * as vscode from 'vscode';

import type { ServiceContainer } from '../container.js';
import { checkSetupCommand } from '../setup/checkSetupCommand.js';

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
function notImplemented(commandId: CommandId): void {
  // The notification is deliberately not awaited: a command should return as soon as it
  // has been handled, and nothing depends on the user dismissing the message.
  void vscode.window.showInformationMessage(`${commandId} is not implemented yet.`);
}

/**
 * Commands that are already backed by real services.
 *
 * The rest keep their stub until the phase that owns them: setup in phase 4, run now in
 * phase 8, agent management in phase 10.
 */
function implemented(container: ServiceContainer): Partial<Record<CommandId, () => void>> {
  return {
    'rounds.checkSetup': () => {
      void runAndReport(container, 'rounds.checkSetup', () => checkSetupCommand(container));
    },
    'rounds.showOutput': () => {
      container.output.show();
    },
    'rounds.refreshView': () => {
      container.agentsView.refresh();
      void container.store.refreshFromExternalChange();
    },
  };
}

/**
 * Runs a command body and reports a failure instead of leaving an unhandled rejection.
 *
 * A command that throws silently is worse than one that fails loudly: the user pressed
 * something and nothing happened, with no trace anywhere.
 */
async function runAndReport(
  container: ServiceContainer,
  commandId: CommandId,
  body: () => Promise<void>,
): Promise<void> {
  try {
    await body();
  } catch (error) {
    container.logger.error(`${commandId} failed: ${String(error)}`);
    await vscode.window.showErrorMessage(
      `${commandId} failed: ${String(error)}. Open the Rounds output for details.`,
    );
  }
}

/** Registers all commands and ties their lifetime to the extension. */
export function registerCommands(container: ServiceContainer): void {
  const handlers = implemented(container);
  for (const commandId of COMMAND_IDS) {
    const handler = handlers[commandId] ?? (() => notImplemented(commandId));
    container.extensionContext.subscriptions.push(
      vscode.commands.registerCommand(commandId, handler),
    );
  }
}
