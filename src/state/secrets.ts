import { Emitter } from './emitter.js';
import type { Disposable } from './emitter.js';

/** Secret storage keys, exactly as specified in plan.md. */
export const SECRET_KEYS = {
  jiraToken: 'rounds.secret.jiraToken',
  gitToken: 'rounds.secret.gitToken',
} as const;

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
  private readonly subscription: Disposable;

  constructor(private readonly storage: SecretStorageLike) {
    this.subscription = storage.onDidChange((event) => {
      const name = SECRET_NAMES.find((candidate) => SECRET_KEYS[candidate] === event.key);
      if (!name) {
        return;
      }
      this.cache.delete(name);
      this.changeEmitter.fire(name);
    });
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
    return [...this.cache.values()].filter((value) => value.length >= 8);
  }

  dispose(): void {
    this.subscription.dispose();
    this.changeEmitter.dispose();
    this.cache.clear();
  }
}
