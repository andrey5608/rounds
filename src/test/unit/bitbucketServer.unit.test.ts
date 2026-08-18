import * as assert from 'node:assert/strict';

import {
  BitbucketServerConnector,
  browsePath,
  toBitbucketServerItem,
} from '../../connectors/bitbucketServer.js';
import type { BitbucketServerPullRequest } from '../../connectors/bitbucketServer.js';
import { AuthError, ConfigError } from '../../connectors/errors.js';
import { HttpClient } from '../../connectors/http.js';
import type { FetchLike, HttpResponseLike } from '../../connectors/http.js';

const BASE = 'https://bitbucket.example.invalid/rest/api/1.0';
const BROWSE = 'https://bitbucket.example.invalid';

function body(text: string, status = 200): HttpResponseLike {
  return { status, headers: { get: () => null }, text: () => Promise.resolve(text) };
}

function json(value: unknown, status = 200): HttpResponseLike {
  return body(JSON.stringify(value), status);
}

/** A recorded page, trimmed to the fields the connector reads. */
const page: { values: BitbucketServerPullRequest[]; size: number; isLastPage?: boolean } = {
  values: [
    {
      id: 7,
      title: 'Fix the leader lock heartbeat',
      description: 'The lock was never refreshed.',
      state: 'OPEN',
      createdDate: Date.parse('2026-08-15T08:00:00.000Z'),
      updatedDate: Date.parse('2026-08-17T09:00:00.000Z'),
      author: { user: { displayName: 'Alex Doe', name: 'alex' } },
      fromRef: { displayId: 'fix/heartbeat' },
      toRef: { displayId: 'main' },
      properties: { commentCount: 3, openTaskCount: 1 },
    },
    {
      id: 8,
      title: 'Add the result writer',
      state: 'MERGED',
      createdDate: Date.parse('2026-08-17T07:00:00.000Z'),
      updatedDate: Date.parse('2026-08-17T07:30:00.000Z'),
      author: { user: { name: 'sam' } },
      fromRef: { displayId: 'feature/results' },
      toRef: { displayId: 'main' },
    },
  ],
  size: 2,
  isLastPage: true,
};

const [openPullRequest, mergedPullRequest] = page.values as [
  BitbucketServerPullRequest,
  BitbucketServerPullRequest,
];

function connector(responses: HttpResponseLike[]): {
  connector: BitbucketServerConnector;
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
  return { connector: new BitbucketServerConnector({ http, browseBaseUrl: BROWSE }), urls };
}

