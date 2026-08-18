import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import lockfile from 'proper-lockfile';

import { Emitter } from '../state/emitter.js';
import type { Disposable } from '../state/emitter.js';
import type { StoreLogger } from '../state/store.js';

/** Name of the lock file, exactly as specified in plan.md. */
export const LOCK_FILE_NAME = 'rounds.lock';

/** A lock is considered abandoned after this long without a heartbeat. */
export const STALE_MS = 30_000;

/** How often the holder refreshes the lock. */
export const HEARTBEAT_MS = 10_000;

const silentLogger: StoreLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface LeaderLockOptions {
  /** Directory that holds the lock file, normally the extension's global storage path. */
  directory: string;
  logger?: StoreLogger;
  staleMs?: number;
  heartbeatMs?: number;
}

/**
 * The lock that decides which window schedules runs.
 *
 * Every window runs its own copy of the extension against the same global state, so
 * without this every open window would fire the same agent at the same time. The lock is
 * held by one window at a time, refreshed while that window lives, and taken over
 * automatically when the holder disappears without releasing it — a crash must not stop
 * scheduling forever.
 */
export class LeaderLock {
  private readonly directory: string;
  private readonly filePath: string;
  private readonly logger: StoreLogger;
  private readonly staleMs: number;
  private readonly heartbeatMs: number;
  private release: (() => Promise<void>) | undefined;
  private readonly lostEmitter = new Emitter<void>();
  /** Last refusal reported, so the same line is not repeated every retry. */
  private lastRefusal: string | undefined;

  constructor(options: LeaderLockOptions) {
    this.directory = options.directory;
    this.filePath = join(options.directory, LOCK_FILE_NAME);
    this.logger = options.logger ?? silentLogger;
    this.staleMs = options.staleMs ?? STALE_MS;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  }

  get isHeld(): boolean {
    return this.release !== undefined;
  }

  get path(): string {
    return this.filePath;
  }

  /** Fires when the lock was lost without this window releasing it. */
  onLost(listener: () => void): Disposable {
    return this.lostEmitter.event(listener);
  }

  /**
   * Tries to become the leader. Returns false when another window already is.
   *
   * There is no retry here on purpose: the caller decides how often to try again, and a
   * blocking retry would delay activation.
   */
  async acquire(): Promise<boolean> {
    if (this.release) {
      return true;
    }
    try {
      await mkdir(this.directory, { recursive: true });
      // proper-lockfile locks an existing path, so the target file has to be there.
      await writeFile(this.filePath, 'This file marks the window that schedules runs.\n', {
        flag: 'a',
      });
      this.release = await lockfile.lock(this.filePath, {
        stale: this.staleMs,
        update: this.heartbeatMs,
        retries: 0,
        onCompromised: (error) => {
          this.logger.warn(`Lost the scheduling lock: ${error.message}`);
          // Release before forgetting the handle. Dropping it while the lock file is still held
          // leaves this process holding a lock it no longer knows about, and every later attempt
          // then fails with "already being held" — by itself, forever.
          const release = this.release;
          this.release = undefined;
          void release?.().catch(() => undefined);
          this.lostEmitter.fire(undefined);
        },
      });
      this.logger.info('This window now schedules runs.');
      this.lastRefusal = undefined;
      return true;
    } catch (error) {
      await this.reportRefusal(error);
      return false;
    }
  }

  /**
   * Explains a refusal once, with who is holding the lock.
   *
   * Repeating the same line every fifteen seconds turns the log into noise and hides everything else,
   * which is exactly what a user reported. The message also says whether the holder is alive or
   * whether the lock is waiting to go stale, because "another window" is confusing advice when only
   * one window is open.
   */
  private async reportRefusal(error: unknown): Promise<void> {
    let detail = 'another window holds it';
    try {
      const held = await lockfile.check(this.filePath, { stale: this.staleMs });
      detail = held
        ? 'another window holds it and is keeping it alive'
        : `the lock file exists but nobody is refreshing it; it is treated as abandoned after ${Math.round(this.staleMs / 1000)}s`;
    } catch {
      // Checking is best effort; the refusal itself is what matters.
    }

    const message = `This window does not schedule runs: ${detail}.`;
    if (message !== this.lastRefusal) {
      this.lastRefusal = message;
      this.logger.info(`${message} (${String(error)})`);
    } else {
      this.logger.debug(message);
    }
  }

  /** Gives the lock up so another window can take over immediately. */
  async giveUp(): Promise<void> {
    const release = this.release;
    this.release = undefined;
    if (!release) {
      return;
    }
    try {
      await release();
      this.logger.info('This window stopped scheduling runs.');
    } catch (error) {
      this.logger.debug(`Could not release the scheduling lock cleanly: ${String(error)}`);
    }
  }

  dispose(): void {
    void this.giveUp();
    this.lostEmitter.dispose();
  }
}
