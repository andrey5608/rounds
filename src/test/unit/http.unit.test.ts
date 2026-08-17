import * as assert from 'node:assert/strict';

import { AuthError, ConfigError, NetworkError, RateLimitError, isTransient } from '../../connectors/errors.js';
import { HttpClient, parseRetryAfter } from '../../connectors/http.js';
import type { FetchLike, HttpResponseLike } from '../../connectors/http.js';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  redirect?: string;
}

function response(
  status: number,
  body = '',
  headers: Record<string, string> = {},
): HttpResponseLike {
  return {
    status,
    statusText: 'status',
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
  };
}

function fakeFetch(
  responses: (HttpResponseLike | Error)[],
): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let index = 0;
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, redirect: init.redirect });
    const next = responses[Math.min(index, responses.length - 1)] ?? response(200, '{}');
    index += 1;
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { fetch, calls };
}

function client(
  responses: (HttpResponseLike | Error)[],
  overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {},
): { http: HttpClient; calls: Recorded[] } {
  const { fetch, calls } = fakeFetch(responses);
  const http = new HttpClient({
    baseUrl: 'https://tracker.invalid/rest/api/2',
    fetch,
    sleep: () => Promise.resolve(),
    headers: { Authorization: 'Bearer secret-token-value' },
    ...overrides,
  });
  return { http, calls };
}

describe('http client', () => {
  it('rejects a base URL that is not a URL', () => {
    assert.throws(() => new HttpClient({ baseUrl: 'not a url' }), ConfigError);
  });

  it('rejects a base URL that is not http or https', () => {
    assert.throws(() => new HttpClient({ baseUrl: 'ftp://example.invalid' }), ConfigError);
  });

  it('resolves a relative path against the base path', () => {
    const { http } = client([response(200, '{}')]);
    assert.equal(
      http.resolveUrl('search', { jql: 'project = ROUNDS', maxResults: 10 }),
      'https://tracker.invalid/rest/api/2/search?jql=project+%3D+ROUNDS&maxResults=10',
    );
  });

  it('refuses a path that would leave the configured host', () => {
    const { http } = client([response(200, '{}')]);
    assert.throws(() => http.resolveUrl('https://evil.invalid/steal'), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /may only talk to tracker.invalid/);
      return true;
    });
  });

  it('never follows redirects', async () => {
    const { http, calls } = client([response(200, '{"ok":true}')]);
    await http.requestJson({ path: 'search' });
    assert.equal(calls[0]?.redirect, 'error');
  });

  it('returns parsed JSON and sends the configured headers', async () => {
    const { http, calls } = client([response(200, '{"total":2}')]);
    const body = await http.requestJson<{ total: number }>({ path: 'search' });

    assert.deepEqual(body, { total: 2 });
    assert.equal(calls[0]?.headers.Authorization, 'Bearer secret-token-value');
    assert.equal(calls[0]?.headers['User-Agent'], 'rounds');
  });

  it('turns a body that is not JSON into a configuration error', async () => {
    const { http } = client([response(200, '<html>login</html>')]);
    await assert.rejects(http.requestJson({ path: 'search' }), (error: unknown) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /not JSON/);
      return true;
    });
  });

  it('maps 401 and 403 to an authentication error without retrying', async () => {
    for (const status of [401, 403]) {
      const { http, calls } = client([response(status, 'nope')]);
      await assert.rejects(http.requestJson({ path: 'search' }), AuthError);
      assert.equal(calls.length, 1, `status ${status} must not be retried`);
    }
  });

  it('maps 404 to a configuration error', async () => {
    const { http } = client([response(404, 'not found')]);
    await assert.rejects(http.requestJson({ path: 'search' }), ConfigError);
  });

  it('retries a server error and succeeds afterwards', async () => {
    const { http, calls } = client([response(500, 'boom'), response(200, '{"ok":true}')]);
    assert.deepEqual(await http.requestJson({ path: 'search' }), { ok: true });
    assert.equal(calls.length, 2);
  });

  it('gives up on a server error after the attempt limit', async () => {
    const { http, calls } = client([response(503, 'down')], { maxAttempts: 3 });
    await assert.rejects(http.requestJson({ path: 'search' }), NetworkError);
    assert.equal(calls.length, 3);
  });

  it('honours Retry-After on a rate limit and then succeeds', async () => {
    const waits: number[] = [];
    const { http, calls } = client(
      [response(429, 'slow down', { 'retry-after': '7' }), response(200, '{"ok":true}')],
      {
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      },
    );

    await http.requestJson({ path: 'search' });
    assert.deepEqual(waits, [7000]);
    assert.equal(calls.length, 2);
  });

  it('reports a rate limit that never clears, with the wait it asked for', async () => {
    const { http } = client([response(429, 'slow down', { 'retry-after': '3' })]);
    await assert.rejects(http.requestJson({ path: 'search' }), (error: unknown) => {
      assert.ok(error instanceof RateLimitError);
      assert.equal(error.retryAfterSeconds, 3);
      assert.match(error.message, /wait 3s/);
      return true;
    });
  });

  it('turns a transport failure into a network error', async () => {
    const { http } = client([new Error('ECONNREFUSED')], { maxAttempts: 1 });
    await assert.rejects(http.requestJson({ path: 'search' }), NetworkError);
  });

  it('marks network and rate limit failures as worth retrying later', () => {
    assert.equal(isTransient(new NetworkError('host')), true);
    assert.equal(isTransient(new RateLimitError('host')), true);
    assert.equal(isTransient(new AuthError('host')), false);
    assert.equal(isTransient(new ConfigError('bad')), false);
  });

  it('points auth and config failures at the setup command', () => {
    assert.equal(new AuthError('host').fixCommand, 'rounds.checkSetup');
    assert.equal(new ConfigError('bad').fixCommand, 'rounds.checkSetup');
    assert.equal(new NetworkError('host').fixCommand, undefined);
  });
});

describe('retry-after parsing', () => {
  it('reads a number of seconds', () => {
    assert.equal(parseRetryAfter('42'), 42);
  });

  it('reads an HTTP date as seconds from now', () => {
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    const parsed = parseRetryAfter(inTenSeconds);
    assert.ok(parsed !== undefined && parsed >= 8 && parsed <= 11, `unexpected ${String(parsed)}`);
  });

  it('never returns a negative wait', () => {
    assert.equal(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString()), 0);
  });

  it('ignores nonsense', () => {
    assert.equal(parseRetryAfter('soon'), undefined);
    assert.equal(parseRetryAfter(null), undefined);
  });
});
