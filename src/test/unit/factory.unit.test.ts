import * as assert from 'node:assert/strict';

import {
  ConnectorFactory,
  authorizationHeader,
  providerFromHost,
  resolveApiRoot,
  resolveEndpoint,
  resolveProvider,
} from '../../connectors/factory.js';
import { ConfigError } from '../../connectors/errors.js';
import type { FetchLike, HttpResponseLike } from '../../connectors/http.js';
import { Emitter } from '../../state/emitter.js';
import type { Disposable } from '../../state/emitter.js';
import { RoundsSecrets } from '../../state/secrets.js';
import type { SecretStorageLike } from '../../state/secrets.js';
import type { EndpointConfig } from '../../state/types.js';

class FakeSecretStorage implements SecretStorageLike {
  readonly values = new Map<string, string>();
  private readonly emitter = new Emitter<{ key: string }>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  onDidChange(listener: (event: { key: string }) => void): Disposable {
    return this.emitter.event(listener);
  }
}

const tracker: EndpointConfig = {
  name: 'tracker',
  kind: 'jira',
  baseUrl: 'https://tracker.invalid',
  authScheme: 'basic',
  username: 'alex@example.invalid',
};

const repos: EndpointConfig = {
  name: 'repos',
  kind: 'git',
  baseUrl: 'https://git.invalid',
  authScheme: 'bearer',
};

function json(value: unknown, status = 200): HttpResponseLike {
  return {
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(value)),
  };
}

async function factoryWith(
  secretsSetup: (secrets: RoundsSecrets) => Promise<void>,
  responses: HttpResponseLike[] = [json({ ok: true })],
): Promise<{ factory: ConnectorFactory; urls: string[]; headers: Record<string, string>[] }> {
  const secrets = new RoundsSecrets(new FakeSecretStorage());
  await secretsSetup(secrets);

  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  let index = 0;
  const fetch: FetchLike = (url, init) => {
    urls.push(url);
    headers.push(init.headers);
    const next = responses[Math.min(index, responses.length - 1)] ?? json({});
    index += 1;
    return Promise.resolve(next);
  };

  return {
    factory: new ConnectorFactory({
      secrets,
      endpoints: { tracker, repos },
      fetch,
    }),
    urls,
    headers,
  };
}

