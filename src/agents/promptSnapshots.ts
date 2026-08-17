import * as vscode from 'vscode';

import type { RoundsStore } from '../state/store.js';
import type { Logger } from '../state/logger.js';
import type { PromptFileFallback } from '../state/types.js';

import { PromptResolver } from './promptResolver.js';

export interface PromptSnapshotSyncOptions {
  store: RoundsStore;
  logger: Logger;
  getFallback: () => PromptFileFallback;
}

/**
 * Keeps the stored snapshot of every file-based prompt current.
 *
 * The snapshot is what a run falls back to when the file has gone missing, which only helps if
 * it reflects what the user last wrote. It is refreshed on activation and whenever a prompt
 * file inside the workspace changes, so the stale-snapshot window is minutes rather than
 * however long ago the agent was created.
 */
export class PromptSnapshotSync {
  private watcher: vscode.FileSystemWatcher | undefined;

  constructor(private readonly options: PromptSnapshotSyncOptions) {}

  /** Re-reads every file prompt and stores what changed. Safe to call at any time. */
  async syncAll(): Promise<number> {
    const state = await this.options.store.read();
    const resolver = this.createResolver();
    const updates = new Map<string, { content: string; hash: string; capturedAt: string }>();

    for (const agent of state.agents) {
      if (agent.prompt.source !== 'file') {
        continue;
      }
      try {
        const resolution = await resolver.resolve(agent);
        if (resolution.refreshedSnapshot) {
          updates.set(agent.id, resolution.refreshedSnapshot);
        }
      } catch (error) {
        // A prompt that cannot be resolved is a problem for the run, not for this sync.
        this.options.logger.debug(
          `Could not refresh the prompt snapshot of "${agent.name}": ${String(error)}`,
        );
      }
    }

    if (updates.size === 0) {
      return 0;
    }
    await this.options.store.update((draft) => {
      for (const agent of draft.agents) {
        const snapshot = updates.get(agent.id);
        if (snapshot) {
          agent.prompt.snapshot = snapshot;
        }
      }
    });
    this.options.logger.info(`Refreshed ${updates.size} prompt snapshot(s).`);
    return updates.size;
  }

  /**
   * Watches prompt files that live inside the workspace.
   *
   * Only those: a watcher can express workspace-relative patterns, and a prompt kept outside
   * the workspace is re-read on every run anyway.
   */
  start(context: vscode.ExtensionContext): void {
    this.watcher = vscode.workspace.createFileSystemWatcher('**/*');
    const onChange = (uri: vscode.Uri): void => {
      void this.handleChange(uri);
    };
    this.watcher.onDidChange(onChange);
    this.watcher.onDidCreate(onChange);
    this.watcher.onDidDelete(onChange);
    context.subscriptions.push(this.watcher);
  }

  private async handleChange(uri: vscode.Uri): Promise<void> {
    const state = await this.options.store.read();
    const resolver = this.createResolver();
    const affected = state.agents.some(
      (agent) => agent.prompt.source === 'file' && resolver.resolveFilePath(agent) === uri.fsPath,
    );
    if (!affected) {
      return;
    }
    this.options.logger.debug(`A prompt file changed: ${uri.fsPath}`);
    await this.syncAll();
  }

  private createResolver(): PromptResolver {
    return new PromptResolver({
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      defaultFallback: this.options.getFallback(),
      logger: this.options.logger,
    });
  }

  dispose(): void {
    this.watcher?.dispose();
    this.watcher = undefined;
  }
}
