import * as vscode from 'vscode';

import type { ServiceContainer } from './container.js';
import { LeaderLock } from './scheduler/leaderLock.js';
import { Leadership } from './scheduler/leadership.js';
import { recoverStaleClaims } from './scheduler/recovery.js';
import { RunClaims } from './scheduler/runClaims.js';
import { CountersService } from './state/counters.js';
import { FileStateBackend, StateFileWatcher } from './state/fileStore.js';
import { HistoryService } from './state/history.js';
import { Logger } from './state/logger.js';
import { createOutputChannelSink } from './state/outputChannel.js';
import { RoundsSecrets } from './state/secrets.js';
import { readSettings } from './state/settings.js';
import type { RoundsSettings } from './state/settings.js';
import { RoundsStore } from './state/store.js';
import { registerAgentsView } from './ui/agentsView.js';
import { registerCommands } from './ui/commands.js';
import { RoundsStatusBar } from './ui/statusBar.js';

let container: ServiceContainer | undefined;

/**
 * Entry point called by the editor when the extension is activated.
 *
 * Activation happens on `onStartupFinished` and whenever the contributed view is opened,
 * so it runs in every window without the user asking for it. That puts three hard rules
 * on this function:
 *
 * 1. Never resolve language models here. Model selection requires consent and must come
 *    from a user-initiated action, so it lives behind the consent gate instead.
 * 2. Never perform network calls and never show modal dialogs.
 * 3. Keep the synchronous part small; anything slower is deferred to a later tick.
 */
export function activate(extensionContext: vscode.ExtensionContext): void {
  let settings: RoundsSettings = readSettings(vscode.workspace.getConfiguration());

  const output = createOutputChannelSink();
  const secrets = new RoundsSecrets(extensionContext.secrets);
  const logger = new Logger({
    sink: output,
    getLevel: () => settings.logLevel,
    getRedactions: () => secrets.knownValues(),
  });

  const stateBackend = new FileStateBackend({
    directory: extensionContext.globalStorageUri.fsPath,
    memento: extensionContext.globalState,
    logger,
  });
  const store = new RoundsStore({
    backend: stateBackend,
    logger,
    timeZone: settings.timezone,
  });
  const stateWatcher = new StateFileWatcher({
    backend: stateBackend,
    logger,
    onChanged: () => {
      void store.refreshFromExternalChange();
    },
  });

  const agentsView = registerAgentsView(extensionContext);
  const statusBar = new RoundsStatusBar();

  // Only one window may schedule runs; the others stay responsive but tick-free.
  const leaderLock = new LeaderLock({
    directory: extensionContext.globalStorageUri.fsPath,
    logger,
  });
  const leadership = new Leadership({ lock: leaderLock, logger });
  const runClaims = new RunClaims({ store, windowId: leadership.windowId, logger });

  container = {
    extensionContext,
    output,
    logger,
    store,
    stateBackend,
    stateWatcher,
    secrets,
    history: new HistoryService(store, () => settings.executionHistoryLimit),
    counters: new CountersService({
      store,
      getGlobalLimit: () => settings.maxExecutionsPerDay,
      getTimeZone: () => settings.timezone,
    }),
    leaderLock,
    leadership,
    runClaims,
    agentsView,
    statusBar,
    settings: () => settings,
  };

  extensionContext.subscriptions.push(
    output,
    secrets,
    store,
    statusBar,
    stateWatcher,
    leadership,
    runClaims,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('rounds')) {
        settings = readSettings(vscode.workspace.getConfiguration());
        logger.debug('Settings changed; reloaded them.');
        agentsView.refresh();
      }
    }),
    leadership.onDidChange((isLeader) => {
      statusBar.setLeader(isLeader);
      void vscode.commands.executeCommand('setContext', 'rounds.isLeader', isLeader);
    }),
    store.onDidChange((change) => {
      void vscode.commands.executeCommand(
        'setContext',
        'rounds.hasAgents',
        change.state.agents.length > 0,
      );
      agentsView.refresh();
    }),
  );

  registerCommands(container);

  // Everything below touches the file system, so it happens after activation returns.
  void bootstrap(container);
}

/** Work that must not delay activation: reading stored state and starting the watcher. */
async function bootstrap(services: ServiceContainer): Promise<void> {
  try {
    const state = await services.store.read();
    await vscode.commands.executeCommand(
      'setContext',
      'rounds.hasAgents',
      state.agents.length > 0,
    );
    services.statusBar.update({ kind: 'idle', agentCount: state.agents.length });
    services.agentsView.refresh();
    // A claim tagged with this window id, or one nobody refreshes any more, is what a
    // crashed window leaves behind. Clearing it keeps the agent runnable.
    await recoverStaleClaims({
      store: services.store,
      windowId: services.leadership.windowId,
      logger: services.logger,
    });
    await services.stateWatcher.start();
    services.leadership.start();
    services.logger.info(
      `Rounds is ready with ${state.agents.length} agent(s) at state revision ${state.revision}.`,
    );
  } catch (error) {
    services.logger.error(`Could not load the stored state: ${String(error)}`);
  }
}

/** Called when the extension is deactivated. Disposes everything activation created. */
export async function deactivate(): Promise<void> {
  // Releasing the scheduling lock is awaited on purpose: another window can then take
  // over at once instead of waiting for the lock to go stale.
  await container?.leadership.stop();
  // Everything else created during activation is registered in `context.subscriptions`,
  // which the editor disposes for us.
  container = undefined;
}
