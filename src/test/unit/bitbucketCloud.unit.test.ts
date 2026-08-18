import * as assert from 'node:assert/strict';

import { BitbucketCloudConnector, toBitbucketCloudItem } from '../../connectors/bitbucketCloud.js';
import type { BitbucketCloudPullRequest } from '../../connectors/bitbucketCloud.js';
import { AuthError, ConfigError } from '../../connectors/errors.js';
import { HttpClient } from '../../connectors/http.js';
import type { FetchLike, HttpResponseLike } from '../../connectors/http.js';

const BASE = 'https://api.bitbucket.org/2.0';
const BROWSE = 'https://bitbucket.org';

function body(text: string, status = 200): HttpResponseLike {
  return { status, headers: { get: () => null }, text: () => Promise.resolve(text) };
}

function json(value: unknown, status = 200): HttpResponseLike {
  return body(JSON.stringify(value), status);
}

/** A recorded page, trimmed to the fields the connector reads. */
const page: { values: BitbucketCloudPullRequest[]; size: number; next?: string } = {
  values: [
    {
      id: 7,
      title: 'Fix the leader lock heartbeat',
      summary: { raw: 'The lock was never refreshed.' },
      state: 'OPEN',
      created_on: '2026-08-15T08:00:00.000000+00:00',
      updated_on: '2026-08-17T09:00:00.000000+00:00',
      author: { display_name: 'Alex Doe', nickname: 'alex' },
      source: { branch: { name: 'fix/heartbeat' } },
      destination: { branch: { name: 'main' } },
      links: { html: { href: 'https://bitbucket.org/octo/rounds/pull-requests/7' } },
      comment_count: 3,
      task_count: 1,
    },
    {
      id: 8,
      title: 'Add the result writer',
      state: 'MERGED',
      created_on: '2026-08-17T07:00:00.000000+00:00',
      updated_on: '2026-08-17T07:30:00.000000+00:00',
      author: { nickname: 'sam' },
      source: { branch: { name: 'feature/results' } },
      destination: { branch: { name: 'main' } },
    },
  ],
  size: 2,
};

const [openPullRequest, mergedPullRequest] = page.values as [BitbucketCloudPullRequest, BitbucketCloudPullRequest];

function connector(responses: HttpResponseLike[]): {
  connector: BitbucketCloudConnector;
  urls: string[];
} {
  const urls: string[] = [];
  let index = 0;
  const fetch: FetchLike = (url) => {
    urls.push(url);
    const next = responses[Math.min(index, responses.length - 1)] ?? json({});
    index += 1;
    return Promise.resolve(next);
  };
  const http = new HttpClient({ baseUrl: BASE, fetch, sleep: () => Promise.resolve() });
  return { connector: new BitbucketCloudConnector({ http, browseBaseUrl: BROWSE }), urls };
}

