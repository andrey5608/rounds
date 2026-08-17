import type { StoreLogger } from '../state/store.js';

import { AuthError, ConfigError, NetworkError, RateLimitError } from './errors.js';

/** The part of `fetch` this client uses, so tests can supply their own. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: 'follow' | 'error' | 'manual';
  },
) => Promise<HttpResponseLike>;

export interface HttpResponseLike {
  status: number;
  statusText?: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface HttpClientOptions {
  /** Only this host may be contacted. Everything else fails closed. */
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
  logger?: StoreLogger;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Injectable so retry tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  userAgent?: string;
}

export interface RequestOptions {
  /** Path relative to the base URL, or an absolute URL on the same host. */
  path: string;
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_LOGGED_BODY = 500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The one place that performs outbound requests.
 *
 * Two rules are enforced here rather than trusted elsewhere. Every request must go to the
 * configured host — that is how "network access is limited to the base URLs the user
 * configured" becomes a property of the code instead of a promise in a README. And redirects
 * are never followed off that host, because a redirect is exactly how a request to a
 * configured host ends up somewhere else carrying the token.
 */
export class HttpClient {
  private readonly base: URL;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HttpClientOptions) {
    try {
      this.base = new URL(options.baseUrl);
    } catch {
      throw new ConfigError(`"${options.baseUrl}" is not a valid base URL.`);
    }
    if (this.base.protocol !== 'https:' && this.base.protocol !== 'http:') {
      throw new ConfigError(`The base URL ${options.baseUrl} must use http or https.`);
    }
    // The global fetch is structurally compatible with the narrow FetchLike shape used here.
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get host(): string {
    return this.base.host;
  }

  /** Builds the target URL and refuses anything that would leave the configured host. */
  resolveUrl(path: string, query?: RequestOptions['query']): string {
    const url = new URL(path, `${this.base.origin}${this.base.pathname.replace(/\/*$/, '/')}`);
    if (url.host !== this.base.host || url.protocol !== this.base.protocol) {
      throw new ConfigError(
        `Refused to contact ${url.host}: this agent may only talk to ${this.base.host}.`,
      );
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** Performs a request and returns the parsed JSON body. */
  async requestJson<T>(options: RequestOptions): Promise<T> {
    const text = await this.requestText(options);
    if (text.trim().length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch (error) {
      throw new ConfigError(
        `The host ${this.host} answered with something that is not JSON. Check that the base URL points at the API root.`,
        `${String(error)}: ${text.slice(0, MAX_LOGGED_BODY)}`,
      );
    }
  }

  /** Performs a request and returns the raw body, retrying transient failures. */
  async requestText(options: RequestOptions): Promise<string> {
    const url = this.resolveUrl(options.path, options.query);
    const method = options.method ?? 'GET';

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.attempt(url, method, options);
      } catch (error) {
        lastError = error;
        const wait = this.retryDelayMs(error, attempt);
        if (wait === undefined) {
          throw error;
        }
        this.options.logger?.debug(
          `${method} ${url} failed (attempt ${attempt}/${this.maxAttempts}); retrying in ${wait}ms.`,
        );
        await this.sleep(wait);
      }
    }
    throw lastError;
  }

  private async attempt(url: string, method: string, options: RequestOptions): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers: {
          Accept: 'application/json',
          'User-Agent': this.options.userAgent ?? 'rounds',
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...this.options.headers,
          ...options.headers,
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
        // A redirect is how a request to an allowed host ends up somewhere else, so the
        // client refuses to follow them at all.
        redirect: 'error',
      });
      return await this.readResponse(response, method, url);
    } catch (error) {
      if (error instanceof AuthError || error instanceof RateLimitError) {
        throw error;
      }
      if (error instanceof ConfigError || error instanceof NetworkError) {
        throw error;
      }
      throw new NetworkError(this.host, `${method} ${url}: ${String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readResponse(
    response: HttpResponseLike,
    method: string,
    url: string,
  ): Promise<string> {
    if (response.status >= 200 && response.status < 300) {
      return response.text();
    }
    const body = (await response.text().catch(() => '')).slice(0, MAX_LOGGED_BODY);
    const detail = `${method} ${url} -> ${response.status} ${response.statusText ?? ''} ${body}`.trim();

    if (response.status === 401 || response.status === 403) {
      throw new AuthError(this.host, detail);
    }
    if (response.status === 429) {
      throw new RateLimitError(this.host, parseRetryAfter(response.headers.get('retry-after')), detail);
    }
    if (response.status === 404) {
      throw new ConfigError(
        `The host ${this.host} does not know this path. Check the base URL and the repository or project it refers to.`,
        detail,
      );
    }
    if (response.status >= 500) {
      throw new NetworkError(this.host, detail);
    }
    throw new ConfigError(
      `The host ${this.host} rejected the request with status ${response.status}. Check the agent's source settings.`,
      detail,
    );
  }

  /** Retry delay, or `undefined` when this error must not be retried. */
  private retryDelayMs(error: unknown, attempt: number): number | undefined {
    if (attempt >= this.maxAttempts) {
      return undefined;
    }
    if (error instanceof RateLimitError) {
      return (error.retryAfterSeconds ?? 2 ** attempt) * 1000;
    }
    if (error instanceof NetworkError) {
      return 2 ** attempt * 250;
    }
    // Anything else — bad credentials, bad configuration — will fail again identically.
    return undefined;
  }
}

/** `Retry-After` is either a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number.parseInt(value, 10);
  if (!Number.isNaN(seconds) && String(seconds) === value.trim()) {
    return Math.max(0, seconds);
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.round((date - Date.now()) / 1000));
  }
  return undefined;
}
