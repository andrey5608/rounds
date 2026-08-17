import * as vscode from 'vscode';

/** Identifier of the contributed tree view. Must match `package.json`. */
export const AGENTS_VIEW_ID = 'rounds.agentsView';

/** Context key that hides the welcome view once at least one agent exists. */
export const HAS_AGENTS_CONTEXT_KEY = 'rounds.hasAgents';

/**
 * Placeholder tree for the agents view.
 *
 * A contributed view needs a registered data provider, otherwise the editor reports a
 * missing provider instead of rendering the welcome content. The real tree, with agents
 * and their recent runs, arrives in phase 10.
 */
export class AgentsTreeDataProvider implements vscode.TreeDataProvider<never> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  getTreeItem(element: never): vscode.TreeItem {
    return element;
  }

  getChildren(): never[] {
    return [];
  }

  /** Asks the view to re-read the tree. */
  refresh(): void {
    this.changeEmitter.fire();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

/** Registers the agents view and keeps the welcome-view context key in sync. */
export function registerAgentsView(context: vscode.ExtensionContext): AgentsTreeDataProvider {
  const provider = new AgentsTreeDataProvider();
  context.subscriptions.push(
    provider,
    vscode.window.registerTreeDataProvider(AGENTS_VIEW_ID, provider),
  );
  void vscode.commands.executeCommand('setContext', HAS_AGENTS_CONTEXT_KEY, false);
  return provider;
}
