import * as vscode from 'vscode';

import type { ServiceContainer } from './container.js';
import { registerAgentsView } from './ui/agentsView.js';
import { registerCommands } from './ui/commands.js';

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
  const agentsView = registerAgentsView(extensionContext);
  container = { extensionContext, agentsView };
  registerCommands(container);
}

/** Called when the extension is deactivated. Disposes everything activation created. */
export function deactivate(): void {
  // Everything created during activation is registered in `context.subscriptions`,
  // which the editor disposes for us. Dropping the reference keeps deactivation honest
  // for services added in later phases.
  container = undefined;
}
