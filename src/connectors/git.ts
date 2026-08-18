import { ConfigError } from './errors.js';
import type { HttpClient } from './http.js';
import { byUpdatedAtDescending, itemsAfterCursor, newestCursor } from './items.js';
import type { FetchResult, SourceItem } from './items.js';

/** Which pull requests an agent is interested in. */
export type GitMode = 'newPullRequests' | 'updatedPullRequests';

export interface ListPullRequestsRequest {
  /** Owner on GitHub, workspace on Bitbucket Cloud, project key on a self-hosted Bitbucket. */
  project: string;
  /** The repository itself, without the half in front of it. */
  repo: string;
  mode: GitMode;
  /** ISO timestamp of the newest item already processed. */
  cursor?: string;
  maxResults?: number;
}

export interface DiffResult {
  text: string;
  truncated: boolean;
}

/**
 * The port every repository host implementation fills.
 *
 * Kept deliberately small and free of provider vocabulary: adding a second host means adding
 * a file that implements this, not touching the runner, the scheduler or the wizard.
 */
export interface RepositoryHostConnector {
  ping(): Promise<void>;
  listPullRequests(request: ListPullRequestsRequest): Promise<FetchResult>;
  getDiff(project: string, repo: string, id: string, maxChars?: number): Promise<DiffResult>;
}

interface PullRequestResponse {
  number?: number;
  title?: string;
  body?: string | null;
  state?: string;
  draft?: boolean;
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  user?: { login?: string };
  head?: { ref?: string };
  base?: { ref?: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

const DEFAULT_MAX_RESULTS = 25;
const DEFAULT_DIFF_LIMIT = 60_000;

/**
 * Splits `owner/name`.
 *
 * Since schema version 2 an agent stores the halves separately, so this exists for one caller:
 * reading a value written by version 1. Nothing at run time builds a URL out of a split string.
 */
export function parseRepo(repo: string): { owner: string; name: string } {
  const parts = repo.trim().replace(/^\/+|\/+$/g, '').split('/');
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new ConfigError(
      `"${repo}" is not a repository name. Use the owner and the repository, for example octo/rounds.`,
    );
  }
  return { owner: parts[0] as string, name: parts[1] as string };
}

/**
 * Turns one pull request into the shared item shape.
 *
 * `updatedAt` carries the timestamp the agent's mode cares about — creation time for new
 * pull requests, last change for updated ones — so the cursor logic stays the same for both
 * modes. Both timestamps are kept in `extra` for the prompt.
 */
export function toPullRequestItem(
  pullRequest: PullRequestResponse,
  repo: string,
  browseBaseUrl: string,
  mode: GitMode,
): SourceItem {
  if (pullRequest.number === undefined) {
    throw new ConfigError(
      'The repository host returned a pull request without a number. Check that the base URL points at the API root.',
      JSON.stringify(pullRequest).slice(0, 300),
    );
  }
  const createdAt = pullRequest.created_at ?? '';
  const updatedAt = pullRequest.updated_at ?? createdAt;
  return {
    id: String(pullRequest.number),
    title: pullRequest.title ?? `Pull request ${pullRequest.number}`,
    url: `${browseBaseUrl.replace(/\/+$/, '')}/${repo}/pull/${pullRequest.number}`,
    updatedAt: mode === 'newPullRequests' ? createdAt : updatedAt,
    body: pullRequest.body ?? undefined,
    extra: {
      repo,
      state: pullRequest.state,
      draft: pullRequest.draft === true ? 'yes' : 'no',
      author: pullRequest.user?.login,
      sourceBranch: pullRequest.head?.ref,
      targetBranch: pullRequest.base?.ref,
      createdAt,
      updatedAt,
      mergedAt: pullRequest.merged_at ?? undefined,
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      changedFiles: pullRequest.changed_files,
    },
  };
}

export interface GitConnectorOptions {
  http: HttpClient;
  /** Host root used to build pull request links, without the API path. */
  browseBaseUrl: string;
  diffLimit?: number;
}

/**
 * Reads pull requests over a REST API of the widely used shape.
 *
 * One implementation covers both the hosted service and self-hosted installations, because
 * the base URL is configuration rather than something baked in.
 */
export class RestGitConnector implements RepositoryHostConnector {
  constructor(private readonly options: GitConnectorOptions) {}

  async ping(): Promise<void> {
    await this.options.http.requestJson({ path: 'user' });
  }

  async listPullRequests(request: ListPullRequestsRequest): Promise<FetchResult> {
    const maxResults = request.maxResults ?? DEFAULT_MAX_RESULTS;

    const response = await this.options.http.requestJson<PullRequestResponse[]>({
      path: `repos/${encodeURIComponent(request.project)}/${encodeURIComponent(request.repo)}/pulls`,
      query: {
        state: 'all',
        sort: request.mode === 'newPullRequests' ? 'created' : 'updated',
        direction: 'desc',
        per_page: Math.min(100, maxResults),
      },
    });
    if (!Array.isArray(response)) {
      throw new ConfigError(
        'The repository host did not return a list of pull requests. Check that the base URL points at the API root.',
      );
    }

    const all = response.map((pullRequest) =>
      toPullRequestItem(
        pullRequest,
        `${request.project}/${request.repo}`,
        this.options.browseBaseUrl,
        request.mode,
      ),
    );
    const fresh = itemsAfterCursor(all, request.cursor).sort(byUpdatedAtDescending);
    const items = fresh.slice(0, maxResults);

    return {
      items,
      truncated: fresh.length > items.length,
      // Returned rather than stored: only a successful run may advance the cursor, otherwise
      // a failure would skip exactly the items it never looked at.
      cursor: newestCursor(items, request.cursor),
    };
  }

  async getDiff(project: string, repo: string, id: string, maxChars?: number): Promise<DiffResult> {
    const limit = maxChars ?? this.options.diffLimit ?? DEFAULT_DIFF_LIMIT;
    const text = await this.options.http.requestText({
      path: `repos/${encodeURIComponent(project)}/${encodeURIComponent(repo)}/pulls/${encodeURIComponent(id)}`,
      headers: { Accept: 'application/vnd.github.diff' },
    });

    if (text.length <= limit) {
      return { text, truncated: false };
    }
    return {
      text: `${text.slice(0, limit)}\n\n[truncated: ${limit} of ${text.length} characters shown]`,
      truncated: true,
    };
  }
}
