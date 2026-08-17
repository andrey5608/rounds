import * as vscode from 'vscode';

import { PromptSnapshotSync } from './agents/promptSnapshots.js';
import { AgentRunner } from './agents/runner.js';
import { ConnectorFactory } from './connectors/factory.js';
import { handOffToChat } from './model/chatHandoff.js';
import type { ServiceContainer } from './container.js';
import { LeaderLock } from './scheduler/leaderLock.js';
import { Leadership } from './scheduler/leadership.js';
import { recoverStaleClaims } from './scheduler/recovery.js';
import { Ticker } from './scheduler/ticker.js';
import { RunClaims } from './scheduler/runClaims.js';
import { VscodeLanguageModelGateway } from './model/vscodeGateway.js';
import { showFirstRunNotice } from './setup/firstRunNotice.js';
import { ModelCatalog } from './setup/modelCatalog.js';
import { CountersService } from './state/counters.js';
import { FileStateBackend, StateFileWatcher } from './state/fileStore.js';
import { HistoryService } from './state/history.js';
import { Logger } from './state/logger.js';
import { createOutputChannelSink } from './state/outputChannel.js';
import { RoundsSecrets } from './state/secrets.js';
import { readSettings } from './state/settings.js';
import type { RoundsSettings } from './state/settings.js';
import { RoundsStore } from './state/store.js';
import { createToolRegistry } from './tools/index.js';
import { createVscodeFileFinder } from './tools/vscodeFileFinder.js';
import { SECRET_NAMES } from './state/secrets.js';
import { registerAgentsView } from './ui/agentsView.js';
import { registerRunDetails } from './ui/runDetails.js';
import { refreshView } from './ui/viewState.js';
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
  const promptSnapshots = new PromptSnapshotSync({
    store,
    logger,
    getFallback: () => settings.promptFileFallback,
  });
  const runClaims = new RunClaims({ store, windowId: leadership.windowId, logger });

  const tools = createToolRegistry();
  const models = new ModelCatalog({
    gateway: new VscodeLanguageModelGateway(),
    store,
    logger,
  });
  const history = new HistoryService(store, () => settings.executionHistoryLimit);
  const counters = new CountersService({
    store,
    getGlobalLimit: () => settings.maxExecutionsPerDay,
    getTimeZone: () => settings.timezone,
  });

  const runner = new AgentRunner({
    store,
    history,
    counters,
    claims: runClaims,
    models,
    gateway: new VscodeLanguageModelGateway(),
    registry: tools,
    // The endpoints live in the state and can change between runs, so the factory is built per
    // run rather than captured once.
    connectors: {
      forSource: async (source) => {
        const current = await store.read();
        const factory = new ConnectorFactory({
          secrets,
          endpoints: current.endpoints,
          logger,
        });
        return factory.forSource(source);
      },
    },
    handOffToChat,
    settings: () => settings,
    globalStorage: extensionContext.globalStorageUri.fsPath,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    workspaceName: vscode.workspace.workspaceFolders?.[0]?.name,
    findFiles: createVscodeFileFinder(),
    logger,
    secretNames: async () => {
      const stored: typeof SECRET_NAMES = [];
      for (const name of SECRET_NAMES) {
        if (await secrets.has(name)) {
          stored.push(name);
        }
      }
      return stored;
    },
  });

  const ticker = new Ticker({
    store,
    runner,
    settings: () => settings,
    logger,
    onCapReached: (message) => {
      void vscode.window
        .showWarningMessage(message, 'Open Settings')
        .then((choice) => {
          if (choice === 'Open Settings') {
            void vscode.commands.executeCommand(
              'workbench.action.openSettings',
              'rounds.maxExecutionsPerDay',
            );
          }
        });
    },
    onFrequencyWarning: (agent, interval) => {
      void vscode.window.showWarningMessage(
        `The agent "${agent.name}" runs every ${interval} minute(s). Frequent automated requests can get your model provider account rate limited.`,
      );
    },
  });

  container = {
    extensionContext,
    output,
    logger,
    store,
    stateBackend,
    stateWatcher,
    secrets,
    history,
    counters,
    leaderLock,
    leadership,
    runClaims,
    promptSnapshots,
    tools,
    runner,
    ticker,
    models,
    agentsView,
    statusBar,
    runningAgents: new Set<string>(),
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
    promptSnapshots,
    ticker,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('rounds')) {
        const previous = settings;
        settings = readSettings(vscode.workspace.getConfiguration());
        logger.debug('Settings changed; reloaded them.');
        if (settings.enabled !== previous.enabled) {
          if (settings.enabled && leadership.isLeader) {
            ticker.start();
          } else {
            ticker.stop();
          }
        }
        if (settings.timezone !== previous.timezone) {
          // Every next run was computed in the old zone and has to be redone.
          void ticker.recomputeAll();
        }
        agentsView.refresh();
      }
    }),
    leadership.onDidChange((isLeader) => {
      statusBar.setLeader(isLeader);
      void vscode.commands.executeCommand('setContext', 'rounds.isLeader', isLeader);
      // Only the window that holds the lock schedules runs; the others stay tick-free.
      if (isLeader && settings.enabled) {
        ticker.start();
        void ticker.catchUp();
      } else {
        ticker.stop();
      }
    }),
    store.onDidChange((change) => {
      void vscode.commands.executeCommand(
        'setContext',
        'rounds.hasAgents',
        change.state.agents.length > 0,
      );
      if (container) {
        void refreshView(container);
      }
    }),
  );

  registerRunDetails(extensionContext, store);
  registerCommands(container);

  // The "next run" text is relative, so it goes stale on its own. One slow timer keeps it honest;
  // a per-second timer would repaint the view for no reason.
  const relativeTimeTimer = setInterval(() => {
    agentsView.refresh();
  }, 60_000);
  relativeTimeTimer.unref?.();
  extensionContext.subscriptions.push({ dispose: () => clearInterval(relativeTimeTimer) });

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
    await refreshView(services);
    // A claim tagged with this window id, or one nobody refreshes any more, is what a
    // crashed window leaves behind. Clearing it keeps the agent runnable.
    await recoverStaleClaims({
      store: services.store,
      windowId: services.leadership.windowId,
      logger: services.logger,
    });
    await services.stateWatcher.start();
    services.leadership.start();
    // Prompt files may have changed while this window was closed.
    services.promptSnapshots.start(services.extensionContext);
    await services.promptSnapshots.syncAll();
    services.logger.info(
      `Rounds is ready with ${state.agents.length} agent(s) at state revision ${state.revision}.`,
    );
    // Last, so a first-time notification never delays anything functional.
    await showFirstRunNotice(services.store);
  } catch (error) {
    services.logger.error(`Could not load the stored state: ${String(error)}`);
  }
}

/** Called when the extension is deactivated. Disposes everything activation created. */
export async function deactivate(): Promise<void> {
  // Releasing the scheduling lock is awaited on purpose: another window can then take
  // over at once instead of waiting for the lock to go stale.
  container?.ticker.stop();
  await container?.leadership.stop();
  // Everything else created during activation is registered in `context.subscriptions`,
  // which the editor disposes for us.
  container = undefined;
}
