import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Emitter } from '../../state/emitter.js';
import type { Disposable } from '../../state/emitter.js';
import { RoundsSecrets, SECRET_KEYS } from '../../state/secrets.js';
import type { SecretStorageLike } from '../../state/secrets.js';

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

  /** Simulates another window storing a secret. */
  fireExternalChange(key: string): void {
    this.emitter.fire({ key });
  }
}

describe('secret storage', () => {
  it('stores and reads a token under the specified key', async () => {
    const storage = new FakeSecretStorage();
    const secrets = new RoundsSecrets(storage);

    assert.equal(await secrets.get('jiraToken'), undefined);
    await secrets.set('jiraToken', 'token-value');

    assert.equal(storage.values.get(SECRET_KEYS.jiraToken), 'token-value');
    assert.equal(await secrets.get('jiraToken'), 'token-value');
    assert.equal(await secrets.has('jiraToken'), true);
  });

  it('deletes a token', async () => {
    const storage = new FakeSecretStorage();
    const secrets = new RoundsSecrets(storage);
    await secrets.set('gitToken', 'token-value');
    await secrets.delete('gitToken');

    assert.equal(await secrets.has('gitToken'), false);
    assert.equal(storage.values.size, 0);
  });

  it('reports changes made elsewhere and forgets the cached value', async () => {
    const storage = new FakeSecretStorage();
    const secrets = new RoundsSecrets(storage);
    await secrets.set('jiraToken', 'first-token-value');

    const seen: string[] = [];
    secrets.onDidChange((name) => seen.push(name));

    storage.values.set(SECRET_KEYS.jiraToken, 'second-token-value');
    storage.fireExternalChange(SECRET_KEYS.jiraToken);

    assert.deepEqual(seen, ['jiraToken']);
    assert.equal(await secrets.get('jiraToken'), 'second-token-value');
  });

  it('ignores changes to keys that belong to somebody else', async () => {
    const storage = new FakeSecretStorage();
    const secrets = new RoundsSecrets(storage);
    let notifications = 0;
    secrets.onDidChange(() => {
      notifications += 1;
    });

    storage.fireExternalChange('some.other.extension.token');
    assert.equal(notifications, 0);
    await Promise.resolve();
  });

  it('offers known values for redaction but ignores short ones', async () => {
    const storage = new FakeSecretStorage();
    const secrets = new RoundsSecrets(storage);
    await secrets.set('jiraToken', 'long-enough-token');
    await secrets.set('gitToken', 'short');

    assert.deepEqual(secrets.knownValues(), ['long-enough-token']);
  });

  it('keeps secret keys out of the persistence layer', () => {
    const root = resolve(__dirname, '../../..');
    for (const file of ['src/state/store.ts', 'src/state/fileStore.ts', 'src/state/types.ts']) {
      const source = readFileSync(resolve(root, file), 'utf8');
      assert.ok(
        !source.includes('rounds.secret.'),
        `${file} must not reference secret storage keys`,
      );
    }
  });
});
