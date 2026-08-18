import type * as vscode from 'vscode';

import type { PromptSnapshotSync } from './agents/promptSnapshots.js';
import type { AgentRunner } from './agents/runner.js';
import type { LeaderLock } from './scheduler/leaderLock.js';
import type { Leadership } from './scheduler/leadership.js';
import type { RunClaims } from './scheduler/runClaims.js';
import type { Ticker } from './scheduler/ticker.js';
import type { ModelCatalog } from './setup/modelCatalog.js';
import type { CountersService } from './state/counters.js';
import type { FileStateBackend, StateFileWatcher } from './state/fileStore.js';
import type { HistoryService } from './state/history.js';
import type { Logger } from './state/logger.js';
import type { OutputChannelSink } from './state/outputChannel.js';
import type { RoundsSecrets } from './state/secrets.js';
import type { RoundsSettings } from './state/settings.js';
import type { RoundsStore } from './state/store.js';
import type { ToolRegistry } from './tools/index.js';
import type { AgentsTreeDataProvider } from './ui/agentsView.js';
import type { ConnectionsTreeDataProvider } from './ui/connectionsView.js';
import type { Notifier } from './ui/notifications.js';
import type { RoundsStatusBar } from './ui/statusBar.js';

/**
 * Services shared across the extension.
 *
 * The container is built once during activation and passed explicitly to whatever needs
 * it. There are no global singletons and no service locator lookups, so every dependency
 * of a function is visible in its signature and can be replaced in tests.
 *
 * Later phases extend this with the model catalog, the connectors, the scheduler and the
 * runner.
 */
export interface ServiceContainer {
  readonly extensionContext: vscode.ExtensionContext;
  readonly output: OutputChannelSink;
  readonly logger: Logger;
  readonly store: RoundsStore;
  readonly stateBackend: FileStateBackend;
  readonly stateWatcher: StateFileWatcher;
  readonly secrets: RoundsSecrets;
  readonly history: HistoryService;
  readonly counters: CountersService;
  readonly leaderLock: LeaderLock;
  readonly leadership: Leadership;
  readonly runClaims: RunClaims;
  readonly models: ModelCatalog;
  readonly promptSnapshots: PromptSnapshotSync;
  readonly tools: ToolRegistry;
  readonly runner: AgentRunner;
  readonly ticker: Ticker;
  readonly agentsView: AgentsTreeDataProvider;
  readonly connectionsView: ConnectionsTreeDataProvider;
  readonly statusBar: RoundsStatusBar;
  /** The one place that decides whether something is worth interrupting the user for. */
  readonly notifier: Notifier;
  /** Whether the user trusts this workspace. Read on demand: trust can be granted while it is open. */
  readonly workspaceTrusted: () => boolean;
  /** Where the always-on extended log is written. Shown to the user when something goes wrong. */
  readonly logPath: string;
  /** Agents this window is currently running, so the tree can show it. */
  readonly runningAgents: Set<string>;
  /** Current settings, re-read whenever the configuration changes. */
  settings(): RoundsSettings;
}
