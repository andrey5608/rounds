import * as vscode from 'vscode';

/**
 * Entry point called by the editor when the extension is activated.
 * Contribution points and services are wired up in later phases.
 */
export function activate(_context: vscode.ExtensionContext): void {
  // Intentionally empty: phase 0 only proves the scaffold builds and loads.
}

/** Called when the extension is deactivated. */
export function deactivate(): void {
  // Nothing to dispose yet.
}
