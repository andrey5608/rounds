import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authorizationHeader } from '../../connectors/factory.js';
import { Emitter } from '../../state/emitter.js';
import type { Disposable } from '../../state/emitter.js';
import { FileStateBackend, STATE_FILE_NAME } from '../../state/fileStore.js';
import { Logger, MemorySink } from '../../state/logger.js';
import { RoundsSecrets } from '../../state/secrets.js';
import type { SecretStorageLike } from '../../state/secrets.js';
import { RoundsStore } from '../../state/store.js';
import type { MementoLike } from '../../state/store.js';

/** A value distinctive enough that finding it anywhere is unambiguous. */
const TOKEN = 'rounds-test-token-2f7a91c4e8';

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

class RecordingMemento implements MementoLike {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

/**
 * The audit the specification asks for: a stored token must not turn up anywhere else.
 *
 * Written as a test rather than trusted as a design property, because every one of these places is a
 * file or a buffer a user might paste into an issue report.
 */
describe('secret hygiene', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rounds-secrets-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('keeps the token out of the state file and out of global state', async () => {
    const secrets = new RoundsSecrets(new FakeSecretStorage());
    await secrets.set('jiraToken', TOKEN);

    const memento = new RecordingMemento();
    const store = new RoundsStore({
      backend: new FileStateBackend({ directory, memento }),
      timeZone: 'UTC',
    });

    // A realistic state: an endpoint, an agent, a run and the setup slice.
    await store.update((draft) => {
      draft.endpoints = {
        tracker: {
          name: 'tracker',
          kind: 'jira',
          baseUrl: 'https://tracker.invalid',
          authScheme: 'basic',
          username: 'alex@example.invalid',
        },
      };
      draft.agents = [
        {
          id: 'agent-1',
          name: 'Morning triage',
          enabled: true,
          executionMode: 'api',
          schedule: { cronExpressions: ['0 9 * * *'], runOnStartup: false, missedRunPolicy: 'skip' },
          source: { kind: 'jira', baseUrlRef: 'tracker', jql: 'project = ROUNDS', maxResults: 20 },
          prompt: { source: 'inline', inlineText: 'Summarize {{items}}' },
          modelId: 'model-a',
          tools: [],
          createdAt: '2026-08-01T00:00:00.000Z',
          updatedAt: '2026-08-01T00:00:00.000Z',
        },
      ];
      draft.setup.consentGrantedAt = '2026-08-01T00:00:00.000Z';
    });

    const stateFile = await readFile(join(directory, STATE_FILE_NAME), 'utf8');
    assert.ok(!stateFile.includes(TOKEN), 'the state file holds no token');

    const dumped = JSON.stringify([...memento.values.entries()]);
    assert.ok(!dumped.includes(TOKEN), 'global state holds no token');
  });

  it('keeps the token out of the output channel, by value and by pattern', () => {
    const secrets = new RoundsSecrets(new FakeSecretStorage());
    const sink = new MemorySink();
    const logger = new Logger({
      sink,
      getLevel: () => 'debug',
      getRedactions: () => secrets.knownValues(),
    });

    // Before the value is known to the secret store, the pattern rules still apply.
    logger.info(`GET https://alex:${TOKEN}@tracker.invalid/rest/api/2/myself`);
    logger.debug(`headers {"Authorization": "Bearer ${TOKEN}"}`);
    logger.warn(`sent Basic ${TOKEN}`);

    for (const line of sink.lines) {
      assert.ok(!line.includes(TOKEN), `a token reached the log: ${line}`);
    }
  });

  it('redacts a token by value once the secret store has seen it', async () => {
    const secrets = new RoundsSecrets(new FakeSecretStorage());
    await secrets.set('gitToken', TOKEN);

    const sink = new MemorySink();
    const logger = new Logger({
      sink,
      getLevel: () => 'debug',
      getRedactions: () => secrets.knownValues(),
    });

    // A message with no recognisable shape at all: only knowing the value can catch this.
    logger.info(`the configured credential is ${TOKEN} apparently`);

    assert.equal(sink.lines.length, 1);
    assert.ok(!sink.lines[0]?.includes(TOKEN));
    assert.match(sink.lines[0] ?? '', /credential is \*\*\* apparently/);
  });

  it('never puts the token in a request URL', () => {
    // Basic authentication encodes it in a header; the client refuses credentials in a URL outright.
    const header = authorizationHeader(
      {
        name: 'tracker',
        kind: 'jira',
        baseUrl: 'https://tracker.invalid',
        authScheme: 'basic',
        username: 'alex@example.invalid',
      },
      TOKEN,
    );
    assert.match(header, /^Basic /);
    assert.ok(!header.includes(TOKEN), 'the token is encoded, not pasted');
  });
});
