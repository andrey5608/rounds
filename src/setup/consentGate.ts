declare const userActionBrand: unique symbol;

/**
 * Proof that a model call was triggered by the user.
 *
 * The type cannot be produced by accident: only `userAction()` makes one, and
 * scripts/check-consent-gate.mjs keeps calls to that factory inside command handlers and
 * wizard steps. Scheduler and runner code has no way to obtain one, so it cannot cause a
 * consent prompt to appear out of nowhere.
 */
export interface UserAction {
  readonly [userActionBrand]: 'user-action';
  /** What the user did, used in log lines. */
  readonly reason: string;
}

/** Creates the token. Only command handlers and wizard steps may call this. */
export function userAction(reason: string): UserAction {
  return { reason } as UserAction;
}
