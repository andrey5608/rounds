import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import lockfile from 'proper-lockfile';

import { Emitter } from '../state/emitter.js';
import type { Disposable } from '../state/emitter.js';
import type { StoreLogger } from '../state/store.js';

/**
 * Name of the lock, exactly as specified in plan.md.
 *
 * `proper-lockfile` claims a resource by creating a directory beside it, so this is what appears
 * on disk — a directory rather than a file, which is the library's atomic operation. It used to
 * be a marker file we wrote ourselves *plus* a `rounds.lock.lock` directory beside it; two
 * artifacts where the specification names one, and the extra one looked like debris.
 */
export const LOCK_FILE_NAME = 'rounds.lock';

/** The resource the lock is about. Nothing is ever written here; only its lock exists. */
const LOCK_TARGET_NAME = 'rounds';

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
  /** The path `proper-lockfile` is asked to lock. Never created; `realpath: false` allows that. */
  private readonly targetPath: string;
  private readonly filePath: string;
  private readonly logger: StoreLogger;
  private readonly staleMs: number;
  private readonly heartbeatMs: number;
  private release: (() => Promise<void>) | undefined;
  private readonly lostEmitter = new Emitter<void>();
  /** Last refusal reported, so the same line is not repeated every retry. */
  private lastRefusal: string | undefined;
  /** The folder is tidied once per window, not on every retry. */
  private cleanedUp = false;

  /**
   * What both `lock` and `check` need.
   *
   * `realpath: false` is what allows locking a path that does not exist, and `lockfilePath` names
   * the directory the library creates — so the one artifact on disk is the `rounds.lock` the
   * specification names, rather than a marker file with a second lock beside it.
   */
  private get lockOptions(): { stale: number; realpath: false; lockfilePath: string } {
    return { stale: this.staleMs, realpath: false, lockfilePath: this.filePath };
  }

  constructor(options: LeaderLockOptions) {
    this.directory = options.directory;
    this.targetPath = join(options.directory, LOCK_TARGET_NAME);
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
      await this.removeLegacyArtifacts();
      this.release = await lockfile.lock(this.targetPath, {
        ...this.lockOptions,
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
      const held = await lockfile.check(this.targetPath, this.lockOptions);
      detail = held
        ? 'another window holds it and is keeping it alive'
        : `the lock file exists but nobody is refreshing it; it is treated as abandoned after ${Math.round(this.staleMs / 1000)}s`;
    } catch {
      // Checking is best effort; the refusal itself is what matters.
    }

    const message = `This window does not schedule runs: ${detail}.`;
    if (message === this.lastRefusal) {
      // Nothing at all, not even at debug level: the extended log records every line whatever the
      // configured level is, so "log it more quietly" still filled that file with one repetition
      // every fifteen seconds. Which window schedules is visible in the status bar; the log's job
      // is to record changes.
      return;
    }
    this.lastRefusal = message;
    this.logger.info(`${message} (${String(error)})`);
  }

  /**
   * Removes what earlier versions left in the storage folder.
   *
   * Until this changed, the lock was taken on a marker file we wrote ourselves, so the folder held
   * `rounds.lock` (a file) and `rounds.lock.lock` (the library's directory). The file has to go or
   * the directory that now takes its name cannot be created at all; the old directory is debris.
   * Neither is removed while another window still holds the old lock, because that window is
   * relying on it.
   */
  private async removeLegacyArtifacts(): Promise<void> {
    if (this.cleanedUp) {
      return;
    }
    this.cleanedUp = true;

    const legacyLockDirectory = `${this.filePath}.lock`;
    try {
      const held = await lockfile.check(this.filePath, { stale: this.staleMs }).catch(() => false);
      if (held) {
        // An older window is still scheduling with the old lock. Leaving both alone is the only
        // safe answer: taking the new lock as well would mean two windows scheduling at once.
        this.logger.info('Another window still holds the previous lock; leaving it alone.');
        return;
      }

      const info = await stat(this.filePath).catch(() => undefined);
      if (info?.isFile()) {
        await rm(this.filePath, { force: true });
        this.logger.debug('Removed the marker file earlier versions used for the scheduling lock.');
      }
      await rm(legacyLockDirectory, { recursive: true, force: true });
    } catch (error) {
      // Cleanup is best effort; failing it must not stop this window from scheduling.
      this.logger.debug(`Could not clean up the previous lock files: ${String(error)}`);
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
