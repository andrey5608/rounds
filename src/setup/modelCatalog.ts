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
/**
 * Thrown when the editor does not answer a model request.
 *
 * Observed in a real installation: `selectChatModels` never resolved, so the progress notification sat
 * on screen forever and the log stopped mid-sentence. An unbounded await on somebody else's API is a
 * hang waiting to happen; the deadline turns it into a message.
 */
export class ModelRequestTimeoutError extends Error {
  readonly code = 'model.noAnswer';

  constructor(readonly waitedMs: number) {
    super(
      `The editor did not answer a request for language models within ${Math.round(waitedMs / 1000)}s. A permission dialog may be waiting for you, or the provider may not be responding. Check the extended log for what was tried.`,
    );
    this.name = 'ModelRequestTimeoutError';
  }
}

/** Raised when the user cancels a model request. */
export class ModelRequestCancelledError extends Error {
  readonly code = 'model.cancelled';

  constructor() {
    super('The request for language models was cancelled.');
    this.name = 'ModelRequestCancelledError';
  }
}

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

/** Longest a single model request may take before it is reported rather than awaited. */
export const DEFAULT_CALL_TIMEOUT_MS = 45_000;

export interface ListOptions {
  /** Wait for a provider that is still registering its models. */
  waitForProviderMs?: number;
  /** Deadline for one request to the editor. */
  callTimeoutMs?: number;
  /** Checked while waiting, so the user can give up. */
  isCancelled?: () => boolean;
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

  /**
   * Waits for a provider that is still starting up.
   *
   * A freshly opened editor reports no models for a while: the provider extension activates, then
   * registers its models, then fires the change event. Asking once and concluding "no models
   * available" tells a user with a perfectly good provider installed to go and install one.
   */
  /**
   * One request to the editor, bounded and interruptible.
   *
   * The promise cannot be cancelled — nothing in the API offers that — so what happens on a timeout is
   * that this stops waiting. A late answer is simply picked up by the next request.
   */
  private async request(options?: ListOptions): Promise<ModelInfo[]> {
    const timeoutMs = options?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    const started = Date.now();

    const result = await Promise.race([
      this.options.gateway.selectModels().then((models) => ({ kind: 'models' as const, models })),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        const timer = setInterval(() => {
          if (options?.isCancelled?.() || Date.now() - started >= timeoutMs) {
            clearInterval(timer);
            resolve({ kind: 'timeout' });
          }
        }, 250);
        timer.unref?.();
      }),
    ]);

    const elapsed = Date.now() - started;
    if (result.kind === 'timeout') {
      if (options?.isCancelled?.()) {
        this.options.logger?.warn(`The model request was cancelled after ${elapsed}ms.`);
        throw new ModelRequestCancelledError();
      }
      this.options.logger?.error(`The editor did not answer the model request within ${elapsed}ms.`);
      throw new ModelRequestTimeoutError(elapsed);
    }
    this.options.logger?.debug(`The model request answered in ${elapsed}ms.`);
    return result.models;
  }

  private async waitForModels(timeoutMs: number, isCancelled?: () => boolean): Promise<ModelInfo[]> {
    const subscribe = this.options.gateway.onDidChangeModels?.bind(this.options.gateway);
    if (!subscribe) {
      return [];
    }
    return new Promise<ModelInfo[]>((resolve) => {
      let settled = false;
      const finish = (models: ModelInfo[]): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearInterval(cancelPoll);
        subscription.dispose();
        resolve(models);
      };

      const timer = setTimeout(() => finish([]), timeoutMs);
      timer.unref?.();
      // A user who gave up should not keep the editor busy on our behalf.
      const cancelPoll = setInterval(() => {
        if (isCancelled?.()) {
          clearInterval(cancelPoll);
          finish([]);
        }
      }, 250);
      cancelPoll.unref?.();
      const subscription = subscribe(() => {
        void this.options.gateway
          .selectModels()
          .then((models) => {
            if (models.length > 0) {
              finish(models);
            }
          })
          .catch(() => undefined);
      });
    });
  }

  /**
   * Resolves the model list, triggering the consent prompt on the first call.
   *
   * `waitForProviderMs` covers the startup gap described above; it is only worth passing from a
   * user-initiated action, where waiting a few seconds is better than a wrong answer.
   */
  async list(action: UserAction, options?: ListOptions): Promise<ModelInfo[]> {
    this.options.logger?.debug(`Resolving language models (${action.reason}).`);
    let models = await this.request(options);
    if (models.length === 0 && options?.waitForProviderMs) {
      this.options.logger?.info(
        `No language models were reported; waiting up to ${Math.round(options.waitForProviderMs / 1000)}s in case a provider is still starting.`,
      );
      models = await this.waitForModels(options.waitForProviderMs, options.isCancelled);
    }
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

  /** Refreshes the cache without a user action. Only safe once consent is on record. */
  async refreshAfterProviderChange(): Promise<ModelInfo[] | undefined> {
    if (!(await this.hasConsent())) {
      return undefined;
    }
    const models = await this.options.gateway.selectModels();
    this.memory = models;
    const at = this.clock.now().toISOString();
    await this.options.store.update((draft) => {
      draft.setup.models = models.map((model) => ({
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        family: model.family,
      }));
      draft.setup.modelsFetchedAt = at;
    });
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

  /**
   * Resolves a model for a scheduled or automated run.
   *
   * There is no user action here, so consent must already have been granted: the very first
   * `selectChatModels` call is the one that prompts, and a prompt appearing because a schedule
   * fired at three in the morning is exactly what the consent rule exists to prevent. Once
   * consent is on record, refreshing the list costs nothing and cannot prompt.
   */
  async resolveForRun(modelId: string): Promise<ModelInfo> {
    if (!(await this.hasConsent())) {
      throw new ModelNotFoundError(modelId, []);
    }
    const models = await this.options.gateway.selectModels();
    this.memory = models;
    const found = models.find((model) => model.id === modelId);
    if (!found) {
      throw new ModelNotFoundError(
        modelId,
        models.map((model) => model.id),
      );
    }
    return found;
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
