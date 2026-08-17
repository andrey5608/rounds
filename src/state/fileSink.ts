import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import type { LogSink } from './logger.js';

/** One file per local day, so a report can be tied to "it happened yesterday". */
export const LOG_FILE_PREFIX = 'rounds-';
export const LOG_FILE_SUFFIX = '.log';

/** A single day's file stops growing at this size; the rest of that day is dropped. */
export const MAX_FILE_BYTES = 2_000_000;

/** How many daily files are kept. */
export const MAX_FILES = 5;

export interface FileSinkOptions {
  directory: string;
  now?: () => Date;
  maxFileBytes?: number;
  maxFiles?: number;
  /** Called when the sink itself fails, so a broken log cannot break a run. */
  onError?: (error: unknown) => void;
}

function dayStamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * Writes every log line to a file, whatever the configured level is.
 *
 * The output channel is for watching; this is for reporting. When somebody says "I pressed the button
 * and nothing happened", the useful artefact is a file they can attach, containing the lines that the
 * channel's level would have thrown away. Written synchronously and appended: a crash mid-run must
 * not be the reason the evidence is missing.
 */
export class FileLogSink implements LogSink {
  private readonly options: Required<Omit<FileSinkOptions, 'onError'>> & Pick<FileSinkOptions, 'onError'>;
  private currentDay: string | undefined;
  private currentPath: string | undefined;
  private writtenToday = 0;
  private capacityReported = false;

  constructor(options: FileSinkOptions) {
    this.options = {
      directory: options.directory,
      now: options.now ?? (() => new Date()),
      maxFileBytes: options.maxFileBytes ?? MAX_FILE_BYTES,
      maxFiles: options.maxFiles ?? MAX_FILES,
      onError: options.onError,
    };
  }

  /** Path of the file being written right now, for the output channel to point at. */
  get path(): string {
    return this.resolvePath(this.options.now());
  }

  append(line: string): void {
    try {
      const rolled = this.currentDay !== dayStamp(this.options.now());
      const path = this.rollIfNeeded();
      if (this.writtenToday >= this.options.maxFileBytes) {
        if (!this.capacityReported) {
          this.capacityReported = true;
          appendFileSync(
            path,
            `[log] this file reached ${this.options.maxFileBytes} bytes; further lines today are not recorded\n`,
            'utf8',
          );
        }
        return;
      }
      const payload = `${line}\n`;
      appendFileSync(path, payload, 'utf8');
      this.writtenToday += Buffer.byteLength(payload, 'utf8');
      if (rolled) {
        // Pruned after the write, not before: today's file has to exist to be counted, otherwise the
        // oldest file survives one day too long every time.
        this.prune();
      }
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  private resolvePath(date: Date): string {
    return join(this.options.directory, `${LOG_FILE_PREFIX}${dayStamp(date)}${LOG_FILE_SUFFIX}`);
  }

  private rollIfNeeded(): string {
    const now = this.options.now();
    const day = dayStamp(now);
    if (day === this.currentDay && this.currentPath) {
      return this.currentPath;
    }

    mkdirSync(this.options.directory, { recursive: true });
    this.currentDay = day;
    this.currentPath = this.resolvePath(now);
    this.capacityReported = false;
    // Continuing an existing file after a restart means counting what is already in it.
    this.writtenToday = this.sizeOf(this.currentPath);
    return this.currentPath;
  }

  private sizeOf(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  /** Keeps the newest files and deletes the rest, so the folder cannot grow without bound. */
  private prune(): void {
    try {
      const files = readdirSync(this.options.directory)
        .filter((name) => name.startsWith(LOG_FILE_PREFIX) && name.endsWith(LOG_FILE_SUFFIX))
        .sort();
      for (const name of files.slice(0, Math.max(0, files.length - this.options.maxFiles))) {
        unlinkSync(join(this.options.directory, name));
      }
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
