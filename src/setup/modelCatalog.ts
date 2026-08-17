import type { LanguageModelGateway, ModelInfo } from '../model/gateway.js';
import type { RoundsStore, StoreLogger } from '../state/store.js';
import { systemClock } from '../state/time.js';
import type { Clock } from '../state/time.js';
import type { CachedModel } from '../state/types.js';

import type { UserAction } from './consentGate.js';

/**
 * Thrown when an agent points at a model that no longer exists.
 *
 * It carries the ids that *do* exist, because the only useful answer to "your model is
 * gone" is "here is what you can pick instead". Substituting a different model silently
 * would change what the agent does without anybody noticing.
 */
export class ModelNotFoundError extends Error {
  readonly code = 'model.unavailable';

  constructor(
    readonly modelId: string,
    readonly validIds: string[],
  ) {
    super(
      validIds.length > 0
        ? `The model "${modelId}" is not available any more. Edit the agent and pick one of: ${validIds.join(', ')}.`
        : `The model "${modelId}" is not available and no models could be resolved. Run Check Setup to grant access to a language model provider.`,
    );
    this.name = 'ModelNotFoundError';
  }
}

export interface ModelCatalogOptions {
  gateway: LanguageModelGateway;
  store: RoundsStore;
  clock?: Clock;
  logger?: StoreLogger;
}

/**
 * Knows which models exist.
 *
 * Resolving them requires consent and must come from something the user did, so the result
 * is cached: the tree, agent validation and the status bar all read the cache, and only
 * commands and wizard steps refresh it.
 */
export class ModelCatalog {
  private readonly clock: Clock;
  private memory: ModelInfo[] | undefined;

  constructor(private readonly options: ModelCatalogOptions) {
    this.clock = options.clock ?? systemClock;
  }

  /** Resolves the model list, triggering the consent prompt on the first call. */
  async list(action: UserAction): Promise<ModelInfo[]> {
    this.options.logger?.debug(`Resolving language models (${action.reason}).`);
    const models = await this.options.gateway.selectModels();
    this.memory = models;
    const at = this.clock.now().toISOString();
    const cached: CachedModel[] = models.map((model) => ({
      id: model.id,
      name: model.name,
      vendor: model.vendor,
      family: model.family,
    }));
    await this.options.store.update((draft) => {
      draft.setup.models = cached;
      draft.setup.modelsFetchedAt = at;
      if (models.length > 0 && draft.setup.consentGrantedAt === undefined) {
        draft.setup.consentGrantedAt = at;
      }
    });
    this.options.logger?.info(`Resolved ${models.length} language model(s).`);
    return models;
  }

  /** The last known model list. Never triggers a prompt, so it may be out of date. */
  async cached(): Promise<CachedModel[]> {
    const state = await this.options.store.read();
    return state.setup.models ?? [];
  }

  /** True once the user has granted access at least once. */
  async hasConsent(): Promise<boolean> {
    const state = await this.options.store.read();
    return state.setup.consentGrantedAt !== undefined;
  }

  /**
   * Resolves one model by its exact id, refreshing the list first.
   *
   * Fails with the list of valid ids when the id is gone. There is deliberately no
   * fallback: an agent that quietly starts using another model is worse than one that
   * stops and says why.
   */
  async resolve(modelId: string, action: UserAction): Promise<ModelInfo> {
    const models = this.memory ?? (await this.list(action));
    const found = models.find((model) => model.id === modelId);
    if (found) {
      return found;
    }
    // The cached list may be stale; refresh once before giving up.
    const refreshed = await this.list(action);
    const afterRefresh = refreshed.find((model) => model.id === modelId);
    if (afterRefresh) {
      return afterRefresh;
    }
    throw new ModelNotFoundError(
      modelId,
      refreshed.map((model) => model.id),
    );
  }

  /** Checks an id against the cache without any chance of a prompt. */
  async isKnown(modelId: string): Promise<boolean> {
    const cached = await this.cached();
    return cached.some((model) => model.id === modelId);
  }

  /** Forgets the in-memory list so the next resolve goes back to the provider. */
  invalidate(): void {
    this.memory = undefined;
  }
}
