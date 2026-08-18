import * as vscode from 'vscode';

import type { MessageHost, MessageLevel, NotifierCommands } from './notifications.js';

/** The editor's message API behind the port the notification policy speaks. */
export function createVscodeMessageHost(): MessageHost {
  return {
    show(level: MessageLevel, message: string, actions: string[]): Promise<string | undefined> {
      const show =
        level === 'error'
          ? vscode.window.showErrorMessage
          : level === 'warning'
            ? vscode.window.showWarningMessage
            : vscode.window.showInformationMessage;
      return Promise.resolve(show(message, ...actions));
    },
  };
}

/** What the notification actions do, expressed as the commands that already exist. */
export function createNotifierCommands(showOutput: () => void): NotifierCommands {
  return {
    showOutput,
    // The commands resolve an argument carrying `id` and `name` without a picker, so the
    // notification's action lands on the agent it was about.
    showHistory: (agent) => {
      void vscode.commands.executeCommand('rounds.showHistory', agent);
    },
    editAgent: (agent) => {
      void vscode.commands.executeCommand('rounds.editAgent', agent);
    },
    openSetting: (key) => {
      void vscode.commands.executeCommand('workbench.action.openSettings', key);
    },
    checkSetup: () => {
      void vscode.commands.executeCommand('rounds.checkSetup');
    },
  };
}
