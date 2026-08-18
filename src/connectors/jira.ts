import { ConfigError } from './errors.js';
import type { HttpClient } from './http.js';
import { byUpdatedAtDescending } from './items.js';
import type { NamedEntry } from './git.js';
import type { FetchResult, SourceItem } from './items.js';

/** What an agent asks the issue tracker for. */
export interface JiraSearchRequest {
  jql: string;
  maxResults: number;
  /** Fetch comments too. Only set when the prompt actually references them. */
  includeComments?: boolean;
  /** Fetch issue links too. Same reasoning. */
  includeLinks?: boolean;
}

export interface IssueTrackerConnector {
  /** Cheap request that proves the base URL and the token work. */
  ping(): Promise<void>;
  search(request: JiraSearchRequest): Promise<FetchResult>;
  getIssue(key: string, options?: { includeComments?: boolean }): Promise<SourceItem>;
  /**
   * Projects this account can see, for the picker in the agent wizard.
   *
   * Only ever called when somebody opens that picker. A tracker may refuse it on permissions, and
   * the caller treats that as "type the key yourself" rather than as a failure.
   */
  listProjects(): Promise<NamedEntry[]>;
}

interface JiraIssueResponse {
  key?: string;
  self?: string;
  fields?: {
    summary?: string;
    updated?: string;
    created?: string;
    description?: unknown;
    status?: { name?: string };
    assignee?: { displayName?: string; emailAddress?: string };
    reporter?: { displayName?: string };
    priority?: { name?: string };
    issuetype?: { name?: string };
    labels?: string[];
    comment?: { comments?: { author?: { displayName?: string }; created?: string; body?: unknown }[] };
    issuelinks?: {
      type?: { name?: string };
      inwardIssue?: { key?: string; fields?: { summary?: string } };
      outwardIssue?: { key?: string; fields?: { summary?: string } };
    }[];
  };
}

interface JiraSearchResponse {
  issues?: JiraIssueResponse[];
  total?: number;
  startAt?: number;
  maxResults?: number;
}

const BASE_FIELDS = [
  'summary',
  'updated',
  'created',
  'description',
  'status',
  'assignee',
  'reporter',
  'priority',
  'issuetype',
  'labels',
];

const PAGE_SIZE = 50;

/**
 * Flattens whatever the tracker put in a text field.
 *
 * Hosted instances answer with a document tree, self-hosted ones with a plain string, and a
 * prompt wants neither shape — it wants the text. Paragraphs and list items keep their line
 * break, so the result reads as paragraphs rather than one run-on line.
 */
export function flattenRichText(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(flattenRichText).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    const node = value as { text?: unknown; content?: unknown; type?: unknown };
    if (typeof node.text === 'string') {
      return node.text;
    }
    if (node.content !== undefined) {
      const inner = flattenRichText(node.content);
      // A paragraph or list item is a line of its own.
      return node.type === 'paragraph' || node.type === 'listItem' ? `${inner ?? ''}\n` : inner;
    }
  }
  return undefined;
}

/** Turns one issue payload into the shared item shape. */
export function toSourceItem(issue: JiraIssueResponse, baseUrl: string): SourceItem {
  if (!issue.key) {
    throw new ConfigError(
      'The issue tracker returned an issue without a key. Check that the base URL points at the API root.',
      JSON.stringify(issue).slice(0, 300),
    );
  }
  const fields = issue.fields ?? {};
  const comments = fields.comment?.comments ?? [];
  const links = fields.issuelinks ?? [];

  const extra: SourceItem['extra'] = {
    status: fields.status?.name,
    assignee: fields.assignee?.displayName,
    reporter: fields.reporter?.displayName,
    priority: fields.priority?.name,
    type: fields.issuetype?.name,
    labels: fields.labels?.join(', '),
    createdAt: fields.created,
  };
  if (comments.length > 0) {
    extra.comments = comments
      .map(
        (comment) =>
          `${comment.author?.displayName ?? 'unknown'} (${comment.created ?? 'unknown date'}): ${flattenRichText(comment.body) ?? ''}`,
      )
      .join('\n\n');
    extra.commentCount = comments.length;
  }
  if (links.length > 0) {
    extra.links = links
      .map((link) => {
        const other = link.outwardIssue ?? link.inwardIssue;
        return `${link.type?.name ?? 'relates to'} ${other?.key ?? 'unknown'}: ${other?.fields?.summary ?? ''}`;
      })
      .join('\n');
  }

  return {
    id: issue.key,
    title: fields.summary ?? issue.key,
    // Built from the configured host, never from a URL the payload chose.
    url: `${baseUrl.replace(/\/+$/, '')}/browse/${issue.key}`,
    updatedAt: fields.updated ?? fields.created ?? '',
    body: flattenRichText(fields.description),
    extra,
  };
}

export interface JiraConnectorOptions {
  http: HttpClient;
  /** Host root used to build issue links, without the API path. */
  browseBaseUrl: string;
}

/**
 * Reads issues from an issue tracker over its REST API.
 *
 * Only the fields that are used are requested, and comments and links only when the prompt
 * mentions them: a JQL query matching fifty issues otherwise pulls a great deal of text
 * nobody reads.
 */
export class JiraConnector implements IssueTrackerConnector {
  constructor(private readonly options: JiraConnectorOptions) {}

  async ping(): Promise<void> {
    // `myself` is the cheapest authenticated call: it proves the URL and the token at once.
    await this.options.http.requestJson({ path: 'myself' });
  }

  async search(request: JiraSearchRequest): Promise<FetchResult> {
    if (request.jql.trim().length === 0) {
      throw new ConfigError('This agent has no search query. Edit the agent and add one.');
    }
    const fields = [...BASE_FIELDS];
    if (request.includeComments) {
      fields.push('comment');
    }
    if (request.includeLinks) {
      fields.push('issuelinks');
    }

    const items: SourceItem[] = [];
    let startAt = 0;
    let total = 0;

    while (items.length < request.maxResults) {
      const page = await this.options.http.requestJson<JiraSearchResponse>({
        path: 'search',
        query: {
          jql: request.jql,
          startAt,
          maxResults: Math.min(PAGE_SIZE, request.maxResults - items.length),
          fields: fields.join(','),
        },
      });
      const issues = page?.issues ?? [];
      total = page?.total ?? issues.length;
      for (const issue of issues) {
        items.push(toSourceItem(issue, this.options.browseBaseUrl));
      }
      startAt += issues.length;
      if (issues.length === 0 || startAt >= total) {
        break;
      }
    }

    items.sort(byUpdatedAtDescending);
    return { items, truncated: total > items.length };
  }

  async listProjects(): Promise<NamedEntry[]> {
    const response = await this.options.http.requestJson<{ key?: string; name?: string }[]>({
      path: 'project',
    });
    return (Array.isArray(response) ? response : [])
      .filter((project) => typeof project.key === 'string')
      .map((project) => ({ id: project.key as string, name: project.name }));
  }

  async getIssue(key: string, options?: { includeComments?: boolean }): Promise<SourceItem> {
    const fields = [...BASE_FIELDS];
    if (options?.includeComments) {
      fields.push('comment');
    }
    const issue = await this.options.http.requestJson<JiraIssueResponse>({
      path: `issue/${encodeURIComponent(key)}`,
      query: { fields: fields.join(',') },
    });
    return toSourceItem(issue, this.options.browseBaseUrl);
  }
}
