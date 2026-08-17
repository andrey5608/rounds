import type * as vscode from 'vscode';

import type { LeaderLock } from './scheduler/leaderLock.js';
import type { Leadership } from './scheduler/leadership.js';
import type { RunClaims } from './scheduler/runClaims.js';
import type { CountersService } from './state/counters.js';
import type { FileStateBackend, StateFileWatcher } from './state/fileStore.js';
import type { HistoryService } from './state/history.js';
import type { Logger } from './state/logger.js';
import type { OutputChannelSink } from './state/outputChannel.js';
import type { RoundsSecrets } from './state/secrets.js';
import type { RoundsSettings } from './state/settings.js';
import type { RoundsStore } from './state/store.js';
import type { AgentsTreeDataProvider } from './ui/agentsView.js';
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
  readonly agentsView: AgentsTreeDataProvider;
  readonly statusBar: RoundsStatusBar;
  /** Current settings, re-read whenever the configuration changes. */
  settings(): RoundsSettings;
}
