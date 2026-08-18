import type { AgentRunner } from '../agents/runner.js';
import type { Logger } from '../state/logger.js';
import type { RoundsSettings } from '../state/settings.js';
import type { RoundsStore } from '../state/store.js';
import { systemClock } from '../state/time.js';
import type { Clock } from '../state/time.js';
import type { Agent, RunRecord } from '../state/types.js';

import { minIntervalMinutes } from './cron.js';
import {
  computeNextRun,
  decideMissedRun,
  effectiveTimeZone,
  evaluateDue,
  nextRunAfterManualRun,
  pickJitterSeconds,
} from './schedule.js';

export const TICK_INTERVAL_MS = 30_000;

/** How many agents may run in the first few minutes after this window took over. */
export const STARTUP_BURST_LIMIT = 3;
export const STARTUP_WINDOW_MS = 5 * 60 * 1000;

export interface TickerDependencies {
  store: RoundsStore;
  runner: AgentRunner;
  settings: () => RoundsSettings;
  logger: Logger;
  clock?: Clock;
  random?: () => number;
  /** Waits, interruptibly. Injected so tests do not spend the jitter in real time. */
  sleep?: (ms: number, isCancelled: () => boolean) => Promise<void>;
  /** Called when a run was blocked by the daily limit and the user has not been told today. */
  onCapReached?: (message: string) => void;
  /**
   * Called with every agent whose schedule fires more often than the warning threshold.
   *
   * All of them at once, not one call each: this is evaluated for every agent when a window
   * takes over, and four fast agents used to mean four separate warnings saying the same thing.
   */
  onFrequencyWarning?: (entries: { agent: Agent; intervalMinutes: number }[]) => void;
  /** Called when a scheduled run failed. Deduplicated by the caller. */
  onRunFailed?: (agent: Agent, record: RunRecord) => void;
  /** Called after every run so the view can refresh. */
  onRunFinished?: (agent: Agent, record: RunRecord) => void;
}

