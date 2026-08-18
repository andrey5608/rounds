import * as vscode from 'vscode';

import { resolveApiRoot, resolveProvider } from '../connectors/factory.js';
import type { EndpointConfig, PersistedState } from '../state/types.js';

/** Identifier of the contributed tree view. Must match `package.json`. */
export const CONNECTIONS_VIEW_ID = 'rounds.connectionsView';

/** Context key that hides the welcome view once at least one connection exists. */
export const HAS_CONNECTIONS_CONTEXT_KEY = 'rounds.hasConnections';

export interface ConnectionsViewData {
  state: PersistedState;
  /** Names of the connections a token is stored for. */
  withToken: string[];
}

export interface ConnectionNode {
  kind: 'connection';
  endpoint: EndpointConfig;
}

const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  bitbucketCloud: 'Bitbucket Cloud',
  bitbucketServer: 'Bitbucket, self-hosted',
};

/** What a row says without being opened: which host, which API, and whether it can authenticate. */
export function describeConnection(endpoint: EndpointConfig, hasToken: boolean): string {
  const host = hostOf(endpoint.baseUrl);
  const provider =
    endpoint.kind === 'git' ? (PROVIDER_LABEL[resolveProvider(endpoint)] ?? 'unknown API') : 'Jira';
  return `${host} · ${provider}${hasToken ? '' : ' · no token'}`;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/**
 * The tooltip of one connection.
 *
 * It names the resolved API root, because that is the value a request actually uses and the one
 * a wrong base URL shows up in. It never names the token, not even masked: a masked token still
 * leaks its length, and there is no question anybody answers by looking at one.
 */
export function connectionTooltip(
  endpoint: EndpointConfig,
  hasToken: boolean,
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${endpoint.name}**\n\n`);
  tooltip.appendMarkdown(`- Kind: ${endpoint.kind === 'jira' ? 'issue tracker' : 'repository host'}\n`);
  tooltip.appendMarkdown(`- Base URL: ${endpoint.baseUrl}\n`);
  try {
    tooltip.appendMarkdown(`- Requests go to: ${resolveApiRoot(endpoint)}\n`);
  } catch (error) {
    tooltip.appendMarkdown(`- Requests go to: ${error instanceof Error ? error.message : 'unknown'}\n`);
  }
  tooltip.appendMarkdown(
    `- Authentication: ${endpoint.authScheme === 'basic' ? `basic, as ${endpoint.username ?? '(no user name)'}` : 'token'}\n`,
  );
  tooltip.appendMarkdown(`- Token stored: ${hasToken ? 'yes' : 'no'}\n`);
  if (endpoint.lastCheck) {
    tooltip.appendMarkdown(
      `- Last check: ${endpoint.lastCheck.ok ? 'reachable' : 'failed'} — ${endpoint.lastCheck.message}\n`,
    );
  }
  return tooltip;
}

/** The connections a user has configured, listed so they can be corrected rather than recreated. */
export class ConnectionsTreeDataProvider
  implements vscode.TreeDataProvider<ConnectionNode>, vscode.Disposable
{
  private readonly changeEmitter = new vscode.EventEmitter<ConnectionNode | undefined>();
  private data: ConnectionsViewData | undefined;

  readonly onDidChangeTreeData = this.changeEmitter.event;

  setData(data: ConnectionsViewData): void {
    this.data = data;
    void vscode.commands.executeCommand(
      'setContext',
      HAS_CONNECTIONS_CONTEXT_KEY,
      Object.keys(data.state.endpoints).length > 0,
    );
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(element: ConnectionNode): vscode.TreeItem {
    const { endpoint } = element;
    const hasToken = this.data?.withToken.includes(endpoint.name) ?? false;
    const item = new vscode.TreeItem(endpoint.name, vscode.TreeItemCollapsibleState.None);

    item.id = `connection:${endpoint.name}`;
    item.description = describeConnection(endpoint, hasToken);
    item.tooltip = connectionTooltip(endpoint, hasToken);
    item.iconPath = new vscode.ThemeIcon(
      hasToken ? (endpoint.kind === 'jira' ? 'checklist' : 'repo') : 'warning',
    );
    // The menus key on the kind, so a repository-only action cannot appear on a tracker.
    item.contextValue = `rounds.connection.${endpoint.kind}`;
    return item;
  }

  getChildren(element?: ConnectionNode): ConnectionNode[] {
    if (element || !this.data) {
      return [];
    }
    return Object.values(this.data.state.endpoints)
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((endpoint): ConnectionNode => ({ kind: 'connection', endpoint }));
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

/** Registers the connections view. */
export function registerConnectionsView(
  context: vscode.ExtensionContext,
): ConnectionsTreeDataProvider {
  const provider = new ConnectionsTreeDataProvider();
  context.subscriptions.push(
    provider,
    vscode.window.registerTreeDataProvider(CONNECTIONS_VIEW_ID, provider),
  );
  void vscode.commands.executeCommand('setContext', HAS_CONNECTIONS_CONTEXT_KEY, false);
  return provider;
}
