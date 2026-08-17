import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { MementoBackend } from './store.js';
import type { MementoLike, StateBackend, StoreLogger } from './store.js';
import type { PersistedState } from './types.js';

export const STATE_FILE_NAME = 'state.json';

export interface FileStateBackendOptions {
  /** Directory that holds the state file, normally the extension's global storage path. */
  directory: string;
  /** Global state, kept in sync as a fallback for a lost or corrupt file. */
  memento?: MementoLike;
  logger?: StoreLogger;
  /** Injectable for tests; defaults to the wall clock. */
  now?: () => Date;
}

const silentLogger: StoreLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Stores the state envelope in a file, replaced atomically.
 *
 * Global state alone gives no ordering between windows: two of them can read the same
 * value and write in any order. A file can be replaced atomically with `rename`, which
 * makes a write either fully visible or not visible at all. Global state is still kept in
 * sync, because it survives cases where the storage directory is wiped and it is what the
 * editor shows in its own state inspector.
 */
export class FileStateBackend implements StateBackend {
  private readonly directory: string;
  private readonly filePath: string;
  private readonly mirror: MementoBackend | undefined;
  private readonly logger: StoreLogger;
  private readonly now: () => Date;
  private temporaryFileCounter = 0;

  constructor(options: FileStateBackendOptions) {
    this.directory = options.directory;
    this.filePath = join(options.directory, STATE_FILE_NAME);
    this.mirror = options.memento ? new MementoBackend(options.memento) : undefined;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
  }

  get path(): string {
    return this.filePath;
  }

  async load(): Promise<unknown> {
    const parsed = await this.readFileState();
    if (parsed !== undefined) {
      return parsed;
    }
    if (this.mirror) {
      const fallback = await this.mirror.load();
      if (fallback !== undefined) {
        this.logger.warn('State file was unavailable; recovered the state from global state.');
      }
      return fallback;
    }
    return undefined;
  }

  async save(state: PersistedState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    this.temporaryFileCounter += 1;
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${this.temporaryFileCounter}`;
    // The temporary file lives in the same directory on purpose: rename is only atomic
    // within a single file system.
    await writeFile(temporaryPath, `${JSON.stringify(state, undefined, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
    await this.mirror?.save(state);
  }

  async peekRevision(): Promise<number> {
    const parsed = await this.readFileState();
    if (parsed && typeof parsed === 'object' && 'revision' in parsed) {
      const { revision } = parsed;
      if (typeof revision === 'number') {
        return revision;
      }
    }
    return this.mirror ? this.mirror.peekRevision() : 0;
  }

  /** Modification time of the state file, or `undefined` when it does not exist. */
  async modifiedAt(): Promise<number | undefined> {
    try {
      const info = await stat(this.filePath);
      return info.mtimeMs;
    } catch {
      return undefined;
    }
  }

  private async readFileState(): Promise<unknown> {
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch {
      return undefined;
    }
    try {
      return JSON.parse(content);
    } catch (error) {
      await this.quarantineFile(error);
      return undefined;
    }
  }

  private async quarantineFile(error: unknown): Promise<void> {
    const stamp = this.now().toISOString().replace(/[:.]/g, '-');
    const target = `${this.filePath}.bad-${stamp}`;
    try {
      await rename(this.filePath, target);
      this.logger.error(
        `State file could not be parsed (${String(error)}); moved it to ${target} and continued with the last known good state.`,
      );
    } catch (renameError) {
      this.logger.error(
        `State file could not be parsed (${String(error)}) and could not be moved aside (${String(renameError)}).`,
      );
    }
  }
}

export interface StateFileWatcherOptions {
  backend: FileStateBackend;
  /** Called when the file changed on disk since the last check. */
  onChanged: () => void;
  intervalMs?: number;
  logger?: StoreLogger;
}

/**
 * Notices writes made by other windows.
 *
 * Follower windows do not tick the scheduler, but their views must still reflect what the
 * leader stored. Polling the modification time every few seconds is cheap and needs no
 * platform specific file watching.
 */
export class StateFileWatcher {
  private timer: NodeJS.Timeout | undefined;
  private lastModified: number | undefined;
  private readonly logger: StoreLogger;

  constructor(private readonly options: StateFileWatcherOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  async start(): Promise<void> {
    this.lastModified = await this.options.backend.modifiedAt();
    const interval = this.options.intervalMs ?? 5000;
    this.timer = setInterval(() => {
      void this.check();
    }, interval);
    // Do not hold the process open just for this poll.
    this.timer.unref?.();
  }

  /** Runs one poll immediately. Exposed for tests. */
  async check(): Promise<void> {
    try {
      const modified = await this.options.backend.modifiedAt();
      if (modified !== undefined && modified !== this.lastModified) {
        this.lastModified = modified;
        this.options.onChanged();
      }
    } catch (error) {
      this.logger.debug(`Could not check the state file for changes: ${String(error)}`);
    }
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
