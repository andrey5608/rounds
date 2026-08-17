import * as vscode from 'vscode';

import { registerAgentsView } from './ui/agentsView.js';

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
 *
 * Services are wired up in step 1.7 and grow with the following phases.
 */
export function activate(context: vscode.ExtensionContext): void {
  registerAgentsView(context);
}

/** Called when the extension is deactivated. Disposes everything activation created. */
export function deactivate(): void {
  // Nothing to dispose yet.
}
