import type { RoundsSecrets, SecretName } from '../state/secrets.js';
import type { StoreLogger } from '../state/store.js';
import type { AgentSource, EndpointConfig, SourceKind } from '../state/types.js';

import { ConfigError } from './errors.js';
import { RestGitConnector } from './git.js';
import type { RepositoryHostConnector } from './git.js';
import { HttpClient } from './http.js';
import type { FetchLike } from './http.js';
import { JiraConnector } from './jira.js';
import type { IssueTrackerConnector } from './jira.js';

const SECRET_BY_KIND: Record<SourceKind, SecretName> = {
  jira: 'jiraToken',
  git: 'gitToken',
};

/**
 * Where the API lives, given what the user typed as the base URL.
 *
 * The hosted service and a self-hosted installation do not agree on this. github.com serves its API
 * from a different host entirely (`api.github.com`), while an enterprise installation serves it from
 * `/api/v3/` under its own host. Appending the enterprise path to github.com produces
 * `https://github.com/api/v3/...`, which is a 404 that reads as "you typed the repository wrong" —
 * exactly the wrong thing to tell somebody who typed it correctly.
 */
export function resolveApiRoot(endpoint: EndpointConfig): string {
  const trimmed = endpoint.baseUrl.replace(/\/+$/, '');
  if (endpoint.kind === 'jira') {
    return `${trimmed}/rest/api/2/`;
  }

  let host: string;
  try {
    host = new URL(trimmed).host.toLowerCase();
  } catch {
    throw new ConfigError(`"${endpoint.baseUrl}" is not a valid base URL.`);
  }

  if (host === 'github.com' || host === 'www.github.com') {
    return 'https://api.github.com/';
  }
  if (host === 'api.github.com' || host.startsWith('api.')) {
    // Already pointed at an API root.
    return `${trimmed}/`;
  }
  if (UNSUPPORTED_HOSTS.some((pattern) => pattern.test(host))) {
    throw new ConfigError(
      `${host} is not supported yet. Rounds speaks the GitHub REST API, so it works with github.com and with GitHub Enterprise Server installations. Support for other hosts means adding a connector; see CONTRIBUTING.md.`,
    );
  }
  // A self-hosted installation of the supported kind.
  return `${trimmed}/api/v3/`;
}

/** Hosts whose API is a different shape entirely, recognised so the message can say so. */
const UNSUPPORTED_HOSTS = [
  /(^|\.)bitbucket\.org$/,
  /(^|\.)gitlab\.com$/,
  /(^|\.)dev\.azure\.com$/,
  /(^|\.)visualstudio\.com$/,
  /(^|\.)gitea\./,
  /(^|\.)codeberg\.org$/,
];

export interface ConnectorFactoryOptions {
  secrets: RoundsSecrets;
  endpoints: Record<string, EndpointConfig>;
  logger?: StoreLogger;
  fetch?: FetchLike;
  userAgent?: string;
}

/** Resolves the endpoint an agent points at, or explains what is missing. */
export function resolveEndpoint(
  endpoints: Record<string, EndpointConfig>,
  source: Pick<AgentSource, 'kind' | 'baseUrlRef'>,
): EndpointConfig {
  const endpoint = endpoints[source.baseUrlRef];
  if (!endpoint) {
    throw new ConfigError(
      `This agent uses the connection "${source.baseUrlRef}", which is not configured. Run Check Setup to add its base URL.`,
    );
  }
  if (endpoint.kind !== source.kind) {
    throw new ConfigError(
      `The connection "${source.baseUrlRef}" is configured for a different kind of source. Edit the agent or reconfigure the connection.`,
    );
  }
  return endpoint;
}

/**
 * Builds the authorization header for an endpoint.
 *
 * Basic authentication carries the token as the password next to a user name; bearer sends it
 * on its own. Which one applies is stored configuration, never guessed from the URL: guessing
 * produces a confusing 401 on exactly the installations that are hardest to debug.
 */
export function authorizationHeader(endpoint: EndpointConfig, token: string): string {
  if (endpoint.authScheme === 'basic') {
    if (!endpoint.username) {
      throw new ConfigError(
        `The connection "${endpoint.name}" uses basic authentication but has no user name. Reconfigure it in Check Setup.`,
      );
    }
    const encoded = Buffer.from(`${endpoint.username}:${token}`, 'utf8').toString('base64');
    return `Basic ${encoded}`;
  }
  return `Bearer ${token}`;
}

/**
 * Creates connectors for agents.
 *
 * This is where the three pieces meet: the endpoint from the state, the token from secret
 * storage, and the HTTP client that refuses to talk to any other host. Nothing above this
 * layer ever sees a token.
 */
export class ConnectorFactory {
  constructor(private readonly options: ConnectorFactoryOptions) {}

  private async httpFor(endpoint: EndpointConfig): Promise<HttpClient> {
    const secretName = SECRET_BY_KIND[endpoint.kind];
    const token = await this.options.secrets.get(secretName);
    if (!token) {
      throw new ConfigError(
        `No token is stored for the ${endpoint.kind === 'jira' ? 'issue tracker' : 'repository host'}. Run Check Setup to enter one.`,
      );
    }
    return new HttpClient({
      baseUrl: resolveApiRoot(endpoint),
      headers: { Authorization: authorizationHeader(endpoint, token) },
      fetch: this.options.fetch,
      logger: this.options.logger,
      userAgent: this.options.userAgent,
    });
  }

  async createIssueTracker(endpoint: EndpointConfig): Promise<IssueTrackerConnector> {
    if (endpoint.kind !== 'jira') {
      throw new ConfigError(`The connection "${endpoint.name}" is not an issue tracker.`);
    }
    return new JiraConnector({
      http: await this.httpFor(endpoint),
      browseBaseUrl: endpoint.baseUrl,
    });
  }

  async createRepositoryHost(endpoint: EndpointConfig): Promise<RepositoryHostConnector> {
    if (endpoint.kind !== 'git') {
      throw new ConfigError(`The connection "${endpoint.name}" is not a repository host.`);
    }
    return new RestGitConnector({
      http: await this.httpFor(endpoint),
      browseBaseUrl: endpoint.baseUrl,
    });
  }

  /** Reachability test used by the setup check. Never throws; it reports. */
  async ping(endpoint: EndpointConfig): Promise<{ ok: boolean; message: string }> {
    try {
      if (endpoint.kind === 'jira') {
        await (await this.createIssueTracker(endpoint)).ping();
      } else {
        await (await this.createRepositoryHost(endpoint)).ping();
      }
      return { ok: true, message: `${endpoint.baseUrl} answered.` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.logger?.warn(`Ping to ${endpoint.name} failed: ${message}`);
      return { ok: false, message };
    }
  }

  /** Convenience for the runner: resolve the endpoint an agent points at and connect. */
  async forSource(source: AgentSource): Promise<{
    endpoint: EndpointConfig;
    tracker?: IssueTrackerConnector;
    repositoryHost?: RepositoryHostConnector;
  }> {
    const endpoint = resolveEndpoint(this.options.endpoints, source);
    if (source.kind === 'jira') {
      return { endpoint, tracker: await this.createIssueTracker(endpoint) };
    }
    return { endpoint, repositoryHost: await this.createRepositoryHost(endpoint) };
  }
}
