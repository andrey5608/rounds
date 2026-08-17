import { randomUUID } from 'node:crypto';

import { Emitter } from '../state/emitter.js';
import type { Disposable } from '../state/emitter.js';
import type { StoreLogger } from '../state/store.js';

/**
 * The little the manager needs from a lock.
 *
 * Declared as an interface so tests can drive lock loss, which the real implementation
 * only reports when the file system layer notices a compromised lock.
 */
export interface LeaderLockLike {
  readonly isHeld: boolean;
  acquire(): Promise<boolean>;
  giveUp(): Promise<void>;
  onLost(listener: () => void): Disposable;
}

const silentLogger: StoreLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface LeadershipOptions {
  lock: LeaderLockLike;
  logger?: StoreLogger;
  /** How long to wait before trying again after losing the race. */
  retryMs?: number;
  /** Upper bound of the random offset added to the retry delay. */
  retryJitterMs?: number;
  random?: () => number;
}

/**
 * Keeps track of whether this window is the one that schedules runs.
 *
 * Acquisition is attempted in the background: activation never waits for it. A window
 * that loses the race keeps trying, so it takes over within seconds when the leader is
 * closed or crashes. The retry delay carries a random offset so several windows started
 * together do not keep colliding.
 */
export class Leadership {
  /** Identifies this activation. Only lives in memory, never persisted. */
  readonly windowId = randomUUID();

  private readonly lock: LeaderLockLike;
  private readonly logger: StoreLogger;
  private readonly retryMs: number;
  private readonly retryJitterMs: number;
  private readonly random: () => number;
  private readonly changeEmitter = new Emitter<boolean>();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private lostSubscription: Disposable | undefined;

  constructor(options: LeadershipOptions) {
    this.lock = options.lock;
    this.logger = options.logger ?? silentLogger;
    this.retryMs = options.retryMs ?? 15_000;
    this.retryJitterMs = options.retryJitterMs ?? 5_000;
    this.random = options.random ?? Math.random;
  }

  get isLeader(): boolean {
    return this.lock.isHeld;
  }

  /** Fires with the new leadership state whenever it changes. */
  onDidChange(listener: (isLeader: boolean) => void): Disposable {
    return this.changeEmitter.event(listener);
  }

  /** Starts trying to become the leader. Returns immediately. */
  start(): void {
    this.stopped = false;
    this.lostSubscription = this.lock.onLost(() => {
      this.logger.warn('Scheduling moved away from this window; trying to get it back.');
      this.changeEmitter.fire(false);
      this.scheduleRetry();
    });
    void this.tryAcquire();
  }

  /** One acquisition attempt. Exposed for tests. */
  async tryAcquire(): Promise<boolean> {
    if (this.stopped) {
      return false;
    }
    const acquired = await this.lock.acquire();
    if (this.stopped) {
      // The window was shut down while this attempt was in flight. Holding the lock now
      // would keep every other window from scheduling until it goes stale.
      if (acquired) {
        await this.lock.giveUp();
      }
      return false;
    }
    if (acquired) {
      this.changeEmitter.fire(true);
    } else {
      this.scheduleRetry();
    }
    return acquired;
  }

  /** Releases the lock so another window can take over without waiting for staleness. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    this.lostSubscription?.dispose();
    this.lostSubscription = undefined;
    const wasLeader = this.lock.isHeld;
    await this.lock.giveUp();
    if (wasLeader) {
      this.changeEmitter.fire(false);
    }
  }

  dispose(): void {
    void this.stop();
    this.changeEmitter.dispose();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.timer) {
      return;
    }
    const delay = this.retryMs + Math.floor(this.random() * this.retryJitterMs);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tryAcquire();
    }, delay);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
