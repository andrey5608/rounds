import type { RoundsStore, StoreLogger } from '../state/store.js';
import { systemClock } from '../state/time.js';
import type { Clock } from '../state/time.js';
import type { PersistedState, RunClaim } from '../state/types.js';

/** A claim whose heartbeat is older than this belonged to a window that is gone. */
export const CLAIM_DEAD_AFTER_MS = 3 * 60 * 1000;

/** How often the holder refreshes its claim while a run is in flight. */
export const CLAIM_HEARTBEAT_MS = 30_000;

const silentLogger: StoreLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** True when the claim was refreshed recently enough to believe its owner is alive. */
export function isClaimAlive(claim: RunClaim, now: Date, deadAfterMs = CLAIM_DEAD_AFTER_MS): boolean {
  const heartbeat = Date.parse(claim.heartbeatAt);
  if (Number.isNaN(heartbeat)) {
    return false;
  }
  return now.getTime() - heartbeat < deadAfterMs;
}

/** Claims that no living window is refreshing any more, keyed by agent id. */
export function deadClaims(
  state: PersistedState,
  now: Date,
  deadAfterMs = CLAIM_DEAD_AFTER_MS,
): [string, RunClaim][] {
  return Object.entries(state.runClaims).filter(
    ([, claim]) => !isClaimAlive(claim, now, deadAfterMs),
  );
}

export interface RunClaimsOptions {
  store: RoundsStore;
  /** Identifies this window; claims record it so a crash is recognisable. */
  windowId: string;
  clock?: Clock;
  logger?: StoreLogger;
  deadAfterMs?: number;
}

export interface ClaimResult {
  granted: boolean;
  /** The claim that blocked this one, when it was refused. */
  heldBy?: RunClaim;
}

/**
 * Decides which window may run an agent right now.
 *
 * The leader window schedules runs, but "Run now" works everywhere, so two windows can
 * try to run the same agent at the same time. A claim in the shared state settles it: the
 * first writer wins, and a claim whose window died is taken over rather than blocking the
 * agent forever.
 */
export class RunClaims {
  private readonly clock: Clock;
  private readonly logger: StoreLogger;
  private readonly deadAfterMs: number;
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();

  constructor(private readonly options: RunClaimsOptions) {
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
    this.deadAfterMs = options.deadAfterMs ?? CLAIM_DEAD_AFTER_MS;
  }

  /** Tries to claim an agent for a run. */
  async tryClaim(agentId: string, runId: string): Promise<ClaimResult> {
    const now = this.clock.now();
    let result: ClaimResult = { granted: false };

    await this.options.store.update((draft) => {
      // The mutator may run more than once when another window wins a race, so it starts
      // from a clean decision every time.
      result = { granted: false };
      const existing = draft.runClaims[agentId];
      if (existing && isClaimAlive(existing, now, this.deadAfterMs)) {
        result = { granted: false, heldBy: existing };
        return;
      }
      if (existing) {
        this.logger.warn(
          `Took over a run claim for agent ${agentId} from window ${existing.windowId}, whose last heartbeat was ${existing.heartbeatAt}.`,
        );
      }
      draft.runClaims[agentId] = {
        windowId: this.options.windowId,
        runId,
        startedAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
      };
      result = { granted: true };
    });

    return result;
  }

  /** Refreshes the claim so other windows keep treating it as alive. */
  async refresh(agentId: string): Promise<void> {
    const at = this.clock.now().toISOString();
    await this.options.store.update((draft) => {
      const claim = draft.runClaims[agentId];
      if (claim && claim.windowId === this.options.windowId) {
        claim.heartbeatAt = at;
      }
    });
  }

  /** Releases the claim. Claims owned by another window are left alone. */
  async release(agentId: string): Promise<void> {
    this.stopHeartbeat(agentId);
    await this.options.store.update((draft) => {
      const claim = draft.runClaims[agentId];
      if (claim && claim.windowId === this.options.windowId) {
        delete draft.runClaims[agentId];
      }
    });
  }

  /** Starts refreshing a claim in the background until the run finishes. */
  startHeartbeat(agentId: string, intervalMs = CLAIM_HEARTBEAT_MS): void {
    this.stopHeartbeat(agentId);
    const timer = setInterval(() => {
      void this.refresh(agentId);
    }, intervalMs);
    timer.unref?.();
    this.heartbeats.set(agentId, timer);
  }

  stopHeartbeat(agentId: string): void {
    const timer = this.heartbeats.get(agentId);
    if (timer) {
      clearInterval(timer);
      this.heartbeats.delete(agentId);
    }
  }

  /** Claims currently held by this window. */
  async ownClaims(): Promise<[string, RunClaim][]> {
    const state = await this.options.store.read();
    return Object.entries(state.runClaims).filter(
      ([, claim]) => claim.windowId === this.options.windowId,
    );
  }

  dispose(): void {
    for (const agentId of [...this.heartbeats.keys()]) {
      this.stopHeartbeat(agentId);
    }
  }
}
