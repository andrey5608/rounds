/**
 * Turns whatever the language model API threw into something a user can act on.
 *
 * A run that fails must say what to do next. "Request failed" in the history is a dead
 * end; "run Check Setup to grant model access" is not.
 */

export type ModelErrorCode =
  | 'model.noConsent'
  | 'model.quotaExceeded'
  | 'model.unavailable'
  | 'model.blocked'
  | 'model.unknown';

export interface MappedModelError {
  code: ModelErrorCode;
  /** English, addressed to the user, ending with what to do next. */
  message: string;
  /** Command id that fixes it, when one exists. */
  fixCommand?: string;
  /** The original message, kept for the output channel. */
  detail: string;
}

interface ErrorLike {
  name?: string;
  message?: string;
  code?: string | number;
  cause?: unknown;
}

function asErrorLike(error: unknown): ErrorLike {
  if (typeof error === 'object' && error !== null) {
    return error;
  }
  return { message: String(error) };
}

function haystack(error: ErrorLike): string {
  return `${error.name ?? ''} ${String(error.code ?? '')} ${error.message ?? ''}`.toLowerCase();
}

/** Maps a thrown value to a typed, actionable error. */
export function mapModelError(error: unknown): MappedModelError {
  const like = asErrorLike(error);
  const detail = like.message ?? String(error);
  const text = haystack(like);

  if (/nopermission|no permission|consent|not authoriz|unauthorized|forbidden/.test(text)) {
    return {
      code: 'model.noConsent',
      message:
        'Access to the language model was denied. Run Check Setup and grant access when the editor asks for it.',
      fixCommand: 'rounds.checkSetup',
      detail,
    };
  }
  if (/quota|rate limit|too many requests|429|throttl/.test(text)) {
    return {
      code: 'model.quotaExceeded',
      message:
        'The model provider refused the request because of its usage limits. Lower how often your agents run, or reduce the daily limit in the Rounds settings, and try again later.',
      detail,
    };
  }
  if (/notfound|not found|unavailable|no longer|unknown model|model_not_found/.test(text)) {
    return {
      code: 'model.unavailable',
      message:
        'The model this agent uses is not available. Edit the agent and pick a model from the current list.',
      fixCommand: 'rounds.editAgent',
      detail,
    };
  }
  if (/blocked|filtered|content policy|safety/.test(text)) {
    return {
      code: 'model.blocked',
      message: `The model provider blocked this request: ${detail}`,
      detail,
    };
  }
  return {
    code: 'model.unknown',
    message: `The model request failed: ${detail}. Open the Rounds output for the full details.`,
    fixCommand: 'rounds.showOutput',
    detail,
  };
}
