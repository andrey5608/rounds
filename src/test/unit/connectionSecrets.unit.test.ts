import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { tokenFor } from '../../connectors/factory.js';
import { migrateConnectionSecrets } from '../../setup/connectionSecrets.js';
import { FileStateBackend } from '../../state/fileStore.js';
import { Logger } from '../../state/logger.js';
import { RoundsSecrets } from '../../state/secrets.js';
import type { SecretStorageLike } from '../../state/secrets.js';
import { RoundsStore } from '../../state/store.js';
import type { EndpointConfig } from '../../state/types.js';
import { Emitter } from '../../state/emitter.js';

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

  onDidChange(listener: (event: { key: string }) => void) {
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
  baseUrl: 'https://github.com',
  authScheme: 'bearer',
};

async function harness(): Promise<{
  store: RoundsStore;
  secrets: RoundsSecrets;
  storage: FakeSecretStorage;
  cleanup: () => Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'rounds-secrets-'));
  const logger = new Logger({ sink: { append: () => undefined }, getLevel: () => 'none' });
  const memento = new Map<string, unknown>();
  const store = new RoundsStore({
    backend: new FileStateBackend({
      directory,
      memento: {
        get: <T,>(key: string) => memento.get(key) as T | undefined,
        update: (key: string, value: unknown) => {
          memento.set(key, value);
          return Promise.resolve();
        },
      },
      logger,
    }),
    logger,
  });
  const storage = new FakeSecretStorage();
  const secrets = new RoundsSecrets(storage);

  await store.update((draft) => {
    draft.endpoints.tracker = { ...tracker };
    draft.endpoints.repos = { ...repos };
  });

  return {
    store,
    secrets,
    storage,
    cleanup: async () => {
      secrets.dispose();
      store.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe('giving every connection its own token', () => {
  it('copies the shared token to a key of its own and keeps the old one', async () => {
    const { store, secrets, storage, cleanup } = await harness();
    try {
      await secrets.set('jiraToken', 'tracker-token');
      await secrets.set('gitToken', 'repo-token');

      const migrated = await migrateConnectionSecrets(store, secrets);
      assert.equal(migrated, 2);

      const state = await store.read();
      const trackerRef = state.endpoints.tracker?.secretRef;
      assert.ok(trackerRef, 'the connection carries a reference of its own');
      assert.equal(await secrets.getForConnection(trackerRef), 'tracker-token');

      // The shared key is left alone: a token that vanishes because a migration ran in the wrong
      // window cannot be recovered, and nobody keeps a copy.
      assert.equal(storage.values.get('rounds.secret.jiraToken'), 'tracker-token');
    } finally {
      await cleanup();
    }
  });

  it('is safe to run twice', async () => {
    const { store, secrets, cleanup } = await harness();
    try {
      await secrets.set('jiraToken', 'tracker-token');
      await migrateConnectionSecrets(store, secrets);
      const first = (await store.read()).endpoints.tracker?.secretRef;

      assert.equal(await migrateConnectionSecrets(store, secrets), 0);
      assert.equal((await store.read()).endpoints.tracker?.secretRef, first);
    } finally {
      await cleanup();
    }
  });

  it('still gives a connection with no token a reference to store one under', async () => {
    const { store, secrets, cleanup } = await harness();
    try {
      await migrateConnectionSecrets(store, secrets);
      const state = await store.read();

      assert.ok(state.endpoints.repos?.secretRef);
      assert.equal(await secrets.getForConnection(state.endpoints.repos.secretRef), undefined);
    } finally {
      await cleanup();
    }
  });

  it('lets two repository connections hold different tokens', async () => {
    // The defect this phase exists for: one key per source kind meant the second repository
    // connection silently authenticated as the first.
    const { store, secrets, cleanup } = await harness();
    try {
      await store.update((draft) => {
        draft.endpoints.bitbucket = {
          name: 'bitbucket',
          kind: 'git',
          baseUrl: 'https://bitbucket.org',
          authScheme: 'bearer',
        };
      });
      await migrateConnectionSecrets(store, secrets);

      const state = await store.read();
      const github = state.endpoints.repos;
      const bitbucket = state.endpoints.bitbucket;
      assert.ok(github?.secretRef && bitbucket?.secretRef);
      assert.notEqual(github.secretRef, bitbucket.secretRef);

      await secrets.setForConnection(github.secretRef, 'github-token');
      await secrets.setForConnection(bitbucket.secretRef, 'bitbucket-token');

      assert.equal(await tokenFor(secrets, github), 'github-token');
      assert.equal(await tokenFor(secrets, bitbucket), 'bitbucket-token');
    } finally {
      await cleanup();
    }
  });

  it('falls back to the shared key while a connection has none of its own', async () => {
    const { secrets, cleanup } = await harness();
    try {
      await secrets.set('gitToken', 'repo-token');
      assert.equal(await tokenFor(secrets, repos), 'repo-token');

      // And a reference whose value was never stored falls back too, rather than failing.
      assert.equal(await tokenFor(secrets, { ...repos, secretRef: 'missing' }), 'repo-token');
    } finally {
      await cleanup();
    }
  });

  it('offers a connection token to the logger for redaction', async () => {
    const { secrets, cleanup } = await harness();
    try {
      await secrets.setForConnection('ref-1', 'a-very-secret-token');
      assert.ok(secrets.knownValues().includes('a-very-secret-token'));
    } finally {
      await cleanup();
    }
  });
});
