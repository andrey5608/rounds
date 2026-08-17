import { ConfigError } from './errors.js';
import { parseRepo } from './git.js';
import type { DiffResult, GitMode, ListPullRequestsRequest, RepositoryHostConnector } from './git.js';
import type { HttpClient } from './http.js';
import { byUpdatedAtDescending, itemsAfterCursor, newestCursor, toIsoTimestamp } from './items.js';
import type { FetchResult, SourceItem } from './items.js';

export interface BitbucketServerPullRequest {
  id?: number;
  title?: string;
  description?: string;
  state?: string;
  /** Epoch milliseconds, not a string. */
  createdDate?: number;
  updatedDate?: number;
  author?: { user?: { displayName?: string; name?: string; slug?: string } };
  fromRef?: { displayId?: string };
  toRef?: { displayId?: string };
  properties?: { commentCount?: number; openTaskCount?: number };
}

interface BitbucketServerPage {
  values?: BitbucketServerPullRequest[];
  size?: number;
  isLastPage?: boolean;
}

const DEFAULT_MAX_RESULTS = 25;
const DEFAULT_DIFF_LIMIT = 60_000;

/**
 * Where a repository is browsed on a self-hosted installation.
 *
 * A personal repository lives under `/users/<name>`, everything else under `/projects/<KEY>`, and the
 * owner segment says which: the API accepts `~name` for a personal project.
 */
export function browsePath(owner: string, name: string): string {
  const area = owner.startsWith('~')
    ? `users/${encodeURIComponent(owner.slice(1))}`
    : `projects/${encodeURIComponent(owner)}`;
  return `${area}/repos/${encodeURIComponent(name)}`;
}

/** Turns one pull request into the shared item shape. */
export function toBitbucketServerItem(
  pullRequest: BitbucketServerPullRequest,
  repo: string,
  browseBaseUrl: string,
  mode: GitMode,
): SourceItem {
  if (pullRequest.id === undefined) {
    throw new ConfigError(
      'The repository host returned a pull request without an id. Check that the base URL points at the host root.',
      JSON.stringify(pullRequest).slice(0, 300),
    );
  }
  const { owner, name } = parseRepo(repo);
  const createdAt = toIsoTimestamp(pullRequest.createdDate);
  const updatedAt = toIsoTimestamp(pullRequest.updatedDate) || createdAt;

  return {
    id: String(pullRequest.id),
    title: pullRequest.title ?? `Pull request ${pullRequest.id}`,
    url: `${browseBaseUrl.replace(/\/+$/, '')}/${browsePath(owner, name)}/pull-requests/${pullRequest.id}`,
    updatedAt: mode === 'newPullRequests' ? createdAt : updatedAt,
    body: pullRequest.description ?? undefined,
    extra: {
      repo,
      state: pullRequest.state,
      author: pullRequest.author?.user?.displayName ?? pullRequest.author?.user?.name,
      sourceBranch: pullRequest.fromRef?.displayId,
      targetBranch: pullRequest.toRef?.displayId,
      createdAt,
      updatedAt,
      comments: pullRequest.properties?.commentCount,
      openTasks: pullRequest.properties?.openTaskCount,
    },
  };
}

export interface BitbucketServerConnectorOptions {
  http: HttpClient;
  /** Host root used to build pull request links, without the API path. */
  browseBaseUrl: string;
  diffLimit?: number;
}

/**
 * Reads pull requests from a self-hosted Bitbucket installation.
 *
 * It shares a name with the hosted service and almost nothing else: REST 1.0 instead of 2.0, a project
 * key instead of a workspace, `description` instead of `summary.raw`, epoch milliseconds instead of
 * timestamps, `isLastPage` instead of a link to the next page, and no sort by change time at all. That
 * is why it is a third implementation of the port rather than a flag on the second one.
 */
export class BitbucketServerConnector implements RepositoryHostConnector {
  constructor(private readonly options: BitbucketServerConnectorOptions) {}

  async ping(): Promise<void> {
    // Scoped to whoever the token belongs to, so it proves the credential rather than the host being
    // up: an anonymous request gets 401 instead of a cheerful empty page.
    await this.options.http.requestJson({ path: 'profile/recent/repos', query: { limit: 1 } });
  }

  async listPullRequests(request: ListPullRequestsRequest): Promise<FetchResult> {
    const { owner, name } = parseRepo(request.repo);
    const maxResults = request.maxResults ?? DEFAULT_MAX_RESULTS;

    const page = await this.options.http.requestJson<BitbucketServerPage>({
      path: `${this.repositoryPath(owner, name)}/pull-requests`,
      query: {
        state: 'ALL',
        // The only orders this API offers are by creation time; ordering by change time is done here,
        // over a page that is deliberately larger than what the agent asked for.
        order: 'NEWEST',
        limit: Math.min(100, Math.max(maxResults, 25)),
      },
    });
    if (!Array.isArray(page?.values)) {
      throw new ConfigError(
        'The repository host did not return a list of pull requests. Check that the base URL points at the host root, without the REST path.',
      );
    }

    const all = page.values.map((pullRequest) =>
      toBitbucketServerItem(pullRequest, request.repo, this.options.browseBaseUrl, request.mode),
    );
    const fresh = itemsAfterCursor(all, request.cursor).sort(byUpdatedAtDescending);
    const items = fresh.slice(0, maxResults);

    return {
      items,
      truncated: fresh.length > items.length || page.isLastPage === false,
      cursor: newestCursor(items, request.cursor),
    };
  }

  async getDiff(repo: string, id: string, maxChars?: number): Promise<DiffResult> {
    const { owner, name } = parseRepo(repo);
    const limit = maxChars ?? this.options.diffLimit ?? DEFAULT_DIFF_LIMIT;

    let text: string;
    try {
      // The `.diff` form answers with a unified diff; the plain `/diff` path answers with the host's
      // own JSON model of it, which is far larger and no more useful to a prompt.
      text = await this.options.http.requestText({
        path: `${this.repositoryPath(owner, name)}/pull-requests/${encodeURIComponent(id)}.diff`,
        headers: { Accept: 'text/plain' },
      });
    } catch (error) {
      // One missing diff is worth a line in the result; it is not worth losing the pull requests that
      // were fetched successfully.
      return {
        text: `(the diff could not be fetched: ${error instanceof Error ? error.message : String(error)})`,
        truncated: false,
      };
    }

    if (text.length <= limit) {
      return { text, truncated: false };
    }
    return {
      text: `${text.slice(0, limit)}\n\n[truncated: ${limit} of ${text.length} characters shown]`,
      truncated: true,
    };
  }

  private repositoryPath(owner: string, name: string): string {
    const project = owner.startsWith('~')
      ? `~${encodeURIComponent(owner.slice(1))}`
      : encodeURIComponent(owner);
    return `projects/${project}/repos/${encodeURIComponent(name)}`;
  }
}
