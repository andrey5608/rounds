import * as vscode from 'vscode';

import { ConnectorFactory } from '../connectors/factory.js';
import type { ServiceContainer } from '../container.js';
import { mapModelError } from '../model/errors.js';
import type { CheckOutcome, CheckStatus, SourceKind } from '../state/types.js';

import { runSetupChecks, worstStatus } from './checks.js';
import { ModelRequestCancelledError, ModelRequestTimeoutError } from './modelCatalog.js';
import type { SetupCheckContext } from './checks.js';
import { userAction } from './consentGate.js';
import { addConnection, enterToken } from './endpointEditor.js';
import { probeOutputFolder, resolveOutputFolder } from './outputFolder.js';

const STATUS_ICON: Record<CheckStatus, string> = {
  pass: '$(pass)',
  warn: '$(warning)',
  fail: '$(error)',
};

/** Builds the check context from the services, without triggering a consent prompt. */
export async function buildCheckContext(container: ServiceContainer): Promise<SetupCheckContext> {
  const state = await container.store.read();
  const settings = container.settings();
  const factory = new ConnectorFactory({
    secrets: container.secrets,
    endpoints: state.endpoints,
    logger: container.logger,
  });
  return {
    settings,
    agents: state.agents,
    endpoints: state.endpoints,
    hasConsent: state.setup.consentGrantedAt !== undefined,
    models: state.setup.models ?? [],
    hasSecret: (name) => container.secrets.has(name),
    workspaceTrusted: container.workspaceTrusted(),
    // Live reachability, so the check reports what a run would actually hit.
    pingEndpoint: (endpoint) => factory.ping(endpoint),
    probeOutputFolder: () =>
      probeOutputFolder(
        resolveOutputFolder({
          settingFolder: settings.defaultOutputFolder,
          globalStorage: container.extensionContext.globalStorageUri.fsPath,
        }),
      ),
  };
}

/** Runs every check, stores the results and reports them. */
export async function runChecks(container: ServiceContainer): Promise<CheckOutcome[]> {
  const context = await buildCheckContext(container);
  const results = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Rounds: checking setup' },
    () => runSetupChecks(context),
  );

  const at = new Date().toISOString();
  await container.store.update((draft) => {
    draft.setup.lastCheckAt = at;
    draft.setup.lastCheckResults = results;
  });
  for (const result of results) {
    container.logger.info(`Setup check ${result.id}: ${result.status} — ${result.message}`);
  }
  return results;
}

/** The `rounds.checkSetup` command: run the checks, show them, offer to fix one. */
export async function checkSetupCommand(container: ServiceContainer): Promise<void> {
  const results = await runChecks(container);
  const summary = worstStatus(results);

  const picked = await vscode.window.showQuickPick(
    results.map((result) => ({
      label: `${STATUS_ICON[result.status]} ${result.title}`,
      detail: result.message,
      result,
    })),
    {
      title:
        summary === 'pass'
          ? 'Setup looks complete. Select an item for details.'
          : 'Select an item to fix it.',
      ignoreFocusOut: true,
    },
  );
  if (!picked) {
    return;
  }
  await fixCheck(container, picked.result.id);
}

/** Opens whatever fixes the selected check, then reports the outcome again. */
async function fixCheck(container: ServiceContainer, checkId: string): Promise<void> {
  switch (checkId) {
    case 'models':
      await grantModelAccess(container);
      break;
    case 'jira':
    case 'git':
      await fixSource(container, checkId);
      break;
    case 'outputFolder':
      await pickOutputFolder(container);
      break;
    case 'scriptWhitelist':
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'rounds.scriptWhitelist',
      );
      return;
    case 'rateLimits':
      await vscode.commands.executeCommand('workbench.action.openSettings', 'rounds.jitterSeconds');
      return;
    default:
      return;
  }
  // Re-run so the user sees the effect of what they just changed.
  await checkSetupCommand(container);
}

