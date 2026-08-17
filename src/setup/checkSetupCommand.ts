import * as vscode from 'vscode';

import type { ServiceContainer } from '../container.js';
import { mapModelError } from '../model/errors.js';
import type { CheckOutcome, CheckStatus, SourceKind } from '../state/types.js';

import { runSetupChecks, worstStatus } from './checks.js';
import type { SetupCheckContext } from './checks.js';
import { userAction } from './consentGate.js';
import { addOrUpdateEndpoint, enterToken } from './endpointEditor.js';
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
  return {
    settings,
    agents: state.agents,
    endpoints: state.endpoints,
    hasConsent: state.setup.consentGrantedAt !== undefined,
    models: state.setup.models ?? [],
    hasSecret: (name) => container.secrets.has(name),
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
    const models = await container.models.list(userAction('check setup: grant model access'));
    if (models.length === 0) {
      await vscode.window.showWarningMessage(
        'Access was granted but no models are available. Check that a language model provider, such as GitHub Copilot, is installed and signed in.',
      );
      return;
    }
    await vscode.window.showInformationMessage(`Rounds can use ${models.length} model(s).`);
  } catch (error) {
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
      { label: '$(add) Add or replace a base URL', value: 'endpoint' as const },
      { label: '$(key) Enter the token', value: 'token' as const },
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
    const endpoint = await addOrUpdateEndpoint(container.store, kind);
    if (endpoint) {
      container.logger.info(`Configured the ${kind} connection "${endpoint.name}".`);
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
