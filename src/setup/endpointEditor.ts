import * as vscode from 'vscode';

import { providerFromHost } from '../connectors/factory.js';
import type { RoundsSecrets, SecretName } from '../state/secrets.js';
import type { RoundsStore } from '../state/store.js';
import type { AuthScheme, EndpointConfig, GitProvider, SourceKind } from '../state/types.js';

const SECRET_BY_KIND: Record<SourceKind, SecretName> = {
  jira: 'jiraToken',
  git: 'gitToken',
};

const KIND_LABEL: Record<SourceKind, string> = {
  jira: 'issue tracker',
  git: 'repository host',
};

/** Rejects anything that is not an absolute http(s) URL, before it reaches a request. */
export function validateBaseUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return 'Enter a base URL.';
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return 'Enter a full URL, for example https://example.com.';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only http and https URLs are supported.';
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return 'Do not put credentials in the URL; the token is stored separately.';
  }
  return undefined;
}

/** Asks for a base URL and stores it as a named endpoint. */
export async function addOrUpdateEndpoint(
  store: RoundsStore,
  kind: SourceKind,
): Promise<EndpointConfig | undefined> {
  const baseUrl = await vscode.window.showInputBox({
    title: `Base URL of the ${KIND_LABEL[kind]}`,
    prompt: 'For example https://example.atlassian.net or https://git.example.com',
    ignoreFocusOut: true,
    validateInput: validateBaseUrl,
  });
  if (!baseUrl) {
    return undefined;
  }

  // github.com and bitbucket.org say which API they speak; a self-hosted installation does not, and
  // guessing sends every request to paths that host has never heard of.
  let provider: GitProvider | undefined;
  if (kind === 'git') {
    provider = providerFromHost(baseUrl);
    if (!provider) {
      const providers: { label: string; description: string; value: GitProvider }[] = [
        {
          label: 'GitHub Enterprise Server',
          description: 'Or any host that serves the same API under /api/v3.',
          value: 'github',
        },
        {
          label: 'Bitbucket, self-hosted',
          description: 'Data Center or Server: REST 1.0 under /rest/api/1.0, with project keys.',
          value: 'bitbucketServer',
        },
        {
          label: 'Bitbucket Cloud',
          description: 'Only for a host that mirrors the bitbucket.org API.',
          value: 'bitbucketCloud',
        },
      ];
      const chosen = await vscode.window.showQuickPick(providers, {
        title: 'Which API does this host speak?',
        ignoreFocusOut: true,
      });
      if (!chosen) {
        return undefined;
      }
      provider = chosen.value;
    }
  }

  const schemes: { label: string; description: string; value: AuthScheme }[] = [
    {
      label: 'Token only',
      description: 'Sent as a bearer token. Usual for self-hosted installations.',
      value: 'bearer',
    },
    {
      label: 'User name and token',
      description: 'Sent as basic authentication. Usual for hosted issue trackers.',
      value: 'basic',
    },
  ];
  const scheme = await vscode.window.showQuickPick(schemes, {
    title: 'How does this host authenticate?',
    ignoreFocusOut: true,
  });
  if (!scheme) {
    return undefined;
  }

  let username: string | undefined;
  if (scheme.value === 'basic') {
    username = await vscode.window.showInputBox({
      title: 'User name or email address for this host',
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? 'Enter a user name.' : undefined),
    });
    if (!username) {
      return undefined;
    }
  }

  const suggestedName = new URL(baseUrl.trim()).hostname;
  const name = await vscode.window.showInputBox({
    title: 'Name for this connection',
    prompt: 'Agents reference the connection by this name.',
    value: suggestedName,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? 'Enter a name.' : undefined),
  });
  if (!name) {
    return undefined;
  }

  const endpoint: EndpointConfig = {
    name: name.trim(),
    kind,
    baseUrl: baseUrl.trim().replace(/\/+$/, ''),
    authScheme: scheme.value,
    username: username?.trim(),
    provider,
  };
  await store.update((draft) => {
    draft.endpoints[endpoint.name] = endpoint;
  });
  return endpoint;
}

/**
 * Adds a connection and asks for its token in the same breath.
 *
 * Reported from a real setup: configuring a host and entering its token were two separate items in
 * two separate places, so a host looked configured while nothing could authenticate. They are one
 * decision, so they are one flow; an existing token is reused rather than asked for again.
 */
export async function addConnection(
  store: RoundsStore,
  secrets: RoundsSecrets,
  kind: SourceKind,
): Promise<EndpointConfig | undefined> {
  const endpoint = await addOrUpdateEndpoint(store, kind);
  if (!endpoint) {
    return undefined;
  }
  if (await secrets.has(SECRET_BY_KIND[kind])) {
    return endpoint;
  }
  return (await enterToken(secrets, kind)) ? endpoint : undefined;
}

/** Asks for a token and puts it in secret storage. Nothing else ever sees it. */
export async function enterToken(secrets: RoundsSecrets, kind: SourceKind): Promise<boolean> {
  const token = await vscode.window.showInputBox({
    title: `Token for the ${KIND_LABEL[kind]}`,
    prompt: 'Stored in the editor secret storage, never in settings or in a result file.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? 'Enter a token.' : undefined),
  });
  if (!token) {
    return false;
  }
  await secrets.set(SECRET_BY_KIND[kind], token.trim());
  return true;
}

/** Removes a stored connection, leaving agents that reference it to report it as missing. */
export async function removeEndpoint(store: RoundsStore, name: string): Promise<void> {
  await store.update((draft) => {
    delete draft.endpoints[name];
  });
}

export { SECRET_BY_KIND };