describe('connector factory', () => {
  it('resolves the endpoint an agent references', () => {
    const endpoint = resolveEndpoint({ tracker }, { kind: 'jira', baseUrlRef: 'tracker' });
    assert.equal(endpoint.baseUrl, 'https://tracker.invalid');
  });

  it('explains an endpoint that is not configured', () => {
    assert.throws(
      () => resolveEndpoint({}, { kind: 'jira', baseUrlRef: 'tracker' }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /"tracker", which is not configured/);
        assert.equal(error.fixCommand, 'rounds.checkSetup');
        return true;
      },
    );
  });

  it('refuses an endpoint configured for a different kind of source', () => {
    assert.throws(
      () => resolveEndpoint({ tracker }, { kind: 'git', baseUrlRef: 'tracker' }),
      /different kind of source/,
    );
  });

  it('builds a basic authorization header from the user name and the token', () => {
    const header = authorizationHeader(tracker, 'secret-token');
    assert.equal(
      header,
      `Basic ${Buffer.from('alex@example.invalid:secret-token', 'utf8').toString('base64')}`,
    );
  });

  it('builds a bearer header when there is no user name involved', () => {
    assert.equal(authorizationHeader(repos, 'secret-token'), 'Bearer secret-token');
  });

  it('refuses basic authentication without a user name', () => {
    assert.throws(
      () => authorizationHeader({ ...tracker, username: undefined }, 'secret-token'),
      /no user name/,
    );
  });

  it('sends the stored token and targets the API path of the host', async () => {
    const { factory, urls, headers } = await factoryWith((secrets) =>
      secrets.set('jiraToken', 'tracker-token'),
    );

    const connector = await factory.createIssueTracker(tracker);
    await connector.ping();

    assert.match(urls[0] ?? '', /^https:\/\/tracker\.invalid\/rest\/api\/2\/myself$/);
    assert.match(headers[0]?.Authorization ?? '', /^Basic /);
  });

  it('uses the repository token for a repository host', async () => {
    const { factory, headers } = await factoryWith((secrets) => secrets.set('gitToken', 'repo-token'));

    const connector = await factory.createRepositoryHost(repos);
    await connector.ping();

    assert.equal(headers[0]?.Authorization, 'Bearer repo-token');
  });

  it('speaks the Bitbucket API when the connection points at Bitbucket', async () => {
    const { factory, urls } = await factoryWith((secrets) => secrets.set('gitToken', 'repo-token'));

    const connector = await factory.createRepositoryHost({ ...repos, baseUrl: 'https://bitbucket.org' });
    await connector.ping();

    // The GitHub connector proves the token with /user too, so the API root is what tells them apart.
    assert.equal(urls[0], 'https://api.bitbucket.org/2.0/user');
  });

  it('speaks the self-hosted Bitbucket API when the connection says that is what it is', async () => {
    const { factory, urls } = await factoryWith((secrets) => secrets.set('gitToken', 'repo-token'));

    const connector = await factory.createRepositoryHost({
      ...repos,
      baseUrl: 'https://bitbucket.example.invalid',
      provider: 'bitbucketServer',
    });
    await connector.ping();

    assert.equal(
      urls[0],
      'https://bitbucket.example.invalid/rest/api/1.0/profile/recent/repos?limit=1',
    );
  });

  it('refuses to connect without a stored token', async () => {
    const { factory } = await factoryWith(() => Promise.resolve());
    await assert.rejects(factory.createIssueTracker(tracker), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /No token is stored/);
      return true;
    });
  });

  it('reports a reachable endpoint without throwing', async () => {
    const { factory } = await factoryWith((secrets) => secrets.set('gitToken', 'repo-token'));
    assert.deepEqual(await factory.ping(repos), {
      ok: true,
      message: 'https://git.invalid answered.',
    });
  });

  it('reports an unreachable endpoint as a message rather than an exception', async () => {
    const { factory } = await factoryWith(
      (secrets) => secrets.set('gitToken', 'repo-token'),
      [json({ message: 'nope' }, 401)],
    );

    const result = await factory.ping(repos);
    assert.equal(result.ok, false);
    assert.match(result.message, /rejected the stored token/);
  });

  it('reports a missing token as a failed ping, not a crash in Check Setup', async () => {
    const { factory } = await factoryWith(() => Promise.resolve());
    const result = await factory.ping(tracker);
    assert.equal(result.ok, false);
    assert.match(result.message, /No token is stored/);
  });

  it('connects for the source an agent declares', async () => {
    const { factory } = await factoryWith(async (secrets) => {
      await secrets.set('jiraToken', 'tracker-token');
      await secrets.set('gitToken', 'repo-token');
    });

    const forJira = await factory.forSource({
      kind: 'jira',
      baseUrlRef: 'tracker',
      jql: 'project = ROUNDS',
      maxResults: 10,
    });
    assert.ok(forJira.tracker);
    assert.equal(forJira.repositoryHost, undefined);

    const forGit = await factory.forSource({
      kind: 'git',
      baseUrlRef: 'repos',
      project: 'octo',
      repo: 'rounds',
      mode: 'newPullRequests',
    });
    assert.ok(forGit.repositoryHost);
    assert.equal(forGit.tracker, undefined);
  });

  it('never lets a token reach an error message', async () => {
    const { factory } = await factoryWith(
      (secrets) => secrets.set('gitToken', 'super-secret-token'),
      [json({ message: 'bad credentials' }, 401)],
    );

    const result = await factory.ping(repos);
    assert.ok(!result.message.includes('super-secret-token'));
  });
});

/**
 * The whole github.com path, end to end.
 *
 * Every piece of it is unit tested elsewhere, and it still failed in a real installation: the API root
 * was resolved wrongly, so a correct repository produced a 404 that blamed the repository. These tests
 * take the same route a run takes — connection, factory, connector, payload — and assert the URLs that
 * actually leave the process.
 */
