import * as vscode from 'vscode';

import type { ServiceContainer } from '../container.js';
import { checkSetupCommand } from '../setup/checkSetupCommand.js';

import {
  createAgentCommand,
  deleteAgentCommand,
  duplicateAgentCommand,
  editAgentCommand,
  openResultFolderCommand,
  showAgentCommand,
  showHistoryCommand,
  toggleAgentCommand,
} from './agentCommands.js';
import { runNowCommand } from './runNowCommand.js';
import { refreshView } from './viewState.js';

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
  'rounds.showAgent',
  'rounds.checkSetup',
  'rounds.refreshView',
  'rounds.showOutput',
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

/**
 * Last resort for a command that has no handler.
 *
 * Every declared command is implemented, and the guard test keeps the two lists in step, so this
 * only fires if somebody adds an id and forgets the handler — in which case saying so is far better
 * than a command that silently does nothing.
 */
function missingHandler(commandId: CommandId): void {
  // Not awaited on purpose: a command returns as soon as it has been handled.
  void vscode.window.showErrorMessage(
    `${commandId} has no implementation. This is a bug in Rounds.`,
  );
}

/** Every command, now that each one has an implementation. */
function implemented(
  container: ServiceContainer,
): Partial<Record<CommandId, (argument?: unknown) => void>> {
  return {
    'rounds.createAgent': () => {
      void runAndReport(container, 'rounds.createAgent', () => createAgentCommand(container));
    },
    'rounds.editAgent': (argument) => {
      void runAndReport(container, 'rounds.editAgent', () => editAgentCommand(container, argument));
    },
    'rounds.duplicateAgent': (argument) => {
      void runAndReport(container, 'rounds.duplicateAgent', () =>
        duplicateAgentCommand(container, argument),
      );
    },
    'rounds.deleteAgent': (argument) => {
      void runAndReport(container, 'rounds.deleteAgent', () =>
        deleteAgentCommand(container, argument),
      );
    },
    'rounds.toggleAgent': (argument) => {
      void runAndReport(container, 'rounds.toggleAgent', () =>
        toggleAgentCommand(container, argument),
      );
    },
    'rounds.openResultFolder': (argument) => {
      void runAndReport(container, 'rounds.openResultFolder', () =>
        openResultFolderCommand(container, argument),
      );
    },
    'rounds.showAgent': (argument) => {
      void runAndReport(container, 'rounds.showAgent', () => showAgentCommand(container, argument));
    },
    'rounds.showHistory': (argument) => {
      void runAndReport(container, 'rounds.showHistory', () =>
        showHistoryCommand(container, argument),
      );
    },
    'rounds.runNow': (argument) => {
      void runAndReport(container, 'rounds.runNow', () =>
        runNowCommand(container, argument as Parameters<typeof runNowCommand>[1]),
      );
    },
    'rounds.checkSetup': () => {
      void runAndReport(container, 'rounds.checkSetup', () => checkSetupCommand(container));
    },
    'rounds.showOutput': () => {
      container.output.show();
    },
    'rounds.refreshView': () => {
      void runAndReport(container, 'rounds.refreshView', async () => {
        await container.store.refreshFromExternalChange();
        await refreshView(container);
      });
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
    const handler = handlers[commandId] ?? (() => missingHandler(commandId));
    container.extensionContext.subscriptions.push(
      vscode.commands.registerCommand(commandId, handler),
    );
  }
}
