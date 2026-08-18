import * as assert from 'node:assert/strict';

import { AuthError, ConfigError } from '../../connectors/errors.js';
import { HttpClient } from '../../connectors/http.js';
import type { FetchLike, HttpResponseLike } from '../../connectors/http.js';
import { JiraConnector, flattenRichText, toSourceItem } from '../../connectors/jira.js';

const BASE = 'https://tracker.invalid/rest/api/2';
const BROWSE = 'https://tracker.invalid';

function json(body: unknown, status = 200): HttpResponseLike {
  return {
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

/** A hosted-style issue: rich text description, comments as a document tree. */
const hostedIssue = {
  key: 'ROUNDS-1',
  fields: {
    summary: 'Scheduler skips a run after a restart',
    updated: '2026-08-17T09:30:00.000Z',
    created: '2026-08-15T08:00:00.000Z',
    status: { name: 'In Progress' },
    assignee: { displayName: 'Alex Doe' },
    reporter: { displayName: 'Sam Roe' },
    priority: { name: 'High' },
    issuetype: { name: 'Bug' },
    labels: ['scheduler', 'reliability'],
    description: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'The run is skipped.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Only after a restart.' }] },
      ],
    },
    comment: {
      comments: [
        {
          author: { displayName: 'Alex Doe' },
          created: '2026-08-16T10:00:00.000Z',
          body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reproduced.' }] }] },
        },
      ],
    },
    issuelinks: [
      { type: { name: 'blocks' }, outwardIssue: { key: 'ROUNDS-2', fields: { summary: 'Leader lock' } } },
    ],
  },
};

/** A self-hosted-style issue: plain string description, no comments requested. */
const selfHostedIssue = {
  key: 'OPS-42',
  fields: {
    summary: 'Rotate the tracker token',
    updated: '2026-08-16T12:00:00.000Z',
    description: 'The token expires next month.',
    status: { name: 'To Do' },
  },
};

function connector(responses: HttpResponseLike[]): { connector: JiraConnector; urls: string[] } {
  const urls: string[] = [];
  let index = 0;
  const fetch: FetchLike = (url) => {
    urls.push(url);
    const next = responses[Math.min(index, responses.length - 1)] ?? json({});
    index += 1;
    return Promise.resolve(next);
  };
  const http = new HttpClient({ baseUrl: BASE, fetch, sleep: () => Promise.resolve() });
  return { connector: new JiraConnector({ http, browseBaseUrl: BROWSE }), urls };
}

