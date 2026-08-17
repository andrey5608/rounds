import * as assert from 'node:assert/strict';

import { ConnectorFactory, authorizationHeader, resolveEndpoint } from '../../connectors/factory.js';
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
      repo: 'octo/rounds',
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
