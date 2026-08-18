import { ConfigError } from './errors.js';
import type {
  DiffResult,
  GitMode,
  ListPullRequestsRequest,
  NamedEntry,
  RepositoryHostConnector,
} from './git.js';
import type { HttpClient } from './http.js';
import { byUpdatedAtDescending, itemsAfterCursor, newestCursor, toIsoTimestamp } from './items.js';
import type { FetchResult, SourceItem } from './items.js';

export interface BitbucketCloudPullRequest {
  id?: number;
  title?: string;
  summary?: { raw?: string };
  state?: string;
  created_on?: string;
  updated_on?: string;
  author?: { display_name?: string; nickname?: string };
  source?: { branch?: { name?: string } };
  destination?: { branch?: { name?: string } };
  links?: { html?: { href?: string }; diff?: { href?: string } };
  comment_count?: number;
  task_count?: number;
}

interface BitbucketPage {
  values?: BitbucketCloudPullRequest[];
  size?: number;
  next?: string;
}

const DEFAULT_MAX_RESULTS = 25;
const DEFAULT_DIFF_LIMIT = 60_000;

/** Every state, since an agent may care about merged or declined work as much as open work. */
const ALL_STATES = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'];

/** Turns one pull request into the shared item shape. */
export function toBitbucketCloudItem(
  pullRequest: BitbucketCloudPullRequest,
  repo: string,
  browseBaseUrl: string,
  mode: GitMode,
): SourceItem {
  if (pullRequest.id === undefined) {
    throw new ConfigError(
      'The repository host returned a pull request without an id. Check that the base URL points at the API root.',
      JSON.stringify(pullRequest).slice(0, 300),
    );
  }
  // Bitbucket sends six fractional digits and an explicit offset; the cursor compares strings.
  const createdAt = toIsoTimestamp(pullRequest.created_on);
  const updatedAt = toIsoTimestamp(pullRequest.updated_on) || createdAt;

  return {
    id: String(pullRequest.id),
    title: pullRequest.title ?? `Pull request ${pullRequest.id}`,
    // Built from the configured host rather than from the link in the payload, for the same reason as
    // everywhere else: a URL a response chose is not a URL to trust.
    url: `${browseBaseUrl.replace(/\/+$/, '')}/${repo}/pull-requests/${pullRequest.id}`,
    updatedAt: mode === 'newPullRequests' ? createdAt : updatedAt,
    body: pullRequest.summary?.raw ?? undefined,
    extra: {
      repo,
      state: pullRequest.state,
      author: pullRequest.author?.display_name ?? pullRequest.author?.nickname,
      sourceBranch: pullRequest.source?.branch?.name,
      targetBranch: pullRequest.destination?.branch?.name,
      createdAt,
      updatedAt,
      comments: pullRequest.comment_count,
      openTasks: pullRequest.task_count,
    },
  };
}

export interface BitbucketCloudConnectorOptions {
  http: HttpClient;
  /** Host root used to build pull request links, without the API path. */
  browseBaseUrl: string;
  diffLimit?: number;
}

/**
 * Reads pull requests from Bitbucket Cloud.
 *
 * A second implementation of the same port rather than a special case inside the first: the two APIs
 * agree on almost nothing — different paths, different payload shapes, different pagination, states
 * expressed as repeated query parameters — and the only thing they have in common is what this
 * extension needs out of them, which is exactly what the port describes.
 */
export class BitbucketCloudConnector implements RepositoryHostConnector {
  constructor(private readonly options: BitbucketCloudConnectorOptions) {}

  async ping(): Promise<void> {
    await this.options.http.requestJson({ path: 'user' });
  }

  async listPullRequests(request: ListPullRequestsRequest): Promise<FetchResult> {
    const maxResults = request.maxResults ?? DEFAULT_MAX_RESULTS;

    const page = await this.options.http.requestJson<BitbucketPage>({
      path: `repositories/${encodeURIComponent(request.project)}/${encodeURIComponent(request.repo)}/pullrequests`,
      query: {
        state: ALL_STATES,
        sort: request.mode === 'newPullRequests' ? '-created_on' : '-updated_on',
        pagelen: Math.min(50, maxResults),
      },
    });
    if (!Array.isArray(page?.values)) {
      throw new ConfigError(
        'Bitbucket did not return a list of pull requests. Check that the base URL points at the API root.',
      );
    }

    const all = page.values.map((pullRequest) =>
      toBitbucketCloudItem(
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
      truncated: fresh.length > items.length || page.next !== undefined,
      cursor: newestCursor(items, request.cursor),
    };
  }

  /** The workspaces this account belongs to. */
  async listProjects(): Promise<NamedEntry[]> {
    const page = await this.options.http.requestJson<{
      values?: { slug?: string; name?: string }[];
    }>({ path: 'workspaces', query: { pagelen: 100 } });
    return (page?.values ?? [])
      .filter((entry) => typeof entry.slug === 'string')
      .map((entry) => ({ id: entry.slug as string, name: entry.name }));
  }

  async listRepositories(project: string): Promise<NamedEntry[]> {
    const page = await this.options.http.requestJson<{ values?: { slug?: string; name?: string }[] }>({
      path: `repositories/${encodeURIComponent(project)}`,
      query: { pagelen: 100, sort: '-updated_on' },
    });
    return (page?.values ?? [])
      .filter((entry) => typeof entry.slug === 'string')
      .map((entry) => ({ id: entry.slug as string, name: entry.name }));
  }

  async getDiff(project: string, repo: string, id: string, maxChars?: number): Promise<DiffResult> {
    const limit = maxChars ?? this.options.diffLimit ?? DEFAULT_DIFF_LIMIT;

    let text: string;
    try {
      text = await this.options.http.requestText({
        path: `repositories/${encodeURIComponent(project)}/${encodeURIComponent(repo)}/pullrequests/${encodeURIComponent(id)}/diff`,
        headers: { Accept: 'text/plain' },
      });
    } catch (error) {
      // Bitbucket answers this endpoint with a redirect to wherever the diff is actually stored, and
      // the client refuses redirects on purpose — following one is how a request to an allowed host
      // ends up somewhere else carrying the token. A missing diff is worth a note, not a failed run.
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
}
