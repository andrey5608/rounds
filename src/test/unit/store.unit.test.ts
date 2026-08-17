import * as assert from 'node:assert/strict';

import { MementoBackend, RoundsStore, STATE_KEYS, StateConflictError } from '../../state/store.js';
import type { MementoLike, StateBackend } from '../../state/store.js';
import { FixedClock } from '../../state/time.js';
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

function makeStore(backend: StateBackend): RoundsStore {
  return new RoundsStore({
    backend,
    clock: new FixedClock(new Date('2026-08-17T06:00:00.000Z')),
    timeZone: 'UTC',
  });
}

describe('state store', () => {
  it('starts from an empty state and stores the first write', async () => {
    const memento = new FakeMemento();
    const store = makeStore(new MementoBackend(memento));

    const initial = await store.read();
    assert.deepEqual(initial.agents, []);
    assert.equal(initial.revision, 0);

    const updated = await store.update((draft) => {
      draft.counters.global = 1;
    });
    assert.equal(updated.revision, 1);
    assert.equal(memento.get(STATE_KEYS.revision), 1);
  });

  it('keeps the revision moving forward on every write', async () => {
    const store = makeStore(new MementoBackend(new FakeMemento()));
    await store.update((draft) => {
      draft.counters.global = 1;
    });
    const second = await store.update((draft) => {
      draft.counters.global += 1;
    });
    assert.equal(second.revision, 2);
    assert.equal(second.counters.global, 2);
  });

  it('reloads and re-applies the mutation when another window wrote first', async () => {
    const memento = new FakeMemento();
    const backend = new MementoBackend(memento);
    const store = makeStore(backend);
    await store.update((draft) => {
      draft.counters.global = 1;
    });

    // Simulate a second window that stores its own change between our read and our write.
    let interfered = false;
    const racing: StateBackend = {
      load: () => backend.load(),
      peekRevision: async () => {
        if (!interfered) {
          interfered = true;
          const current = (await backend.load()) as PersistedState;
          await backend.save({
            ...current,
            revision: current.revision + 1,
            counters: { ...current.counters, global: 41 },
          });
        }
        return backend.peekRevision();
      },
      save: (state) => backend.save(state),
    };

    const racingStore = makeStore(racing);
    const result = await racingStore.update((draft) => {
      draft.counters.global += 1;
    });

    // The other window's value survived and our mutation was applied on top of it.
    assert.equal(result.counters.global, 42);
    assert.equal(result.revision, 3);
  });

  it('gives up with a conflict error when every attempt loses the race', async () => {
    const memento = new FakeMemento();
    const backend = new MementoBackend(memento);
    await backend.save({
      schemaVersion: 1,
      revision: 1,
      agents: [],
      history: {},
      counters: { localDate: '2026-08-17', global: 0, perAgent: {} },
      runClaims: {},
    });

    let phantom = 100;
    const hostile: StateBackend = {
      load: () => backend.load(),
      peekRevision: () => {
        phantom += 1;
        return Promise.resolve(phantom);
      },
      save: (state) => backend.save(state),
    };

    const store = new RoundsStore({ backend: hostile, maxAttempts: 3, timeZone: 'UTC' });
    await assert.rejects(
      store.update((draft) => {
        draft.counters.global += 1;
      }),
      (error: unknown) => error instanceof StateConflictError && error.attempts === 3,
    );
  });

  it('serializes concurrent updates instead of interleaving them', async () => {
    const store = makeStore(new MementoBackend(new FakeMemento()));
    await Promise.all(
      Array.from({ length: 10 }, () =>
        store.update((draft) => {
          draft.counters.global += 1;
        }),
      ),
    );
    const state = await store.read();
    assert.equal(state.counters.global, 10);
    assert.equal(state.revision, 10);
  });

  it('notifies listeners about local and external changes', async () => {
    const memento = new FakeMemento();
    const backend = new MementoBackend(memento);
    const store = makeStore(backend);
    const seen: boolean[] = [];
    store.onDidChange((change) => seen.push(change.external));

    await store.update((draft) => {
      draft.counters.global = 1;
    });

    // Another window writes directly to the backend, then we notice it.
    const current = (await backend.load()) as PersistedState;
    await backend.save({ ...current, revision: current.revision + 1 });
    await store.refreshFromExternalChange();

    assert.deepEqual(seen, [false, true]);
  });

  it('stays quiet when an external refresh finds nothing new', async () => {
    const store = makeStore(new MementoBackend(new FakeMemento()));
    await store.update((draft) => {
      draft.counters.global = 1;
    });
    let notifications = 0;
    store.onDidChange(() => {
      notifications += 1;
    });
    await store.refreshFromExternalChange();
    assert.equal(notifications, 0);
  });

  it('survives a listener that throws', async () => {
    const store = makeStore(new MementoBackend(new FakeMemento()));
    store.onDidChange(() => {
      throw new Error('listener is broken');
    });
    const state = await store.update((draft) => {
      draft.counters.global = 5;
    });
    assert.equal(state.counters.global, 5);
  });
});
