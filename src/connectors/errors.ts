/**
 * Connector failures, split by what the user has to do about them.
 *
 * A run that failed has to end with an actionable reason in the history. "Request failed"
 * does not tell anybody whether to fix a token, wait, or correct a URL, so every failure is
 * mapped to one of these four.
 */

export type ConnectorErrorCode =
  | 'connector.auth'
  | 'connector.network'
  | 'connector.rateLimit'
  | 'connector.config';

export abstract class ConnectorError extends Error {
  abstract readonly code: ConnectorErrorCode;
  /** Command that opens the right place to fix this, when one exists. */
  readonly fixCommand?: string;

  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** The token is missing, expired, or lacks the scope the request needs. */
export class AuthError extends ConnectorError {
  readonly code = 'connector.auth';
  override readonly fixCommand = 'rounds.checkSetup';

  constructor(host: string, detail?: string) {
    super(
      `The host ${host} rejected the stored token. Run Check Setup to store a valid token, and make sure it has permission to read the data this agent needs.`,
      detail,
    );
  }
}

/** The host could not be reached, or answered with a server error that did not go away. */
export class NetworkError extends ConnectorError {
  readonly code = 'connector.network';

  constructor(host: string, detail?: string) {
    super(`The host ${host} could not be reached. ${detail ?? ''}`.trim(), detail);
  }
}

/** The host asked us to slow down. */
export class RateLimitError extends ConnectorError {
  readonly code = 'connector.rateLimit';

  constructor(
    host: string,
    /** Seconds the host asked us to wait, when it said. */
    readonly retryAfterSeconds?: number,
    detail?: string,
  ) {
    super(
      retryAfterSeconds === undefined
        ? `The host ${host} is rate limiting these requests. Run this agent less often.`
        : `The host ${host} is rate limiting these requests and asked to wait ${retryAfterSeconds}s. Run this agent less often.`,
      detail,
    );
  }
}

/** Something about the configuration is wrong, so retrying cannot help. */
export class ConfigError extends ConnectorError {
  readonly code = 'connector.config';
  override readonly fixCommand = 'rounds.checkSetup';

  constructor(message: string, detail?: string) {
    super(message, detail);
  }
}

/** True for errors that are worth trying again later. */
export function isTransient(error: unknown): boolean {
  return error instanceof NetworkError || error instanceof RateLimitError;
}