describe('pull requests from github.com', () => {
  const github: EndpointConfig = { ...repos, baseUrl: 'https://github.com' };

  const pullRequests = [
    {
      number: 7,
      title: 'Fix the leader lock heartbeat',
      body: 'The lock was never refreshed.',
      state: 'open',
      draft: false,
      created_at: '2026-08-15T08:00:00Z',
      updated_at: '2026-08-17T09:00:00Z',
      user: { login: 'alex' },
      head: { ref: 'fix/heartbeat' },
      base: { ref: 'main' },
    },
    {
      number: 8,
      title: 'Add the result writer',
      body: null,
      state: 'closed',
      draft: false,
      created_at: '2026-08-17T07:00:00Z',
      updated_at: '2026-08-17T07:30:00Z',
      merged_at: '2026-08-17T07:30:00Z',
      user: { login: 'sam' },
      head: { ref: 'feature/results' },
      base: { ref: 'main' },
    },
  ];

  it('asks api.github.com for the repository the agent named', async () => {
    const { factory, urls, headers } = await factoryWith(
      (secrets) => secrets.set('gitToken', 'repo-token'),
      [json(pullRequests)],
    );

    const connector = await factory.createRepositoryHost(github);
    const result = await connector.listPullRequests({
      project: 'octo',
      repo: 'rounds',
      mode: 'updatedPullRequests',
      maxResults: 10,
    });

    const url = new URL(urls[0] ?? '');
    assert.equal(url.origin, 'https://api.github.com');
    assert.equal(url.pathname, '/repos/octo/rounds/pulls');
    assert.equal(url.searchParams.get('state'), 'all');
    assert.equal(url.searchParams.get('sort'), 'updated');
    assert.equal(url.searchParams.get('direction'), 'desc');
    assert.equal(headers[0]?.Authorization, 'Bearer repo-token');

    assert.deepEqual(result.items.map((item) => item.id), ['7', '8']);
    assert.equal(result.items[0]?.url, 'https://github.com/octo/rounds/pull/7');
    assert.equal(result.items[0]?.body, 'The lock was never refreshed.');
    assert.equal(result.items[0]?.extra.author, 'alex');
    assert.equal(result.items[1]?.extra.mergedAt, '2026-08-17T07:30:00Z');
    assert.equal(result.cursor, '2026-08-17T09:00:00Z');
    assert.equal(result.truncated, false);
  });

  it('carries the cursor forward so a second run sees only what changed', async () => {
    const { factory } = await factoryWith(
      (secrets) => secrets.set('gitToken', 'repo-token'),
      [json(pullRequests)],
    );

    const connector = await factory.createRepositoryHost(github);
    const result = await connector.listPullRequests({
      project: 'octo',
      repo: 'rounds',
      mode: 'updatedPullRequests',
      cursor: '2026-08-17T08:00:00Z',
    });

    assert.deepEqual(result.items.map((item) => item.id), ['7']);
  });

  it('fetches the diff as a diff, from the same API host', async () => {
    const diff = 'diff --git a/file b/file\n+added line\n';
    const { factory, urls, headers } = await factoryWith(
      (secrets) => secrets.set('gitToken', 'repo-token'),
      [{ status: 200, headers: { get: () => null }, text: () => Promise.resolve(diff) }],
    );

    const connector = await factory.createRepositoryHost(github);
    const result = await connector.getDiff('octo', 'rounds', '7');

    assert.equal(urls[0], 'https://api.github.com/repos/octo/rounds/pulls/7');
    assert.match(headers[0]?.Accept ?? '', /diff/);
    assert.equal(result.text, diff);
  });

  it('names the path when the host has nothing there', async () => {
    const { factory } = await factoryWith(
      (secrets) => secrets.set('gitToken', 'repo-token'),
      [json({ message: 'Not Found' }, 404)],
    );

    const connector = await factory.createRepositoryHost(github);
    await assert.rejects(
      connector.listPullRequests({ project: 'octo', repo: 'rounds', mode: 'newPullRequests' }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /has nothing at \/repos\/octo\/rounds\/pulls/);
        return true;
      },
    );
  });
});