describe('bitbucket connector', () => {
  it('normalizes a pull request into the shared shape', () => {
    const item = toBitbucketCloudItem(openPullRequest, 'octo/rounds', BROWSE, 'updatedPullRequests');

    assert.equal(item.id, '7');
    assert.equal(item.title, 'Fix the leader lock heartbeat');
    assert.equal(item.url, 'https://bitbucket.org/octo/rounds/pull-requests/7');
    assert.equal(item.updatedAt, '2026-08-17T09:00:00.000Z');
    assert.equal(item.body, 'The lock was never refreshed.');
    assert.equal(item.extra.author, 'Alex Doe');
    assert.equal(item.extra.sourceBranch, 'fix/heartbeat');
    assert.equal(item.extra.state, 'OPEN');
    assert.equal(item.extra.comments, 3);
  });

  it('normalizes the timestamps, because the cursor compares strings', () => {
    // The host sends six fractional digits and an explicit +00:00. Comparing that against an ISO
    // cursor character by character is how an agent starts skipping items nobody asked it to skip.
    const item = toBitbucketCloudItem(openPullRequest, 'octo/rounds', BROWSE, 'updatedPullRequests');
    assert.equal(item.extra.createdAt, '2026-08-15T08:00:00.000Z');
    assert.equal(item.extra.updatedAt, '2026-08-17T09:00:00.000Z');
  });

  it('falls back to the nickname when there is no display name', () => {
    const item = toBitbucketCloudItem(mergedPullRequest, 'octo/rounds', BROWSE, 'updatedPullRequests');
    assert.equal(item.extra.author, 'sam');
  });

  it('uses the creation time as the ordering timestamp in new pull request mode', () => {
    const item = toBitbucketCloudItem(openPullRequest, 'octo/rounds', BROWSE, 'newPullRequests');
    assert.equal(item.updatedAt, '2026-08-15T08:00:00.000Z');
  });

  it('rejects a payload without an id', () => {
    assert.throws(() => toBitbucketCloudItem({ title: 'no id' }, 'octo/rounds', BROWSE, 'newPullRequests'), ConfigError);
  });

  it('proves the token with a cheap call on ping', async () => {
    const { connector: bitbucket, urls } = connector([json({ uuid: '{abc}' })]);
    await bitbucket.ping();
    assert.match(urls[0] ?? '', /\/2\.0\/user$/);
  });

  it('turns a rejected token into an authentication error', async () => {
    const { connector: bitbucket } = connector([json({ type: 'error' }, 401)]);
    await assert.rejects(bitbucket.ping(), AuthError);
  });

  it('asks for every state, because merged work matters too', async () => {
    const { connector: bitbucket, urls } = connector([json(page)]);
    await bitbucket.listPullRequests({ project: 'octo', repo: 'rounds', mode: 'updatedPullRequests' });

    const parameters = new URL(urls[0] ?? '').searchParams;
    assert.deepEqual(parameters.getAll('state'), ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED']);
    assert.equal(parameters.get('sort'), '-updated_on');
  });

  it('sorts by creation time in new pull request mode', async () => {
    const { connector: bitbucket, urls } = connector([json(page)]);
    await bitbucket.listPullRequests({ project: 'octo', repo: 'rounds', mode: 'newPullRequests' });
    assert.equal(new URL(urls[0] ?? '').searchParams.get('sort'), '-created_on');
  });

  it('returns items newest first with a cursor to continue from', async () => {
    const { connector: bitbucket } = connector([json(page)]);
    const result = await bitbucket.listPullRequests({ project: 'octo', repo: 'rounds', mode: 'updatedPullRequests' });

    assert.deepEqual(result.items.map((item) => item.id), ['7', '8']);
    assert.equal(result.cursor, '2026-08-17T09:00:00.000Z');
  });

  it('skips what is not newer than the cursor', async () => {
    const { connector: bitbucket } = connector([json(page)]);
    const result = await bitbucket.listPullRequests({
      project: 'octo',
      repo: 'rounds',
      mode: 'updatedPullRequests',
      cursor: '2026-08-17T08:00:00.000Z',
    });
    assert.deepEqual(result.items.map((item) => item.id), ['7']);
  });

  it('reports truncation when the host says there is another page', async () => {
    const { connector: bitbucket } = connector([json({ ...page, next: 'https://api.bitbucket.org/next' })]);
    const result = await bitbucket.listPullRequests({ project: 'octo', repo: 'rounds', mode: 'updatedPullRequests' });
    assert.equal(result.truncated, true);
  });

  it('fails clearly when the payload is not a page of pull requests', async () => {
    const { connector: bitbucket } = connector([json({ type: 'error', error: { message: 'nope' } })]);
    await assert.rejects(
      bitbucket.listPullRequests({ project: 'octo', repo: 'rounds', mode: 'newPullRequests' }),
      ConfigError,
    );
  });

  it('encodes both halves of the address, so neither can break out of the path', async () => {
    // The connector takes the workspace and the repository as given: rejecting a malformed pair
    // is the state validator's job since schema version 2, and encoding is what keeps a value
    // with a slash in it from becoming two path segments.
    const { connector: bitbucket, urls } = connector([json(page)]);
    await bitbucket.listPullRequests({ project: 'my space', repo: 'a/b', mode: 'newPullRequests' });

    assert.match(urls[0] ?? '', /repositories\/my%20space\/a%2Fb\/pullrequests/);
  });

  it('lists workspaces and the repositories of one', async () => {
    const { connector: bitbucket, urls } = connector([
      json({ values: [{ slug: 'octo', name: 'Octo Ltd' }] }),
    ]);

    const workspaces = await bitbucket.listProjects();
    assert.deepEqual(workspaces, [{ id: 'octo', name: 'Octo Ltd' }]);
    assert.match(urls[0] ?? '', /\/workspaces\?/);

    const { connector: second, urls: repoUrls } = connector([
      json({ values: [{ slug: 'rounds', name: 'Rounds' }] }),
    ]);
    assert.deepEqual(await second.listRepositories('octo'), [{ id: 'rounds', name: 'Rounds' }]);
    assert.match(repoUrls[0] ?? '', /\/repositories\/octo\?/);
  });

  it('returns the diff when the host serves it directly', async () => {
    const diff = 'diff --git a/file b/file\n+added line\n';
    const { connector: bitbucket, urls } = connector([body(diff)]);
    const result = await bitbucket.getDiff('octo', 'rounds', '7');

    assert.equal(result.text, diff);
    assert.match(urls[0] ?? '', /pullrequests\/7\/diff$/);
  });

  it('notes a diff it could not fetch instead of failing the whole run', async () => {
    // Bitbucket redirects this endpoint, and the client refuses redirects on purpose. A missing diff
    // is worth a note; it is not worth losing the pull requests that were fetched successfully.
    const { connector: bitbucket } = connector([json({ type: 'error' }, 302)]);
    const result = await bitbucket.getDiff('octo', 'rounds', '7');

    assert.match(result.text, /the diff could not be fetched/);
    assert.equal(result.truncated, false);
  });

  it('truncates an enormous diff with a visible marker', async () => {
    const { connector: bitbucket } = connector([body('x'.repeat(500))]);
    const result = await bitbucket.getDiff('octo', 'rounds', '7', 100);

    assert.equal(result.truncated, true);
    assert.match(result.text, /\[truncated: 100 of 500 characters shown\]/);
  });
});
