import { Emitter } from './emitter.js';
import type { Disposable } from './emitter.js';
import { localDate, systemClock } from './time.js';
import type { Clock } from './time.js';
import type { PersistedState } from './types.js';
import { CURRENT_SCHEMA_VERSION, emptyState, normalizeState } from './validate.js';
import type { QuarantineEntry } from './validate.js';

/** Global state keys, exactly as specified in plan.md. */
export const STATE_KEYS = {
  agents: 'rounds.agents',
  history: 'rounds.history',
  revision: 'rounds.stateRevision',
  counters: 'rounds.dailyCounters',
} as const;

/** The slice of the editor's `Memento` this layer needs. Keeps the store testable. */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

/** Where a state envelope is loaded from and saved to. */
export interface StateBackend {
  /** The stored envelope, or `undefined` when nothing has been written yet. */
  load(): Promise<unknown>;
  save(state: PersistedState): Promise<void>;
  /** Cheap read of the currently stored revision, used to detect a lost race. */
  peekRevision(): Promise<number>;
}

/** The little the store needs from a logger, so it does not depend on the real one. */
export interface StoreLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const silentLogger: StoreLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Thrown when a write could not be applied because other windows kept winning the race. */
export class StateConflictError extends Error {
  readonly code = 'state.conflict';

  constructor(readonly attempts: number) {
    super(`State was modified by another window ${attempts} times in a row; write aborted.`);
    this.name = 'StateConflictError';
  }
}

export interface StateChange {
  state: PersistedState;
  /** True when the change came from another window rather than from this one. */
  external: boolean;
}

/** Backend that keeps the envelope in the editor's global state only. */
export class MementoBackend implements StateBackend {
  constructor(private readonly memento: MementoLike) {}

  load(): Promise<unknown> {
    const revision = this.memento.get<number>(STATE_KEYS.revision);
    if (revision === undefined) {
      return Promise.resolve(undefined);
    }
    return Promise.resolve({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision,
      agents: this.memento.get(STATE_KEYS.agents) ?? [],
      history: this.memento.get(STATE_KEYS.history) ?? {},
      counters: this.memento.get(STATE_KEYS.counters),
    });
  }

  /**
   * Note what is missing here: run claims.
   *
   * plan.md fixes the four global state keys, and a claim is deliberately not one of
   * them. Claims travel between windows through the state file, which is the channel that
   * actually orders concurrent writes. A window that has to fall back to global state
   * simply sees no claims, which is safe: the worst case is one duplicate run in a setup
   * whose storage directory is already broken.
   */
  async save(state: PersistedState): Promise<void> {
    await this.memento.update(STATE_KEYS.agents, state.agents);
    await this.memento.update(STATE_KEYS.history, state.history);
    await this.memento.update(STATE_KEYS.counters, state.counters);
    // The revision is written last so a crash mid-save cannot advertise data that is not
    // there yet: a reader either sees the old revision or a fully written state.
    await this.memento.update(STATE_KEYS.revision, state.revision);
  }

  peekRevision(): Promise<number> {
    return Promise.resolve(this.memento.get<number>(STATE_KEYS.revision) ?? 0);
  }
}

export interface StoreOptions {
  backend: StateBackend;
  clock?: Clock;
  logger?: StoreLogger;
  timeZone?: string;
  maxAttempts?: number;
}

/**
 * Reads and writes the persisted state.
 *
 * Every write is a read-modify-write guarded by the revision number: if another window
 * stored something between the read and the write, this window reloads and applies its
 * mutation again instead of overwriting the newer state. Mutators must therefore be pure
 * and safe to run more than once.
 */
export class RoundsStore {
  private readonly backend: StateBackend;
  private readonly clock: Clock;
  private readonly logger: StoreLogger;
  private readonly maxAttempts: number;
  private readonly changeEmitter = new Emitter<StateChange>();
  private cached: PersistedState | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: StoreOptions) {
    this.backend = options.backend;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.timeZone = options.timeZone;
  }

  private timeZone: string | undefined;

  /** Fires whenever the state changes, including changes made by another window. */
  onDidChange(listener: (change: StateChange) => void): Disposable {
    return this.changeEmitter.event(listener);
  }

  /** The state as last read. Reads from the backend when nothing is cached yet. */
  async read(): Promise<PersistedState> {
    if (this.cached) {
      return this.cached;
    }
    return this.reload();
  }

  /** Forces a read from the backend, replacing the cache. */
  async reload(): Promise<PersistedState> {
    const raw = await this.backend.load();
    const today = localDate(this.clock.now(), this.timeZone);
    const { state, quarantine } = normalizeState(raw, today);
    this.reportQuarantine(quarantine);
    this.cached = state;
    return state;
  }

  /**
   * Applies `mutator` to a copy of the current state and stores the result.
   *
   * Retries on a lost race, up to the configured attempt limit. Writes are serialized
   * inside this window so two callers cannot interleave their read-modify-write cycles.
   */
  async update(mutator: (draft: PersistedState) => void): Promise<PersistedState> {
    const run = this.queue.then(() => this.updateNow(mutator));
    // Keep the queue alive even when this update fails; a rejection must not poison it.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async updateNow(mutator: (draft: PersistedState) => void): Promise<PersistedState> {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const base = await this.reload();
      const draft = structuredClone(base);
      mutator(draft);
      draft.schemaVersion = CURRENT_SCHEMA_VERSION;
      draft.revision = base.revision + 1;

      const observed = await this.backend.peekRevision();
      if (observed !== base.revision) {
        this.logger.debug(
          `State revision moved from ${base.revision} to ${observed} while writing; retrying (attempt ${attempt}).`,
        );
        continue;
      }

      await this.backend.save(draft);
      this.cached = draft;
      this.changeEmitter.fire({ state: draft, external: false }, (error) => {
        this.logger.error(`A state change listener failed: ${String(error)}`);
      });
      return draft;
    }
    throw new StateConflictError(this.maxAttempts);
  }

  /**
   * Reloads after an external write and notifies listeners.
   * Used by the file watcher in step 2.4 and by follower windows.
   */
  async refreshFromExternalChange(): Promise<PersistedState> {
    const previous = this.cached?.revision ?? -1;
    const state = await this.reload();
    if (state.revision !== previous) {
      this.changeEmitter.fire({ state, external: true }, (error) => {
        this.logger.error(`A state change listener failed: ${String(error)}`);
      });
    }
    return state;
  }

  /** Replaces everything with an empty state. Used by tests and by a hard reset. */
  async reset(): Promise<PersistedState> {
    return this.update((draft) => {
      const fresh = emptyState(localDate(this.clock.now(), this.timeZone));
      draft.agents = fresh.agents;
      draft.history = fresh.history;
      draft.counters = fresh.counters;
    });
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  private reportQuarantine(quarantine: QuarantineEntry[]): void {
    for (const entry of quarantine) {
      this.logger.warn(`Ignored a malformed ${entry.kind} entry in stored state: ${entry.reason}`);
    }
  }
}