describe('where the API lives', () => {
  const git = (baseUrl: string): EndpointConfig => ({
    name: 'repos',
    kind: 'git',
    baseUrl,
    authScheme: 'bearer',
  });

  it('sends github.com to its API host, not to a path under it', () => {
    // The reported failure: /api/v3 under github.com is a 404 that reads as "you typed the repository
    // wrong", which is the wrong thing to say to somebody who typed it correctly.
    assert.equal(resolveApiRoot(git('https://github.com')), 'https://api.github.com/');
    assert.equal(resolveApiRoot(git('https://www.github.com/')), 'https://api.github.com/');
  });

  it('leaves a base URL that already points at an API root alone', () => {
    assert.equal(resolveApiRoot(git('https://api.github.com')), 'https://api.github.com/');
  });

  it('uses the enterprise path for a self-hosted installation', () => {
    assert.equal(resolveApiRoot(git('https://git.example.invalid')), 'https://git.example.invalid/api/v3/');
  });

  it('names the hosts it does not speak instead of failing later with a 404', () => {
    for (const host of ['https://gitlab.com', 'https://dev.azure.com', 'https://codeberg.org']) {
      assert.throws(() => resolveApiRoot(git(host)), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /not supported yet/);
        assert.match(error.message, /Bitbucket Cloud/);
        return true;
      }, host);
    }
  });

  it('sends bitbucket.org to its own API host', () => {
    assert.equal(resolveApiRoot(git('https://bitbucket.org')), 'https://api.bitbucket.org/2.0/');
    assert.equal(resolveApiRoot(git('https://api.bitbucket.org/')), 'https://api.bitbucket.org/2.0/');
  });

  it('uses the versioned path for a host declared as the hosted Bitbucket API', () => {
    assert.equal(
      resolveApiRoot({ ...git('https://bb.example.invalid'), provider: 'bitbucketCloud' }),
      'https://bb.example.invalid/2.0/',
    );
  });

  it('uses REST 1.0 for a self-hosted Bitbucket installation, context path included', () => {
    // The self-hosted product shares the name and not the API: 2.0 endpoints do not exist there.
    assert.equal(
      resolveApiRoot({ ...git('https://bitbucket.example.invalid'), provider: 'bitbucketServer' }),
      'https://bitbucket.example.invalid/rest/api/1.0/',
    );
    assert.equal(
      resolveApiRoot({ ...git('https://tools.example.invalid/bitbucket/'), provider: 'bitbucketServer' }),
      'https://tools.example.invalid/bitbucket/rest/api/1.0/',
    );
  });

  it('does not repeat the REST path a careful user already typed', () => {
    assert.equal(
      resolveApiRoot({
        ...git('https://bitbucket.example.invalid/rest/api/1.0'),
        provider: 'bitbucketServer',
      }),
      'https://bitbucket.example.invalid/rest/api/1.0/',
    );
  });

  it('recognises the provider from the host, and lets a stored choice win', () => {
    assert.equal(resolveProvider(git('https://bitbucket.org')), 'bitbucketCloud');
    assert.equal(resolveProvider(git('https://github.com')), 'github');
    // A self-hosted installation cannot be recognised from its address, so the wizard stores the
    // answer and it has to survive.
    assert.equal(resolveProvider(git('https://git.example.invalid')), 'github');
    assert.equal(
      resolveProvider({ ...git('https://git.example.invalid'), provider: 'bitbucketCloud' }),
      'bitbucketCloud',
    );
  });

  it('stays silent about a host that does not announce its API, so the wizard asks', () => {
    assert.equal(providerFromHost('https://bitbucket.org/'), 'bitbucketCloud');
    assert.equal(providerFromHost('https://github.com'), 'github');
    assert.equal(providerFromHost('https://git.example.invalid'), undefined);
    assert.equal(providerFromHost('whatever the user typed'), undefined);
  });

  it('builds the tracker API path from the configured host', () => {
    assert.equal(
      resolveApiRoot({ name: 'tracker', kind: 'jira', baseUrl: 'https://tracker.invalid/', authScheme: 'bearer' }),
      'https://tracker.invalid/rest/api/2/',
    );
  });
});
