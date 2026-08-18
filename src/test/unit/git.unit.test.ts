import * as assert from 'node:assert/strict';

import { AuthError, ConfigError } from '../../connectors/errors.js';
import { RestGitConnector, parseRepo, toPullRequestItem } from '../../connectors/git.js';
import { HttpClient } from '../../connectors/http.js';
import type { FetchLike, HttpResponseLike } from '../../connectors/http.js';

const BASE = 'https://git.invalid/api/v3';
const BROWSE = 'https://git.invalid';

function body(text: string, status = 200): HttpResponseLike {
  return { status, headers: { get: () => null }, text: () => Promise.resolve(text) };
}

function json(value: unknown, status = 200): HttpResponseLike {
  return body(JSON.stringify(value), status);
}

const pullRequests = [
  {
    number: 7,
    title: 'Fix the leader lock heartbeat',
    body: 'The lock was never refreshed.',
    state: 'open',
    draft: false,
    created_at: '2026-08-15T08:00:00.000Z',
    updated_at: '2026-08-17T09:00:00.000Z',
    user: { login: 'alex' },
    head: { ref: 'fix/heartbeat' },
    base: { ref: 'main' },
    additions: 12,
    deletions: 3,
    changed_files: 2,
  },
  {
    number: 8,
    title: 'Add the result writer',
    body: null,
    state: 'open',
    draft: true,
    created_at: '2026-08-17T07:00:00.000Z',
    updated_at: '2026-08-17T07:30:00.000Z',
    user: { login: 'sam' },
    head: { ref: 'feature/results' },
    base: { ref: 'main' },
  },
];

function connector(responses: HttpResponseLike[]): {
  connector: RestGitConnector;
  urls: string[];
  headers: Record<string, string>[];
} {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  let index = 0;
  const fetch: FetchLike = (url, init) => {
    urls.push(url);
    headers.push(init.headers);
    const next = responses[Math.min(index, responses.length - 1)] ?? json([]);
    index += 1;
    return Promise.resolve(next);
  };
  const http = new HttpClient({ baseUrl: BASE, fetch, sleep: () => Promise.resolve() });
  return { connector: new RestGitConnector({ http, browseBaseUrl: BROWSE }), urls, headers };
}

