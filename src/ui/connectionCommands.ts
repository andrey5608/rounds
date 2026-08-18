import { randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import { ConnectorFactory } from '../connectors/factory.js';
import type { ServiceContainer } from '../container.js';
import { askConnectionDetails } from '../setup/endpointEditor.js';
import type { EndpointConfig, SourceKind } from '../state/types.js';

import { refreshView } from './viewState.js';

/** Pulls the connection out of a tree item argument, or asks which one. */
async function resolveConnection(
  container: ServiceContainer,
  argument: unknown,
  title: string,
): Promise<EndpointConfig | undefined> {
  if (argument && typeof argument === 'object') {
    if ('endpoint' in argument) {
      return (argument as { endpoint: EndpointConfig }).endpoint;
    }
    if ('name' in argument && 'baseUrl' in argument) {
      return argument as EndpointConfig;
    }
  }

  const state = await container.store.read();
  const connections = Object.values(state.endpoints);
  if (connections.length === 0) {
    return undefined;
  }
  if (connections.length === 1) {
    return connections[0];
  }
  const picked = await vscode.window.showQuickPick(
    connections.map((endpoint) => ({
      label: endpoint.name,
      description: endpoint.baseUrl,
      endpoint,
    })),
    { title, ignoreFocusOut: true },
  );
  return picked?.endpoint;
}

/** `rounds.addConnection`: base URL, authentication, name, token, then a reachability check. */
export async function addConnectionCommand(container: ServiceContainer): Promise<void> {
  const kind = await askKind();
  if (!kind) {
    return;
  }
  const state = await container.store.read();
  const details = await askConnectionDetails(kind, { existing: Object.values(state.endpoints) });
  if (!details) {
    return;
  }

  const endpoint: EndpointConfig = { ...details, secretRef: randomUUID() };
  const token = await askToken(endpoint.name);
  if (token) {
    await container.secrets.setForConnection(endpoint.secretRef as string, token);
  }

  await container.store.update((draft) => {
    draft.endpoints[endpoint.name] = endpoint;
  });
  await checkConnection(container, endpoint);
  await refreshView(container);
}

/**
 * `rounds.editConnection`.
 *
 * Renaming rewrites every agent that referenced the old name in the same store update: agents
 * point at a connection by name, so a rename and the references have to move together or not
 * at all. The token moves with nothing, which is the whole reason it is keyed on `secretRef`.
 */
export async function editConnectionCommand(
  container: ServiceContainer,
  argument?: unknown,
): Promise<void> {
  const existing = await resolveConnection(container, argument, 'Which connection?');
  if (!existing) {
    return;
  }
  const state = await container.store.read();
  const details = await askConnectionDetails(existing.kind, {
    existing: Object.values(state.endpoints),
    current: existing,
  });
  if (!details) {
    return;
  }

  const updated: EndpointConfig = {
    ...details,
    secretRef: existing.secretRef ?? randomUUID(),
    lastCheck: existing.lastCheck,
  };

  await container.store.update((draft) => {
    if (updated.name !== existing.name) {
      delete draft.endpoints[existing.name];
      for (const agent of draft.agents) {
        if (agent.source.baseUrlRef === existing.name) {
          agent.source.baseUrlRef = updated.name;
        }
      }
    }
    draft.endpoints[updated.name] = updated;
  });

  const replace = await vscode.window.showQuickPick(['Keep the stored token', 'Replace the token'], {
    title: `Token for "${updated.name}"`,
    ignoreFocusOut: true,
  });
  if (replace === 'Replace the token') {
    const token = await askToken(updated.name);
    if (token && updated.secretRef) {
      await container.secrets.setForConnection(updated.secretRef, token);
    }
  }

  await checkConnection(container, updated);
  await refreshView(container);
}

/**
 * `rounds.deleteConnection`.
 *
 * Refused while an agent still points at it: silently breaking three agents to satisfy one
 * delete is not a trade anybody asked for. When nothing references it, the token goes with it —
 * unlike an agent, whose token is shared and therefore stays.
 */
export async function deleteConnectionCommand(
  container: ServiceContainer,
  argument?: unknown,
): Promise<void> {
  const endpoint = await resolveConnection(container, argument, 'Which connection to delete?');
  if (!endpoint) {
    return;
  }
  const state = await container.store.read();
  const used = state.agents.filter((agent) => agent.source.baseUrlRef === endpoint.name);
  if (used.length > 0) {
    await container.notifier.requested(
      'warning',
      `"${endpoint.name}" is still used by ${used.map((agent) => `"${agent.name}"`).join(', ')}. Point those agents somewhere else first.`,
    );
    return;
  }

  const confirmed = await vscode.window.showWarningMessage(
    `Delete the connection "${endpoint.name}"?`,
    {
      modal: true,
      detail: 'Its stored token is deleted with it. Agents and result files are not affected.',
    },
    'Delete',
  );
  if (confirmed !== 'Delete') {
    return;
  }

  if (endpoint.secretRef) {
    await container.secrets.deleteForConnection(endpoint.secretRef);
  }
  await container.store.update((draft) => {
    delete draft.endpoints[endpoint.name];
  });
  await refreshView(container);
}

async function askKind(): Promise<SourceKind | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Issue tracker', description: 'Reads issues from a search query', value: 'jira' as const },
      { label: 'Repository host', description: 'Reads pull requests', value: 'git' as const },
    ],
    { title: 'What does this connection read?', ignoreFocusOut: true },
  );
  return picked?.value;
}

async function askToken(name: string): Promise<string | undefined> {
  const token = await vscode.window.showInputBox({
    title: `Token for "${name}"`,
    prompt: 'Stored in the editor secret storage, never in settings or in a result file.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? 'Enter a token.' : undefined),
  });
  return token?.trim();
}

/** Asks the host whether it answers, and records what it said on the connection. */
async function checkConnection(
  container: ServiceContainer,
  endpoint: EndpointConfig,
): Promise<void> {
  const state = await container.store.read();
  const factory = new ConnectorFactory({
    secrets: container.secrets,
    endpoints: state.endpoints,
    logger: container.logger,
  });
  const result = await factory.ping(endpoint);
  await container.store.update((draft) => {
    const stored = draft.endpoints[endpoint.name];
    if (stored) {
      stored.lastCheck = { ...result, at: new Date().toISOString() };
    }
  });
  await container.notifier.requested(result.ok ? 'info' : 'warning', `${endpoint.name}: ${result.message}`);
}