/**
 * Asks the editor for the model list, which is what triggers the consent prompt.
 *
 * This is a user-initiated action by definition — the user selected it in the setup list —
 * so it is one of the few places allowed to create a user action token.
 */
async function grantModelAccess(container: ServiceContainer): Promise<void> {
  try {
    const models = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Rounds: asking the editor for a language model',
        // Cancellable on purpose: this waits on another extension, so it must be possible to give up
        // without the notification sitting on the screen indefinitely.
        cancellable: true,
      },
      // Waiting matters here: a provider that is still starting reports nothing, and concluding
      // "none available" would tell a user with a working provider to go and install one.
      (progress, token) => {
        progress.report({ message: 'A permission dialog may appear.' });
        return container.models.list(userAction('check setup: grant model access'), {
          waitForProviderMs: 15_000,
          isCancelled: () => token.isCancellationRequested,
        });
      },
    );
    if (models.length === 0) {
      const choice = await vscode.window.showWarningMessage(
        'The editor reported no language models. Chat models come from a provider such as GitHub Copilot Chat, which must be installed, signed in and enabled here — the completions extension alone provides none. If it has only just started, wait a moment and try again.',
        'Try Again',
        'Show Output',
        'Open Log File',
      );
      if (choice === 'Try Again') {
        await grantModelAccess(container);
      } else if (choice === 'Show Output') {
        container.output.show();
      } else if (choice === 'Open Log File') {
        await vscode.window.showTextDocument(vscode.Uri.file(container.logPath));
      }
      return;
    }
    await vscode.window.showInformationMessage(
      `Rounds can use ${models.length} model(s): ${models.map((model) => model.id).join(', ')}.`,
    );
  } catch (error) {
    if (error instanceof ModelRequestCancelledError) {
      container.logger.info('The user cancelled the model request.');
      return;
    }
    if (error instanceof ModelRequestTimeoutError) {
      container.logger.error(error.message);
      const choice = await vscode.window.showErrorMessage(
        error.message,
        'Try Again',
        'Open Log File',
      );
      if (choice === 'Try Again') {
        await grantModelAccess(container);
      } else if (choice === 'Open Log File') {
        await vscode.window.showTextDocument(vscode.Uri.file(container.logPath));
      }
      return;
    }
    const mapped = mapModelError(error);
    container.logger.error(`Could not resolve models: ${mapped.detail}`);
    await vscode.window.showErrorMessage(mapped.message);
  }
}

/** Lets the user add a base URL or store a token for one source kind. */
async function fixSource(container: ServiceContainer, kind: SourceKind): Promise<void> {
  const state = await container.store.read();
  const existing = Object.values(state.endpoints).filter((endpoint) => endpoint.kind === kind);

  const action = await vscode.window.showQuickPick(
    [
      { label: '$(add) Add a connection', detail: 'Base URL, how it authenticates, and its token', value: 'endpoint' as const },
      { label: '$(key) Replace the token only', value: 'token' as const },
    ],
    {
      title: existing.length > 0 ? `Configured: ${existing.map((e) => e.name).join(', ')}` : 'Nothing configured yet',
      ignoreFocusOut: true,
    },
  );
  if (!action) {
    return;
  }
  if (action.value === 'endpoint') {
    const endpoint = await addConnection(container.store, container.secrets, kind);
    if (endpoint) {
      container.logger.info(`Configured the ${kind} connection "${endpoint.name}" and stored its token.`);
    }
    return;
  }
  if (await enterToken(container.secrets, kind)) {
    container.logger.info(`Stored the ${kind} token in secret storage.`);
  }
}

/** Points the default result folder somewhere the user chose. */
async function pickOutputFolder(container: ServiceContainer): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    title: 'Choose the folder for result files',
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  const folder = picked?.[0];
  if (!folder) {
    return;
  }
  await vscode.workspace
    .getConfiguration()
    .update('rounds.defaultOutputFolder', folder.fsPath, vscode.ConfigurationTarget.Global);
  container.logger.info(`Result files now go to ${folder.fsPath}.`);
}
