import type { RoundsStore } from './store.js';
import { localDate, systemClock } from './time.js';
import type { Clock } from './time.js';
import type { DailyCounters, PersistedState } from './types.js';

/** Why a run may not start right now. */
export type CapReason = 'globalCap' | 'agentCap';

export interface CapDecision {
  allowed: boolean;
  reason?: CapReason;
  /** The limit that was reached, for the message shown to the user. */
  limit?: number;
}

/** The agent fields the cap logic needs. Keeps this file independent of the full type. */
export interface CappedAgent {
  id: string;
  maxExecutionsPerDay?: number;
}

/**
 * Resets the counters when the local day changed.
 *
 * "Day" is the local day in the effective time zone, not a rolling 24 hours: a user who
 * allows 24 runs per day expects the budget back at local midnight.
 */
export function rollover(counters: DailyCounters, today: string): DailyCounters {
  if (counters.localDate === today) {
    return counters;
  }
  return { localDate: today, global: 0, perAgent: {} };
}

/** Decides whether one more run fits into today's budget. */
export function evaluateCap(
  counters: DailyCounters,
  today: string,
  agent: CappedAgent,
  globalLimit: number,
): CapDecision {
  const current = rollover(counters, today);
  const agentLimit = agent.maxExecutionsPerDay;
  const agentCount = current.perAgent[agent.id] ?? 0;

  if (agentLimit !== undefined && agentCount >= agentLimit) {
    return { allowed: false, reason: 'agentCap', limit: agentLimit };
  }
  if (current.global >= globalLimit) {
    return { allowed: false, reason: 'globalCap', limit: globalLimit };
  }
  return { allowed: true };
}

/** Counts one run against today's budget. */
export function countRun(state: PersistedState, agentId: string, today: string): void {
  const counters = rollover(state.counters, today);
  counters.global += 1;
  counters.perAgent[agentId] = (counters.perAgent[agentId] ?? 0) + 1;
  state.counters = counters;
}

/** True when the user has not been told about a reached cap on this local day yet. */
export function shouldNotifyCap(counters: DailyCounters, today: string): boolean {
  if (counters.localDate !== today) {
    return true;
  }
  return counters.capNotifiedAt === undefined;
}

/** Remembers that the cap notification was already shown today. */
export function markCapNotified(state: PersistedState, today: string, at: string): void {
  const counters = rollover(state.counters, today);
  counters.capNotifiedAt = at;
  state.counters = counters;
}

export interface CountersServiceOptions {
  store: RoundsStore;
  /** Global cap, read fresh so a settings change applies without a restart. */
  getGlobalLimit: () => number;
  /** Effective time zone, read fresh for the same reason. */
  getTimeZone: () => string | undefined;
  clock?: Clock;
}

/** Store-backed daily counters. */
export class CountersService {
  private readonly clock: Clock;

  constructor(private readonly options: CountersServiceOptions) {
    this.clock = options.clock ?? systemClock;
  }

  /** Today's date in the effective time zone. */
  today(): string {
    return localDate(this.clock.now(), this.options.getTimeZone());
  }

  async canRun(agent: CappedAgent): Promise<CapDecision> {
    const state = await this.options.store.read();
    return evaluateCap(state.counters, this.today(), agent, this.options.getGlobalLimit());
  }

  async count(agentId: string): Promise<void> {
    const today = this.today();
    await this.options.store.update((draft) => {
      countRun(draft, agentId, today);
    });
  }

  async shouldNotify(): Promise<boolean> {
    const state = await this.options.store.read();
    return shouldNotifyCap(state.counters, this.today());
  }

  async markNotified(): Promise<void> {
    const today = this.today();
    const at = this.clock.now().toISOString();
    await this.options.store.update((draft) => {
      markCapNotified(draft, today, at);
    });
  }
}