describe('repository host connector', () => {
  it('accepts an owner and repository pair', () => {
    assert.deepEqual(parseRepo('octo/rounds'), { owner: 'octo', name: 'rounds' });
    assert.deepEqual(parseRepo(' /octo/rounds/ '), { owner: 'octo', name: 'rounds' });
  });

  it('rejects anything that is not owner/name', () => {
    for (const value of ['rounds', 'octo/rounds/extra', '', 'octo/']) {
      assert.throws(() => parseRepo(value), ConfigError, `expected ${value} to be rejected`);
    }
  });

  it('normalizes a pull request and keeps both timestamps', () => {
    const item = toPullRequestItem(pullRequests[0] as never, 'octo/rounds', BROWSE, 'updatedPullRequests');

    assert.equal(item.id, '7');
    assert.equal(item.title, 'Fix the leader lock heartbeat');
    assert.equal(item.url, 'https://git.invalid/octo/rounds/pull/7');
    assert.equal(item.updatedAt, '2026-08-17T09:00:00.000Z');
    assert.equal(item.extra.createdAt, '2026-08-15T08:00:00.000Z');
    assert.equal(item.extra.author, 'alex');
    assert.equal(item.extra.sourceBranch, 'fix/heartbeat');
    assert.equal(item.extra.draft, 'no');
    assert.equal(item.extra.additions, 12);
  });

  it('uses the creation time as the ordering timestamp in new pull request mode', () => {
    const item = toPullRequestItem(pullRequests[0] as never, 'octo/rounds', BROWSE, 'newPullRequests');
    assert.equal(item.updatedAt, '2026-08-15T08:00:00.000Z');
  });

  it('rejects a payload without a pull request number', () => {
    assert.throws(() => toPullRequestItem({ title: 'no number' }, 'octo/rounds', BROWSE, 'newPullRequests'), ConfigError);
  });

  it('proves the token with a cheap call on ping', async () => {
    const { connector: git, urls } = connector([json({ login: 'alex' })]);
    await git.ping();
    assert.match(urls[0] ?? '', /\/api\/v3\/user$/);
  });

  it('turns a rejected token into an authentication error on ping', async () => {
    const { connector: git } = connector([json({ message: 'bad credentials' }, 401)]);
    await assert.rejects(git.ping(), AuthError);
  });

  it('sorts by creation time in new pull request mode', async () => {
    const { connector: git, urls } = connector([json(pullRequests)]);
    await git.listPullRequests({ project: 'octo', repo: 'rounds', mode: 'newPullRequests' });
    assert.equal(new URL(urls[0] ?? '').searchParams.get('sort'), 'created');
  });

  it('sorts by change time in updated pull request mode', async () => {
    const { connector: git, urls } = connector([json(pullRequests)]);
    await git.listPullRequests({ project: 'octo', repo: 'rounds', mode: 'updatedPullRequests' });
    assert.equal(new URL(urls[0] ?? '').searchParams.get('sort'), 'updated');
  });

  it('returns every pull request when there is no cursor yet', async () => {
    const { connector: git } = connector([json(pullRequests)]);
    const result = await git.listPullRequests({ project: 'octo', repo: 'rounds', mode: 'updatedPullRequests' });

    assert.deepEqual(result.items.map((item) => item.id), ['7', '8']);
    assert.equal(result.cursor, '2026-08-17T09:00:00.000Z');
    assert.equal(result.truncated, false);
  });

  it('skips pull requests that are not newer than the cursor', async () => {
    const { connector: git } = connector([json(pullRequests)]);
    const result = await git.listPullRequests({
      project: 'octo',
      repo: 'rounds',
      mode: 'updatedPullRequests',
      cursor: '2026-08-17T08:00:00.000Z',
    });

    assert.deepEqual(result.items.map((item) => item.id), ['7']);
  });

  it('returns the next cursor instead of storing it', async () => {
    const { connector: git } = connector([json(pullRequests)]);
    const result = await git.listPullRequests({
      project: 'octo',
      repo: 'rounds',
      mode: 'newPullRequests',
      cursor: '2026-08-16T00:00:00.000Z',
    });

    // Only pull request 8 was created after the cursor, so that is where the next run starts.
    assert.deepEqual(result.items.map((item) => item.id), ['8']);
    assert.equal(result.cursor, '2026-08-17T07:00:00.000Z');
  });

  it('never moves the cursor backwards when nothing is new', async () => {
    const { connector: git } = connector([json(pullRequests)]);
    const result = await git.listPullRequests({
      project: 'octo',
      repo: 'rounds',
      mode: 'updatedPullRequests',
      cursor: '2026-08-18T00:00:00.000Z',
    });

    assert.deepEqual(result.items, []);
    assert.equal(result.cursor, '2026-08-18T00:00:00.000Z');
  });

  it('reports truncation when more is new than the agent asked for', async () => {
    const { connector: git } = connector([json(pullRequests)]);
    const result = await git.listPullRequests({
      project: 'octo',
      repo: 'rounds',
      mode: 'updatedPullRequests',
      maxResults: 1,
    });

    assert.equal(result.items.length, 1);
    assert.equal(result.truncated, true);
  });

  it('fails clearly when the host answers with something that is not a list', async () => {
    const { connector: git } = connector([json({ message: 'not a list' })]);
    await assert.rejects(
      git.listPullRequests({ project: 'octo', repo: 'rounds', mode: 'newPullRequests' }),
      ConfigError,
    );
  });

  it('lists the account and its organizations as places a repository can live', async () => {
    const { connector: git, urls } = connector([
      json({ login: 'alex' }),
      json([{ login: 'octo' }, { login: 'acme' }]),
    ]);

    const projects = await git.listProjects();

    assert.deepEqual(projects.map((entry) => entry.id), ['alex', 'octo', 'acme']);
    assert.equal(projects[0]?.name, 'your account');
    assert.ok(urls.some((url) => url.includes('/user/orgs')));
  });

  it('falls back to the viewer own repositories when the project is not an organization', async () => {
    // `/orgs/<user>/repos` is a 404 for a personal account, and that is not an error worth
    // showing anybody who is picking from a list.
    const { connector: git, urls } = connector([
      json({ message: 'Not Found' }, 404),
      json([{ name: 'rounds' }, { name: 'notes' }]),
    ]);

    const repositories = await git.listRepositories('alex');

    assert.deepEqual(repositories.map((entry) => entry.id), ['rounds', 'notes']);
    assert.match(urls[1] ?? '', /\/user\/repos/);
  });

  it('asks for the diff format and returns the diff as it is', async () => {
    const diff = 'diff --git a/file b/file\n+added line\n';
    const { connector: git, urls, headers } = connector([body(diff)]);
    const result = await git.getDiff('octo', 'rounds', '7');

    assert.equal(result.text, diff);
    assert.equal(result.truncated, false);
    assert.match(urls[0] ?? '', /pulls\/7$/);
    assert.match(headers[0]?.Accept ?? '', /diff/);
  });

  it('truncates an enormous diff with a visible marker', async () => {
    const diff = 'x'.repeat(500);
    const { connector: git } = connector([body(diff)]);
    const result = await git.getDiff('octo', 'rounds', '7', 100);

    assert.equal(result.truncated, true);
    assert.match(result.text, /\[truncated: 100 of 500 characters shown\]/);
    assert.ok(result.text.length < diff.length);
  });
});
