import type { RoundsStore, StoreLogger } from '../state/store.js';
import { systemClock } from '../state/time.js';
import type { Clock } from '../state/time.js';

import { CLAIM_DEAD_AFTER_MS, isClaimAlive } from './runClaims.js';

export interface RecoveryOptions {
  store: RoundsStore;
  /** Identifier of this activation. */
  windowId: string;
  clock?: Clock;
  logger?: StoreLogger;
  deadAfterMs?: number;
}

export interface RecoveryResult {
  /** Agent ids whose claim was cleared. */
  clearedClaims: string[];
  /** Run ids that were marked as interrupted. */
  interruptedRuns: string[];
}

/**
 * Cleans up what a crash left behind.
 *
 * Two kinds of leftovers matter at activation. A claim tagged with *this* window id can
 * only be a leftover, because the id is generated per activation and never reused: the
 * previous process died without releasing it. A claim from any window whose heartbeat
 * stopped means the same thing. Both would otherwise block their agent forever, and the
 * run they belonged to would sit in the history as though it were still going.
 */
export async function recoverStaleClaims(options: RecoveryOptions): Promise<RecoveryResult> {
  const clock = options.clock ?? systemClock;
  const deadAfterMs = options.deadAfterMs ?? CLAIM_DEAD_AFTER_MS;
  const now = clock.now();
  let result: RecoveryResult = { clearedClaims: [], interruptedRuns: [] };

  await options.store.update((draft) => {
    // The mutator may run again after a lost race, so it recomputes from scratch.
    result = { clearedClaims: [], interruptedRuns: [] };

    for (const [agentId, claim] of Object.entries(draft.runClaims)) {
      const ownedByThisActivation = claim.windowId === options.windowId;
      if (!ownedByThisActivation && isClaimAlive(claim, now, deadAfterMs)) {
        continue;
      }

      delete draft.runClaims[agentId];
      result.clearedClaims.push(agentId);

      const runs = draft.history[agentId] ?? [];
      const abandoned = runs.find((run) => run.id === claim.runId && run.status === 'running');
      if (abandoned) {
        abandoned.status = 'interrupted';
        abandoned.finishedAt = now.toISOString();
        abandoned.summary = 'The window running this agent stopped before the run finished.';
        result.interruptedRuns.push(abandoned.id);
      }
    }
  });

  if (result.clearedClaims.length > 0) {
    options.logger?.warn(
      `Cleared ${result.clearedClaims.length} abandoned run claim(s) and marked ${result.interruptedRuns.length} run(s) as interrupted.`,
    );
  }
  return result;
}
