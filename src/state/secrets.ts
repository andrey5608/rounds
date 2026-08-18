import { Emitter } from './emitter.js';
import type { Disposable } from './emitter.js';

/**
 * The two keys `plan.md` fixed, one per source kind.
 *
 * Kept because installations have tokens under them, but they are no longer where a token is
 * written: with GitHub, Bitbucket Cloud and self-hosted Bitbucket all supported, one key per kind
 * meant two repository connections sharing a token. Connections now carry their own key; these
 * two are the migration source and the fallback for a connection that has not been migrated yet.
 */
export const SECRET_KEYS = {
  jiraToken: 'rounds.secret.jiraToken',
  gitToken: 'rounds.secret.gitToken',
} as const;

/** Prefix of the per-connection keys: `rounds.secret.connection.<secretRef>`. */
export const CONNECTION_SECRET_PREFIX = 'rounds.secret.connection.';

/** The storage key a connection's token lives under. */
export function connectionSecretKey(secretRef: string): string {
  return `${CONNECTION_SECRET_PREFIX}${secretRef}`;
}

export type SecretName = keyof typeof SECRET_KEYS;

export const SECRET_NAMES = Object.keys(SECRET_KEYS) as SecretName[];

/** The slice of the editor's `SecretStorage` this layer needs. */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
  onDidChange(listener: (event: { key: string }) => void): Disposable;
}

/**
 * The only place that touches stored tokens.
 *
 * Tokens live in the editor's secret storage and nowhere else: not in settings, not in
 * global state, not in an agent, not in a run record, not in a result file. Keeping the
 * access in one small class makes that easy to verify, and gives the logger a list of
 * values it must redact.
 */
export class RoundsSecrets {
  private readonly changeEmitter = new Emitter<SecretName>();
  private readonly cache = new Map<SecretName, string>();
  /** Per-connection tokens, keyed by `secretRef`. Same purpose as `cache`, different key space. */
  private readonly connectionCache = new Map<string, string>();
  private readonly subscription: Disposable;

  constructor(private readonly storage: SecretStorageLike) {
    this.subscription = storage.onDidChange((event) => {
      if (event.key.startsWith(CONNECTION_SECRET_PREFIX)) {
        this.connectionCache.delete(event.key.slice(CONNECTION_SECRET_PREFIX.length));
        return;
      }
      const name = SECRET_NAMES.find((candidate) => SECRET_KEYS[candidate] === event.key);
      if (!name) {
        return;
      }
      this.cache.delete(name);
      this.changeEmitter.fire(name);
    });
  }

  /** The token of one connection. */
  async getForConnection(secretRef: string): Promise<string | undefined> {
    const value = await this.storage.get(connectionSecretKey(secretRef));
    if (value === undefined) {
      this.connectionCache.delete(secretRef);
      return undefined;
    }
    this.connectionCache.set(secretRef, value);
    return value;
  }

  async setForConnection(secretRef: string, value: string): Promise<void> {
    await this.storage.store(connectionSecretKey(secretRef), value);
    this.connectionCache.set(secretRef, value);
  }

  /** Removes a connection's token. Called when the connection itself is deleted. */
  async deleteForConnection(secretRef: string): Promise<void> {
    await this.storage.delete(connectionSecretKey(secretRef));
    this.connectionCache.delete(secretRef);
  }

  async hasForConnection(secretRef: string): Promise<boolean> {
    return (await this.getForConnection(secretRef)) !== undefined;
  }

  /** Fires when one of our secrets was stored, changed or deleted. */
  onDidChange(listener: (name: SecretName) => void): Disposable {
    return this.changeEmitter.event(listener);
  }

  async get(name: SecretName): Promise<string | undefined> {
    const value = await this.storage.get(SECRET_KEYS[name]);
    if (value === undefined) {
      this.cache.delete(name);
      return undefined;
    }
    this.cache.set(name, value);
    return value;
  }

  async set(name: SecretName, value: string): Promise<void> {
    await this.storage.store(SECRET_KEYS[name], value);
    this.cache.set(name, value);
    this.changeEmitter.fire(name);
  }

  async delete(name: SecretName): Promise<void> {
    await this.storage.delete(SECRET_KEYS[name]);
    this.cache.delete(name);
    this.changeEmitter.fire(name);
  }

  async has(name: SecretName): Promise<boolean> {
    return (await this.get(name)) !== undefined;
  }

  /**
   * Secret values seen so far, for the logger to redact.
   *
   * This is a best-effort list: a token that was never read in this window cannot be
   * redacted by value, which is why the logger also redacts by pattern.
   */
  knownValues(): string[] {
    return [...this.cache.values(), ...this.connectionCache.values()].filter(
      (value) => value.length >= 8,
    );
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
    this.cache.clear();
    this.connectionCache.clear();
  }
}