describe('self-hosted bitbucket connector', () => {
  it('turns epoch milliseconds into the timestamps the cursor compares', () => {
    const item = toBitbucketServerItem(openPullRequest, 'ROUNDS/rounds', BROWSE, 'updatedPullRequests');

    assert.equal(item.id, '7');
    assert.equal(item.title, 'Fix the leader lock heartbeat');
    assert.equal(item.updatedAt, '2026-08-17T09:00:00.000Z');
    assert.equal(item.extra.createdAt, '2026-08-15T08:00:00.000Z');
    assert.equal(item.body, 'The lock was never refreshed.');
    assert.equal(item.extra.author, 'Alex Doe');
    assert.equal(item.extra.sourceBranch, 'fix/heartbeat');
    assert.equal(item.extra.comments, 3);
  });

  it('links to the project browse path, not to the REST path', () => {
    const item = toBitbucketServerItem(openPullRequest, 'ROUNDS/rounds', BROWSE, 'updatedPullRequests');
    assert.equal(
      item.url,
      'https://bitbucket.example.invalid/projects/ROUNDS/repos/rounds/pull-requests/7',
    );
  });

  it('links a personal repository under its own area', () => {
    assert.equal(browsePath('~alex', 'rounds'), 'users/alex/repos/rounds');
    assert.equal(browsePath('ROUNDS', 'rounds'), 'projects/ROUNDS/repos/rounds');
  });

  it('falls back to the account name when there is no display name', () => {
    const item = toBitbucketServerItem(mergedPullRequest, 'ROUNDS/rounds', BROWSE, 'updatedPullRequests');
    assert.equal(item.extra.author, 'sam');
  });

  it('uses the creation time as the ordering timestamp in new pull request mode', () => {
    const item = toBitbucketServerItem(openPullRequest, 'ROUNDS/rounds', BROWSE, 'newPullRequests');
    assert.equal(item.updatedAt, '2026-08-15T08:00:00.000Z');
  });

  it('rejects a payload without an id', () => {
    assert.throws(
      () => toBitbucketServerItem({ title: 'no id' }, 'ROUNDS/rounds', BROWSE, 'newPullRequests'),
      ConfigError,
    );
  });

  it('proves the token with a call scoped to whoever owns it', async () => {
    const { connector: bitbucket, urls } = connector([json({ values: [] })]);
    await bitbucket.ping();
    assert.match(urls[0] ?? '', /\/rest\/api\/1\.0\/profile\/recent\/repos\?limit=1$/);
  });

  it('turns a rejected token into an authentication error', async () => {
    const { connector: bitbucket } = connector([json({ errors: [] }, 401)]);
    await assert.rejects(bitbucket.ping(), AuthError);
  });

  it('asks the project and repository path for every state', async () => {
    const { connector: bitbucket, urls } = connector([json(page)]);
    await bitbucket.listPullRequests({ project: 'ROUNDS', repo: 'rounds', mode: 'updatedPullRequests' });

    const url = new URL(urls[0] ?? '');
    assert.equal(url.pathname, '/rest/api/1.0/projects/ROUNDS/repos/rounds/pull-requests');
    assert.equal(url.searchParams.get('state'), 'ALL');
    assert.equal(url.searchParams.get('order'), 'NEWEST');
  });

  it('addresses a personal project with the tilde the API expects', async () => {
    const { connector: bitbucket, urls } = connector([json(page)]);
    await bitbucket.listPullRequests({ project: '~alex', repo: 'rounds', mode: 'updatedPullRequests' });
    assert.match(urls[0] ?? '', /\/projects\/~alex\/repos\/rounds\/pull-requests/);
  });

  it('orders by change time itself, because the host only sorts by creation time', async () => {
    // Pull request 8 was created last but changed first, so ordering by what the host returned would
    // put it in front of one that changed later.
    const { connector: bitbucket } = connector([json(page)]);
    const result = await bitbucket.listPullRequests({
      project: 'ROUNDS',
      repo: 'rounds',
      mode: 'updatedPullRequests',
    });

    assert.deepEqual(result.items.map((item) => item.id), ['7', '8']);
    assert.equal(result.cursor, '2026-08-17T09:00:00.000Z');
    assert.equal(result.truncated, false);
  });

  it('skips what is not newer than the cursor', async () => {
    const { connector: bitbucket } = connector([json(page)]);
    const result = await bitbucket.listPullRequests({
      project: 'ROUNDS',
      repo: 'rounds',
      mode: 'updatedPullRequests',
      cursor: '2026-08-17T08:00:00.000Z',
    });
    assert.deepEqual(result.items.map((item) => item.id), ['7']);
  });

  it('reports truncation when the host says this was not the last page', async () => {
    const { connector: bitbucket } = connector([json({ ...page, isLastPage: false })]);
    const result = await bitbucket.listPullRequests({
      project: 'ROUNDS',
      repo: 'rounds',
      mode: 'updatedPullRequests',
    });
    assert.equal(result.truncated, true);
  });

  it('fails clearly when the base URL already carried the REST path', async () => {
    // The failure this catches: /rest/api/1.0/rest/api/1.0/... answers with something that is not a
    // page, and "did not return a list" has to say what to change.
    const { connector: bitbucket } = connector([json({ errors: [{ message: 'nope' }] })]);
    await assert.rejects(
      bitbucket.listPullRequests({ project: 'ROUNDS', repo: 'rounds', mode: 'newPullRequests' }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /without the REST path/);
        return true;
      },
    );
  });

  it('lists projects and the repositories of one', async () => {
    const { connector: bitbucket, urls } = connector([
      json({ values: [{ key: 'ROUNDS', name: 'Rounds' }, { key: '~alex', name: 'Alex' }] }),
    ]);

    const projects = await bitbucket.listProjects();
    assert.deepEqual(projects.map((entry) => entry.id), ['ROUNDS', '~alex']);
    assert.match(urls[0] ?? '', /\/rest\/api\/1\.0\/projects\?/);

    const { connector: second, urls: repoUrls } = connector([
      json({ values: [{ slug: 'rounds', name: 'Rounds' }] }),
    ]);
    assert.deepEqual(await second.listRepositories('ROUNDS'), [{ id: 'rounds', name: 'Rounds' }]);
    assert.match(repoUrls[0] ?? '', /\/projects\/ROUNDS\/repos\?/);
  });

  it('returns the raw diff', async () => {
    const diff = 'diff --git a/file b/file\n+added line\n';
    const { connector: bitbucket, urls } = connector([body(diff)]);
    const result = await bitbucket.getDiff('ROUNDS', 'rounds', '7');

    assert.equal(result.text, diff);
    assert.match(urls[0] ?? '', /pull-requests\/7\.diff$/);
  });

  it('notes a diff it could not fetch instead of failing the whole run', async () => {
    const { connector: bitbucket } = connector([json({ errors: [] }, 404)]);
    const result = await bitbucket.getDiff('ROUNDS', 'rounds', '7');

    assert.match(result.text, /the diff could not be fetched/);
    assert.equal(result.truncated, false);
  });

  it('truncates an enormous diff with a visible marker', async () => {
    const { connector: bitbucket } = connector([body('x'.repeat(500))]);
    const result = await bitbucket.getDiff('ROUNDS', 'rounds', '7', 100);

    assert.equal(result.truncated, true);
    assert.match(result.text, /\[truncated: 100 of 500 characters shown\]/);
  });
});