async function defaultSleep(ms: number, isCancelled: () => boolean): Promise<void> {
  const step = 500;
  for (let waited = 0; waited < ms; waited += step) {
    if (isCancelled()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
  }
}

/**
 * Fires agents when they are due.
 *
 * Only the leader window runs one of these, and it runs due agents **sequentially**. Running them
 * in parallel would send several model requests at the same second, which is exactly the traffic
 * pattern that gets an account rate limited — the opposite of what the jitter is for.
 */
export class Ticker {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private stopped = true;
  private readonly clock: Clock;
  private readonly inFlight = new Set<string>();
  private startedAt: Date | undefined;
  private startupRuns = 0;

  constructor(private readonly dependencies: TickerDependencies) {
    this.clock = dependencies.clock ?? systemClock;
  }

  get isRunning(): boolean {
    return this.timer !== undefined;
  }

  /** Starts ticking. Safe to call twice. */
  start(): void {
    if (this.timer) {
      return;
    }
    this.stopped = false;
    this.startedAt = this.clock.now();
    this.startupRuns = 0;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    this.timer.unref?.();
    this.dependencies.logger.info('This window now schedules runs; checking every 30 seconds.');
  }

  /** Stops ticking. In-flight runs are cancelled through their own cancellation check. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.dependencies.logger.info('This window stopped scheduling runs.');
    }
  }

  dispose(): void {
    this.stop();
  }

  /**
   * One pass over the agents. Exposed so tests can drive it without waiting for the interval.
   *
   * Overlapping ticks are skipped rather than queued: a tick that is still working means the
   * previous pass has not finished, and starting another one would run agents twice.
   */
  async tick(): Promise<RunRecord[]> {
    if (this.ticking || this.stopped) {
      return [];
    }
    this.ticking = true;
    const records: RunRecord[] = [];

    try {
      const settings = this.dependencies.settings();
      const state = await this.dependencies.store.read();
      const now = this.clock.now();

      for (const agent of state.agents) {
        if (this.stopped) {
          break;
        }
        if (this.inFlight.has(agent.id)) {
          continue;
        }

        const decision = evaluateDue({
          agent,
          now,
          schedulingEnabled: settings.enabled,
          timeZone: settings.timezone,
        });

        if (decision.reason === 'outsideWindow') {
          this.dependencies.logger.debug(
            `Agent "${agent.name}" was due but is outside its allowed time window; moving it on.`,
          );
          await this.advanceNextRun(agent, now, settings);
          continue;
        }
        if (!decision.due) {
          continue;
        }
        if (!this.mayRunDuringStartup(now)) {
          this.dependencies.logger.debug(
            `Agent "${agent.name}" is due but the start-up burst limit applies; it waits for the next tick.`,
          );
          continue;
        }

        const record = await this.runAgent(agent, 'schedule', settings);
        if (record) {
          records.push(record);
        }
      }
    } catch (error) {
      // A failing tick must never stop the ticker; the next one may well succeed.
      this.dependencies.logger.error(`A scheduling pass failed: ${String(error)}`);
    } finally {
      this.ticking = false;
    }
    return records;
  }

  /**
   * Applies the missed-run policy and the start-up flag once, after taking over scheduling.
   *
   * This is the counterpart of "agents run only while the editor is open": whatever came due while
   * every window was closed is decided here, not silently forgotten.
   */
  async catchUp(): Promise<RunRecord[]> {
    const settings = this.dependencies.settings();
    const state = await this.dependencies.store.read();
    const now = this.clock.now();
    const records: RunRecord[] = [];
    const tooFrequent: { agent: Agent; intervalMinutes: number }[] = [];

    for (const agent of state.agents) {
      if (!agent.enabled || !settings.enabled) {
        continue;
      }

      const interval = this.frequencyWarningFor(agent, now, settings);
      if (interval !== undefined) {
        tooFrequent.push({ agent, intervalMinutes: interval });
      }

      const missed = decideMissedRun(agent, now, settings.timezone);
      if (missed.nextRunAt) {
        await this.storeNextRun(agent.id, missed.nextRunAt);
      } else if (!agent.nextRunAt) {
        const next = computeNextRun(agent, now, settings.timezone);
        if (next) {
          await this.storeNextRun(agent.id, next);
        }
      }

      const shouldRun = missed.runNow || agent.schedule.runOnStartup;
      if (!shouldRun || !this.mayRunDuringStartup(now)) {
        continue;
      }
      const record = await this.runAgent(agent, missed.runNow ? 'missedRun' : 'startup', settings);
      if (record) {
        records.push(record);
      }
    }

    if (tooFrequent.length > 0) {
      this.dependencies.onFrequencyWarning?.(tooFrequent);
    }
    return records;
  }

  /** Recomputes every next run, for example after the time zone setting changed. */
  async recomputeAll(): Promise<void> {
    const settings = this.dependencies.settings();
    const state = await this.dependencies.store.read();
    const now = this.clock.now();
    const next = new Map<string, string | undefined>();

    for (const agent of state.agents) {
      const computed = agent.enabled ? computeNextRun(agent, now, settings.timezone) : undefined;
      next.set(agent.id, computed?.toISOString());
    }

    await this.dependencies.store.update((draft) => {
      for (const agent of draft.agents) {
        if (next.has(agent.id)) {
          agent.nextRunAt = next.get(agent.id);
        }
      }
    });
  }

  /** Runs one agent with jitter, then moves its schedule on. */
  private async runAgent(
    agent: Agent,
    trigger: 'schedule' | 'startup' | 'missedRun',
    settings: RoundsSettings,
  ): Promise<RunRecord | undefined> {
    this.inFlight.add(agent.id);
    this.startupRuns += 1;
    try {
      const jitterSeconds = pickJitterSeconds(
        trigger === 'schedule' ? 'schedule' : trigger,
        settings.jitterSeconds,
        this.dependencies.random,
      );
      if (jitterSeconds > 0) {
        this.dependencies.logger.debug(
          `Waiting ${jitterSeconds}s before running "${agent.name}" so runs do not all start at the same second.`,
        );
        const sleep = this.dependencies.sleep ?? defaultSleep;
        await sleep(jitterSeconds * 1000, () => this.stopped);
        if (this.stopped) {
          this.dependencies.logger.debug(`The delay before "${agent.name}" was interrupted.`);
          return undefined;
        }
      }

      const record = await this.dependencies.runner.run({
        agent,
        trigger,
        jitterSeconds,
        isCancelled: () => this.stopped,
      });

      await this.reportCap(record, agent, settings);
      if (record.status === 'failed') {
        this.dependencies.onRunFailed?.(agent, record);
      }
      this.dependencies.onRunFinished?.(agent, record);
      const now = this.clock.now();
      const next = computeNextRun(agent, now, settings.timezone);
      if (next) {
        await this.storeNextRun(agent.id, next);
      }
      return record;
    } finally {
      this.inFlight.delete(agent.id);
    }
  }

  /** Tells the user once per local day that the daily limit stopped a run. */
  private async reportCap(
    record: RunRecord,
    agent: Agent,
    settings: RoundsSettings,
  ): Promise<void> {
    if (record.status !== 'skipped' || !/limit/i.test(record.summary)) {
      return;
    }
    void settings;
    const state = await this.dependencies.store.read();
    if (state.counters.capNotifiedAt !== undefined) {
      return;
    }
    this.dependencies.onCapReached?.(
      `Rounds reached its daily run limit, so "${agent.name}" was skipped. Raise the limit in the settings if that is not what you want.`,
    );
    await this.dependencies.store.update((draft) => {
      draft.counters.capNotifiedAt = this.clock.now().toISOString();
    });
  }

  /**
   * The interval to warn about, or `undefined` when this schedule is not frequent enough to.
   *
   * Reporting is the caller's job: every agent is checked in one pass, and the whole set is
   * handed over at once so it can become one message instead of one per agent.
   */
  private frequencyWarningFor(
    agent: Agent,
    now: Date,
    settings: RoundsSettings,
  ): number | undefined {
    const interval = minIntervalMinutes(
      agent.schedule.cronExpressions,
      now,
      effectiveTimeZone(agent, settings.timezone),
    );
    if (interval === undefined || interval >= settings.minimumIntervalWarning) {
      return undefined;
    }
    this.dependencies.logger.warn(
      `Agent "${agent.name}" runs every ${interval} minute(s), more often than the ${settings.minimumIntervalWarning} minute warning threshold.`,
    );
    return interval;
  }

  /** Moves an agent's schedule on without running it. */
  private async advanceNextRun(agent: Agent, now: Date, settings: RoundsSettings): Promise<void> {
    const next = computeNextRun(agent, now, settings.timezone);
    if (next) {
      await this.storeNextRun(agent.id, next);
    }
  }

  private async storeNextRun(agentId: string, next: Date): Promise<void> {
    const value = next.toISOString();
    await this.dependencies.store.update((draft) => {
      const agent = draft.agents.find((candidate) => candidate.id === agentId);
      if (agent) {
        agent.nextRunAt = value;
      }
    });
  }

  /**
   * Keeps a window that just took over from firing everything at once.
   *
   * Several agents whose schedules all passed while the editor was closed would otherwise produce a
   * burst of requests the moment somebody opens their editor in the morning.
   */
  private mayRunDuringStartup(now: Date): boolean {
    if (!this.startedAt || now.getTime() - this.startedAt.getTime() > STARTUP_WINDOW_MS) {
      return true;
    }
    return this.startupRuns < STARTUP_BURST_LIMIT;
  }
}

/** Where `nextRunAt` should point after a manual run, per the configured policy. */
export function nextRunAfterManual(
  agent: Agent,
  now: Date,
  settings: RoundsSettings,
): Date | undefined {
  return nextRunAfterManualRun(agent, now, settings.manualRunNextRunPolicy, settings.timezone);
}