describe('issue tracker connector', () => {
  it('flattens a rich text document into paragraphs', () => {
    // Paragraphs stay separated by a blank line: the text goes into a prompt, where a
    // paragraph break carries meaning.
    assert.equal(
      flattenRichText(hostedIssue.fields.description)?.trim(),
      'The run is skipped.\n\nOnly after a restart.',
    );
  });

  it('passes a plain string description through', () => {
    assert.equal(flattenRichText('already text'), 'already text');
  });

  it('returns nothing for an empty field rather than the string "undefined"', () => {
    assert.equal(flattenRichText(undefined), undefined);
    assert.equal(flattenRichText(null), undefined);
  });

  it('normalizes a hosted issue, comments and links included', () => {
    const item = toSourceItem(hostedIssue, BROWSE);

    assert.equal(item.id, 'ROUNDS-1');
    assert.equal(item.title, 'Scheduler skips a run after a restart');
    assert.equal(item.url, 'https://tracker.invalid/browse/ROUNDS-1');
    assert.equal(item.updatedAt, '2026-08-17T09:30:00.000Z');
    assert.match(item.body ?? '', /The run is skipped/);
    assert.equal(item.extra.status, 'In Progress');
    assert.equal(item.extra.assignee, 'Alex Doe');
    assert.equal(item.extra.labels, 'scheduler, reliability');
    assert.equal(item.extra.commentCount, 1);
    assert.match(String(item.extra.comments), /Alex Doe .*: Reproduced\./);
    assert.match(String(item.extra.links), /blocks ROUNDS-2: Leader lock/);
  });

  it('normalizes a self-hosted issue with the same shape', () => {
    const item = toSourceItem(selfHostedIssue, BROWSE);

    assert.equal(item.id, 'OPS-42');
    assert.equal(item.body, 'The token expires next month.');
    assert.equal(item.extra.comments, undefined);
  });

  it('builds the issue link from the configured host, not from the payload', () => {
    const item = toSourceItem({ ...hostedIssue, self: 'https://evil.invalid/api/ROUNDS-1' }, BROWSE);
    assert.ok(item.url.startsWith(BROWSE));
  });

  it('rejects a payload without an issue key', () => {
    assert.throws(() => toSourceItem({ fields: { summary: 'no key' } }, BROWSE), ConfigError);
  });

  it('proves the token with a cheap call on ping', async () => {
    const { connector: jira, urls } = connector([json({ accountId: 'abc' })]);
    await jira.ping();
    assert.match(urls[0] ?? '', /\/rest\/api\/2\/myself$/);
  });

  it('turns a rejected token into an authentication error on ping', async () => {
    const { connector: jira } = connector([json({ message: 'no' }, 401)]);
    await assert.rejects(jira.ping(), AuthError);
  });

  it('requests only the fields it uses', async () => {
    const { connector: jira, urls } = connector([json({ issues: [selfHostedIssue], total: 1 })]);
    await jira.search({ jql: 'project = OPS', maxResults: 10 });

    const url = new URL(urls[0] ?? '');
    const fields = url.searchParams.get('fields') ?? '';
    assert.ok(fields.includes('summary'));
    assert.ok(!fields.includes('comment'), 'comments are not fetched unless asked for');
    assert.ok(!fields.includes('issuelinks'));
  });

  it('asks for comments and links only when the prompt needs them', async () => {
    const { connector: jira, urls } = connector([json({ issues: [hostedIssue], total: 1 })]);
    await jira.search({
      jql: 'project = ROUNDS',
      maxResults: 10,
      includeComments: true,
      includeLinks: true,
    });

    const fields = new URL(urls[0] ?? '').searchParams.get('fields') ?? '';
    assert.ok(fields.includes('comment'));
    assert.ok(fields.includes('issuelinks'));
  });

  it('returns items newest first', async () => {
    const { connector: jira } = connector([
      json({ issues: [selfHostedIssue, hostedIssue], total: 2 }),
    ]);
    const result = await jira.search({ jql: 'project in (OPS, ROUNDS)', maxResults: 10 });

    assert.deepEqual(result.items.map((item) => item.id), ['ROUNDS-1', 'OPS-42']);
    assert.equal(result.truncated, false);
  });

  it('reports truncation when the tracker has more than was asked for', async () => {
    const { connector: jira } = connector([json({ issues: [hostedIssue], total: 137 })]);
    const result = await jira.search({ jql: 'project = ROUNDS', maxResults: 1 });

    assert.equal(result.items.length, 1);
    assert.equal(result.truncated, true);
  });

  it('stops paging when a page comes back empty', async () => {
    const { connector: jira, urls } = connector([json({ issues: [], total: 500 })]);
    const result = await jira.search({ jql: 'project = ROUNDS', maxResults: 100 });

    assert.deepEqual(result.items, []);
    assert.equal(urls.length, 1, 'an empty page must not be requested again');
  });

  it('refuses to search with an empty query', async () => {
    const { connector: jira } = connector([json({})]);
    await assert.rejects(jira.search({ jql: '   ', maxResults: 10 }), ConfigError);
  });

  it('fetches a single issue by key', async () => {
    const { connector: jira, urls } = connector([json(hostedIssue)]);
    const item = await jira.getIssue('ROUNDS-1', { includeComments: true });

    assert.equal(item.id, 'ROUNDS-1');
    assert.match(urls[0] ?? '', /issue\/ROUNDS-1\?/);
    assert.match(new URL(urls[0] ?? '').searchParams.get('fields') ?? '', /comment/);
  });
});

describe('offering the projects a tracker has', () => {
  it('lists them by key, with the name beside it', async () => {
    const { connector: jira, urls } = connector([
      json([
        { key: 'ROUNDS', name: 'Rounds' },
        { key: 'OPS', name: 'Operations' },
      ]),
    ]);

    const projects = await jira.listProjects();

    assert.deepEqual(projects, [
      { id: 'ROUNDS', name: 'Rounds' },
      { id: 'OPS', name: 'Operations' },
    ]);
    assert.match(urls[0] ?? '', /\/project$/);
  });

  it('answers with nothing when the tracker returns something else', async () => {
    const { connector: jira } = connector([json({ errorMessages: ['no permission'] })]);
    assert.deepEqual(await jira.listProjects(), []);
  });
});
