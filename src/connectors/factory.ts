import type { RoundsSecrets, SecretName } from '../state/secrets.js';
import type { StoreLogger } from '../state/store.js';
import type { AgentSource, EndpointConfig, GitProvider, SourceKind } from '../state/types.js';

import { BitbucketCloudConnector } from './bitbucketCloud.js';
import { BitbucketServerConnector } from './bitbucketServer.js';
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

  const host = hostOf(endpoint);
  const provider = resolveProvider(endpoint);
  if (provider === 'bitbucketCloud') {
    return host.endsWith('bitbucket.org') ? 'https://api.bitbucket.org/2.0/' : `${trimmed}/2.0/`;
  }
  if (provider === 'bitbucketServer') {
    // A self-hosted installation serves its own REST version from its own host, and may sit under a
    // context path (`https://tools.example/bitbucket`), so the path is appended rather than replaced.
    return trimmed.endsWith('/rest/api/1.0') ? `${trimmed}/` : `${trimmed}/rest/api/1.0/`;
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
      `${host} is not supported yet. Rounds speaks the GitHub API (github.com and GitHub Enterprise Server) and the Bitbucket APIs (Bitbucket Cloud and self-hosted Bitbucket). Support for another host means adding a connector; see CONTRIBUTING.md.`,
    );
  }
  // A self-hosted installation of the supported kind.
  return `${trimmed}/api/v3/`;
}

function hostOf(endpoint: EndpointConfig): string {
  try {
    return new URL(endpoint.baseUrl.replace(/\/+$/, '')).host.toLowerCase();
  } catch {
    throw new ConfigError(`"${endpoint.baseUrl}" is not a valid base URL.`);
  }
}

/**
 * Which API a repository host speaks.
 *
 * The stored value wins, because a self-hosted installation cannot be recognised from its address.
 * Otherwise the host says it: bitbucket.org is Bitbucket Cloud, anything else is assumed to speak the
 * GitHub API, which is what a self-hosted enterprise installation does.
 */
export function resolveProvider(endpoint: EndpointConfig): GitProvider {
  if (endpoint.provider) {
    return endpoint.provider;
  }
  return providerFromHost(endpoint.baseUrl) ?? 'github';
}

const BITBUCKET_CLOUD = /(^|\.)bitbucket\.org$/;
const BITBUCKET_SERVER = /^.*(bitbucket|stash).*$/;
const GITHUB_HOSTS = new Set(['github.com', 'www.github.com', 'api.github.com']);

/**
 * The provider the address itself announces, or `undefined` when it announces nothing.
 *
 * The wizard uses the `undefined` case to decide whether to ask: a self-hosted installation can be
 * either, and guessing wrong sends every request to paths the host has never heard of.
 */
export function providerFromHost(baseUrl: string): GitProvider | undefined {
  let host: string;
  try {
    host = new URL(baseUrl.trim().replace(/\/+$/, '')).host.toLowerCase();
  } catch {
    return undefined;
  }
  if (BITBUCKET_CLOUD.test(host)) {
    return 'bitbucketCloud';
  }
  if (BITBUCKET_SERVER.test(host)) {
    return 'bitbucketServer';
  }
  return GITHUB_HOSTS.has(host) ? 'github' : undefined;
}

/** Hosts whose API is a different shape entirely, recognised so the message can say so. */
const UNSUPPORTED_HOSTS = [
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
    const http = await this.httpFor(endpoint);
    switch (resolveProvider(endpoint)) {
      case 'bitbucketCloud':
        return new BitbucketCloudConnector({ http, browseBaseUrl: endpoint.baseUrl });
      case 'bitbucketServer':
        return new BitbucketServerConnector({ http, browseBaseUrl: endpoint.baseUrl });
      default:
        return new RestGitConnector({ http, browseBaseUrl: endpoint.baseUrl });
    }
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
