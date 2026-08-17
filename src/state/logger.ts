import { systemClock } from './time.js';
import type { Clock } from './time.js';

export const LOG_LEVELS = ['none', 'error', 'info', 'debug'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { none: 0, error: 1, info: 2, debug: 3 };

/** Where formatted lines end up. The editor output channel is one implementation. */
export interface LogSink {
  append(line: string): void;
}

export interface LoggerOptions {
  sink: LogSink;
  /** Read fresh on every line so a settings change applies immediately. */
  getLevel: () => LogLevel;
  /** Secret values seen so far, replaced verbatim before a line is written. */
  getRedactions?: () => string[];
  clock?: Clock;
  scope?: string;
}

// A quoted header value may contain spaces ("Bearer abc"), so it needs its own pattern:
// stopping at the first space would leave the token itself in the log.
const QUOTED_AUTHORIZATION_PATTERN = /(authorization["']?\s*[:=]\s*)(["'])[^"']*\2/gi;
const AUTHORIZATION_PATTERN = /(authorization["']?\s*[:=]\s*)([^"'\s,;}]+)/gi;
const URL_CREDENTIALS_PATTERN = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi;
const BEARER_PATTERN = /\b(bearer|token|basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi;

/** Replaces anything that looks like a credential with a fixed marker. */
export function redact(message: string, secrets: readonly string[] = []): string {
  let result = message;
  for (const secret of secrets) {
    if (secret.length >= 8) {
      result = result.split(secret).join('***');
    }
  }
  result = result.replace(URL_CREDENTIALS_PATTERN, '$1***:***@');
  result = result.replace(QUOTED_AUTHORIZATION_PATTERN, '$1$2***$2');
  result = result.replace(AUTHORIZATION_PATTERN, '$1***');
  result = result.replace(BEARER_PATTERN, '$1 ***');
  return result;
}

/**
 * Writes to the output channel.
 *
 * Every line goes through here so redaction happens in exactly one place: a token that
 * reaches the log is a token in a file the user may paste into an issue report.
 */
export class Logger {
  private readonly clock: Clock;

  constructor(private readonly options: LoggerOptions) {
    this.clock = options.clock ?? systemClock;
  }

  /** A logger that prefixes every line with `[scope]`, for example a run id. */
  scope(name: string): Logger {
    const parent = this.options.scope;
    return new Logger({
      ...this.options,
      scope: parent ? `${parent}/${name}` : name,
    });
  }

  debug(message: string): void {
    this.write('debug', 'debug', message);
  }

  info(message: string): void {
    this.write('info', 'info', message);
  }

  /** Warnings are shown whenever errors are, because they usually need attention too. */
  warn(message: string): void {
    this.write('error', 'warn', message);
  }

  error(message: string): void {
    this.write('error', 'error', message);
  }

  private write(threshold: LogLevel, label: string, message: string): void {
    const level = this.options.getLevel();
    if (LEVEL_RANK[level] < LEVEL_RANK[threshold] || level === 'none') {
      return;
    }
    const timestamp = this.clock.now().toISOString();
    const scope = this.options.scope ? ` [${this.options.scope}]` : '';
    const safe = redact(message, this.options.getRedactions?.() ?? []);
    this.options.sink.append(`[${timestamp}] [${label}]${scope} ${safe}`);
  }
}

/** Collects lines in memory. Used by tests and by diagnostics. */
export class MemorySink implements LogSink {
  readonly lines: string[] = [];

  append(line: string): void {
    this.lines.push(line);
  }
}
