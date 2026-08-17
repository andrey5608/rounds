import * as assert from 'node:assert/strict';

import type { LanguageModelGateway, ModelInfo } from '../../model/gateway.js';
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

  it('propagates provider failures rather than pretending there are no models', async () => {
    const gateway = new FakeGateway();
    gateway.failWith = new Error('consent was declined');
    const { catalog } = makeCatalog(gateway);

    await assert.rejects(catalog.list(userAction('check setup')), /consent was declined/);
    assert.equal(await catalog.hasConsent(), false);
  });
});
