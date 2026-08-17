import type * as vscode from 'vscode';

import type { AgentsTreeDataProvider } from './ui/agentsView.js';

/**
 * Services shared across the extension.
 *
 * The container is built once during activation and passed explicitly to whatever needs
 * it. There are no global singletons and no service locator lookups, so every dependency
 * of a function is visible in its signature and can be replaced in tests.
 *
 * Later phases extend this with the logger, the state store, secrets, the model catalog,
 * the scheduler and the runner.
 */
export interface ServiceContainer {
  readonly extensionContext: vscode.ExtensionContext;
  readonly agentsView: AgentsTreeDataProvider;
}
