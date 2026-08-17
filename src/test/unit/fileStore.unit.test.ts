import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileStateBackend, STATE_FILE_NAME, StateFileWatcher } from '../../state/fileStore.js';
import { RoundsStore } from '../../state/store.js';
import type { MementoLike, StoreLogger } from '../../state/store.js';
import type { PersistedState } from '../../state/types.js';

class FakeMemento implements MementoLike {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

class RecordingLogger implements StoreLogger {
  readonly lines: string[] = [];

  debug(message: string): void {
    this.lines.push(`debug ${message}`);
  }

  info(message: string): void {
    this.lines.push(`info ${message}`);
  }

  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }

  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
}

function sampleState(revision: number): PersistedState {
  return {
    schemaVersion: 1,
    revision,
    agents: [],
    history: {},
    counters: { localDate: '2026-08-17', global: revision, perAgent: {} },
    runClaims: {},
    setup: {},
  };
}

async function temporaryDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rounds-state-'));
}

describe('file state backend', () => {
  it('writes the state file and reads it back', async () => {
    const directory = await temporaryDirectory();
    const backend = new FileStateBackend({ directory });

    assert.equal(await backend.load(), undefined);
    await backend.save(sampleState(1));

    const loaded = (await backend.load()) as PersistedState;
    assert.equal(loaded.revision, 1);
    assert.equal(await backend.peekRevision(), 1);
  });

  it('leaves no temporary files behind', async () => {
    const directory = await temporaryDirectory();
    const backend = new FileStateBackend({ directory });
    await backend.save(sampleState(1));
    await backend.save(sampleState(2));

    const entries = await readdir(directory);
    assert.deepEqual(entries, [STATE_FILE_NAME]);
  });

  it('mirrors the state into global state', async () => {
    const directory = await temporaryDirectory();
    const memento = new FakeMemento();
    const backend = new FileStateBackend({ directory, memento });
    await backend.save(sampleState(3));

    assert.equal(memento.get('rounds.stateRevision'), 3);
    assert.deepEqual(memento.get('rounds.agents'), []);
  });

  it('recovers from global state when the file is missing', async () => {
    const directory = await temporaryDirectory();
    const memento = new FakeMemento();
    const logger = new RecordingLogger();
    await new FileStateBackend({ directory, memento }).save(sampleState(4));

    // A different directory stands in for a wiped storage folder.
    const emptyDirectory = await temporaryDirectory();
    const backend = new FileStateBackend({ directory: emptyDirectory, memento, logger });
    const loaded = (await backend.load()) as PersistedState;

    assert.equal(loaded.revision, 4);
    assert.ok(logger.lines.some((line) => line.startsWith('warn')));
  });

  it('quarantines a corrupt state file and keeps working', async () => {
    const directory = await temporaryDirectory();
    const memento = new FakeMemento();
    const logger = new RecordingLogger();
    const backend = new FileStateBackend({
      directory,
      memento,
      logger,
      now: () => new Date('2026-08-17T06:00:00.000Z'),
    });

    await backend.save(sampleState(5));
    await writeFile(join(directory, STATE_FILE_NAME), '{ this is not json', 'utf8');

    const loaded = (await backend.load()) as PersistedState;
    assert.equal(loaded.revision, 5, 'falls back to the mirrored state');

    const entries = await readdir(directory);
    assert.ok(
      entries.some((entry) => entry.includes('.bad-')),
      `expected a quarantined file, found ${entries.join(', ')}`,
    );
    assert.ok(logger.lines.some((line) => line.includes('moved it to')));
  });

  it('serves a store that survives a restart', async () => {
    const directory = await temporaryDirectory();
    const first = new RoundsStore({
      backend: new FileStateBackend({ directory }),
      timeZone: 'UTC',
    });
    await first.update((draft) => {
      draft.counters.global = 7;
    });

    const second = new RoundsStore({
      backend: new FileStateBackend({ directory }),
      timeZone: 'UTC',
    });
    const state = await second.read();
    assert.equal(state.counters.global, 7);
    assert.equal(state.revision, 1);
  });

  it('does not let a stale window overwrite a newer state', async () => {
    const directory = await temporaryDirectory();
    const backendA = new FileStateBackend({ directory });
    const backendB = new FileStateBackend({ directory });
    const windowA = new RoundsStore({ backend: backendA, timeZone: 'UTC' });
    const windowB = new RoundsStore({ backend: backendB, timeZone: 'UTC' });

    await windowA.update((draft) => {
      draft.counters.global = 1;
    });
    // Window B still holds the state from before that write.
    await windowB.read();
    await windowB.update((draft) => {
      draft.counters.global += 10;
    });

    const stored = JSON.parse(
      await readFile(join(directory, STATE_FILE_NAME), 'utf8'),
    ) as PersistedState;
    assert.equal(stored.counters.global, 11, 'window A change survived');
    assert.equal(stored.revision, 2);
  });

  it('notices a write made by another window', async () => {
    const directory = await temporaryDirectory();
    const backend = new FileStateBackend({ directory });
    await backend.save(sampleState(1));

    let changes = 0;
    const watcher = new StateFileWatcher({
      backend,
      onChanged: () => {
        changes += 1;
      },
    });
    await watcher.start();

    await watcher.check();
    assert.equal(changes, 0, 'an unchanged file is not reported');

    // A different modification time is what the watcher looks for.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await backend.save(sampleState(2));
    await watcher.check();
    assert.equal(changes, 1);

    watcher.dispose();
  });
});
