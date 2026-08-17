import * as assert from 'node:assert/strict';

import type {
  GatewayDisposable,
  LanguageModelGateway,
  ModelInfo,
  ModelTurn,
} from '../../model/gateway.js';
import { userAction } from '../../setup/consentGate.js';
import { ModelCatalog, ModelNotFoundError } from '../../setup/modelCatalog.js';
import { MementoBackend, RoundsStore } from '../../state/store.js';
import type { MementoLike } from '../../state/store.js';
import { FixedClock } from '../../state/time.js';

class FakeMemento implements MementoLike {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

class FakeGateway implements LanguageModelGateway {
  calls = 0;
  private listeners: (() => void)[] = [];
  models: ModelInfo[] = [
    { id: 'model-a', name: 'Model A', vendor: 'vendor', family: 'family-a' },
    { id: 'model-b', name: 'Model B', vendor: 'vendor', family: 'family-b' },
  ];
  failWith: Error | undefined;

  selectModels(): Promise<ModelInfo[]> {
    this.calls += 1;
    if (this.failWith) {
      return Promise.reject(this.failWith);
    }
    return Promise.resolve(this.models);
  }

  sendRequest(): Promise<ModelTurn> {
    // The catalog never sends a request; only resolution is under test here.
    return Promise.reject(new Error('not used in these tests'));
  }

  onDidChangeModels(listener: () => void): GatewayDisposable {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((candidate) => candidate !== listener);
      },
    };
  }

  /** Simulates a provider finishing its start-up and registering models. */
  providerBecomesReady(models: ModelInfo[]): void {
    this.models = models;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

const NOW = new Date('2026-08-17T06:00:00.000Z');

function makeCatalog(gateway: FakeGateway): { catalog: ModelCatalog; store: RoundsStore } {
  const clock = new FixedClock(NOW);
  const store = new RoundsStore({
    backend: new MementoBackend(new FakeMemento()),
    clock,
    timeZone: 'UTC',
  });
  return { catalog: new ModelCatalog({ gateway, store, clock }), store };
}

describe('model catalog', () => {
  it('starts without consent and with an empty cache', async () => {
    const { catalog } = makeCatalog(new FakeGateway());
    assert.equal(await catalog.hasConsent(), false);
    assert.deepEqual(await catalog.cached(), []);
  });

  it('caches ids and labels after a user-initiated resolve', async () => {
    const gateway = new FakeGateway();
    const { catalog, store } = makeCatalog(gateway);

    const models = await catalog.list(userAction('check setup'));

    assert.deepEqual(models.map((model) => model.id), ['model-a', 'model-b']);
    assert.equal(await catalog.hasConsent(), true);
    assert.equal((await store.read()).setup.modelsFetchedAt, NOW.toISOString());
    assert.deepEqual((await catalog.cached()).map((model) => model.id), ['model-a', 'model-b']);
  });

  it('does not record consent when the provider returned nothing', async () => {
    const gateway = new FakeGateway();
    gateway.models = [];
    const { catalog } = makeCatalog(gateway);

    await catalog.list(userAction('check setup'));
    assert.equal(await catalog.hasConsent(), false);
  });

  it('answers from the cache without contacting the provider again', async () => {
    const gateway = new FakeGateway();
    const { catalog } = makeCatalog(gateway);
    await catalog.list(userAction('check setup'));

    assert.equal(await catalog.isKnown('model-a'), true);
    assert.equal(await catalog.isKnown('model-gone'), false);
    assert.equal(gateway.calls, 1);
  });

  it('resolves an existing model by its exact id', async () => {
    const gateway = new FakeGateway();
    const { catalog } = makeCatalog(gateway);

    const model = await catalog.resolve('model-b', userAction('run now'));
    assert.equal(model.id, 'model-b');
  });

  it('refreshes once before deciding a model is gone', async () => {
    const gateway = new FakeGateway();
    const { catalog } = makeCatalog(gateway);
    await catalog.list(userAction('check setup'));

    // The provider gained a model after the list was cached.
    gateway.models = [...gateway.models, { id: 'model-c', name: 'Model C', vendor: 'v', family: 'f' }];
    const model = await catalog.resolve('model-c', userAction('run now'));

    assert.equal(model.id, 'model-c');
    assert.equal(gateway.calls, 2);
  });

  it('fails with the valid ids instead of substituting another model', async () => {
    const gateway = new FakeGateway();
    const { catalog } = makeCatalog(gateway);

    await assert.rejects(
      catalog.resolve('model-that-left', userAction('run now')),
      (error: unknown) => {
        assert.ok(error instanceof ModelNotFoundError);
        assert.equal(error.code, 'model.unavailable');
        assert.deepEqual(error.validIds, ['model-a', 'model-b']);
        assert.match(error.message, /model-a, model-b/);
        return true;
      },
    );
  });

  it('explains what to do when no models could be resolved at all', async () => {
    const gateway = new FakeGateway();
    gateway.models = [];
    const { catalog } = makeCatalog(gateway);

    await assert.rejects(catalog.resolve('anything', userAction('run now')), (error: unknown) => {
      assert.ok(error instanceof ModelNotFoundError);
      assert.match(error.message, /Check Setup/);
      return true;
    });
  });

  it('waits for a provider that is still starting up', async () => {
    const gateway = new FakeGateway();
    gateway.models = [];
    const { catalog } = makeCatalog(gateway);

    const pending = catalog.list(userAction('check setup'), { waitForProviderMs: 5000 });
    // The provider registers its models a moment after being asked, which is what a freshly opened
    // editor does.
    setTimeout(
      () => gateway.providerBecomesReady([{ id: 'model-a', name: 'Model A', vendor: 'v', family: 'f' }]),
      10,
    );

    const models = await pending;
    assert.deepEqual(models.map((model) => model.id), ['model-a']);
    assert.equal(await catalog.hasConsent(), true, 'consent is recorded once a model answered');
  });

  it('gives up waiting rather than hanging', async () => {
    const gateway = new FakeGateway();
    gateway.models = [];
    const { catalog } = makeCatalog(gateway);

    const models = await catalog.list(userAction('check setup'), { waitForProviderMs: 20 });
    assert.deepEqual(models, []);
  });

  it('does not wait when it does not have to', async () => {
    const gateway = new FakeGateway();
    const { catalog } = makeCatalog(gateway);

    const models = await catalog.list(userAction('check setup'), { waitForProviderMs: 10_000 });
    assert.equal(models.length, 2, 'a provider that answers at once is not waited for');
  });

  it('refreshes the cache when the provider list changes, once consent is on record', async () => {
    const gateway = new FakeGateway();
    const { catalog } = makeCatalog(gateway);

    // Without consent there is nothing to refresh and nothing may be asked.
    assert.equal(await catalog.refreshAfterProviderChange(), undefined);
    assert.equal(gateway.calls, 0);

    await catalog.list(userAction('check setup'));
    gateway.models = [...gateway.models, { id: 'model-c', name: 'Model C', vendor: 'v', family: 'f' }];

    const refreshed = await catalog.refreshAfterProviderChange();
    assert.equal(refreshed?.length, 3);
    assert.deepEqual((await catalog.cached()).map((model) => model.id), ['model-a', 'model-b', 'model-c']);
  });

  it('propagates provider failures rather than pretending there are no models', async () => {
    const gateway = new FakeGateway();
    gateway.failWith = new Error('consent was declined');
    const { catalog } = makeCatalog(gateway);

    await assert.rejects(catalog.list(userAction('check setup')), /consent was declined/);
    assert.equal(await catalog.hasConsent(), false);
  });
});
