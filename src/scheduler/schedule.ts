import { localTime } from '../state/time.js';
import type { Agent, RunTrigger } from '../state/types.js';

import { nextRunAt } from './cron.js';

/** `HH:mm` to minutes since midnight, or `undefined` when it is not a time. */
export function parseTimeOfDay(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const hours = Number.parseInt(match[1] ?? '', 10);
  const minutes = Number.parseInt(match[2] ?? '', 10);
  if (hours > 23 || minutes > 59) {
    return undefined;
  }
  return hours * 60 + minutes;
}

/**
 * True when `now` falls inside the agent's allowed window.
 *
 * A window that ends before it starts crosses midnight — "22:00 to 06:00" is a perfectly ordinary
 * way to say "overnight", and reading it as an empty range would silently stop the agent forever.
 */
export function isWithinAllowedWindow(agent: Agent, now: Date, timeZone?: string): boolean {
  const start = parseTimeOfDay(agent.allowedTimeStart);
  const end = parseTimeOfDay(agent.allowedTimeEnd);
  if (start === undefined || end === undefined) {
    return true;
  }
  const current = parseTimeOfDay(localTime(now, timeZone)) ?? 0;
  if (start === end) {
    return true;
  }
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export interface DueDecision {
  due: boolean;
  reason?: 'disabled' | 'globallyDisabled' | 'noSchedule' | 'notYet' | 'outsideWindow';
  /** Present when the agent has a schedule at all. */
  nextRunAt?: Date;
}

export interface DueInput {
  agent: Agent;
  now: Date;
  /** `rounds.enabled`. */
  schedulingEnabled: boolean;
  timeZone?: string;
}

/**
 * Decides whether an agent is due right now.
 *
 * Kept separate from the ticker so the decision can be tested against an injected clock instead of
 * waiting for wall time.
 */
export function evaluateDue(input: DueInput): DueDecision {
  const { agent, now } = input;
  if (!input.schedulingEnabled) {
    return { due: false, reason: 'globallyDisabled' };
  }
  if (!agent.enabled) {
    return { due: false, reason: 'disabled' };
  }
  if (agent.schedule.cronExpressions.length === 0) {
    return { due: false, reason: 'noSchedule' };
  }
  if (!agent.nextRunAt) {
    // A schedule with no computed next run is not due; the bookkeeping fills it in.
    return { due: false, reason: 'notYet', nextRunAt: undefined };
  }

  const due = Date.parse(agent.nextRunAt) <= now.getTime();
  if (!due) {
    return { due: false, reason: 'notYet', nextRunAt: new Date(agent.nextRunAt) };
  }
  if (!isWithinAllowedWindow(agent, now, effectiveTimeZone(agent, input.timeZone))) {
    return { due: false, reason: 'outsideWindow', nextRunAt: new Date(agent.nextRunAt) };
  }
  return { due: true, nextRunAt: new Date(agent.nextRunAt) };
}

/** Time zone that applies to this agent: its own, then the setting, then the system. */
export function effectiveTimeZone(agent: Agent, settingTimeZone?: string): string | undefined {
  return agent.schedule.timezone ?? settingTimeZone;
}

/** The next occurrence strictly after `after`. */
export function computeNextRun(
  agent: Agent,
  after: Date,
  settingTimeZone?: string,
): Date | undefined {
  return nextRunAt(agent.schedule.cronExpressions, after, effectiveTimeZone(agent, settingTimeZone));
}

export interface MissedRunDecision {
  /** True when the missed occurrence should be run once, now. */
  runNow: boolean;
  /** Where `nextRunAt` should point afterwards. */
  nextRunAt?: Date;
  trigger?: RunTrigger;
}

/**
 * What to do with an occurrence that came due while no window was open.
 *
 * `skip` moves the schedule on without comment; `runOnce` runs the missed occurrence a single time,
 * however many were missed. Replaying every missed run of a weekend would be both surprising and a
 * quick way to exhaust a daily limit.
 */
export function decideMissedRun(
  agent: Agent,
  now: Date,
  settingTimeZone?: string,
): MissedRunDecision {
  if (!agent.nextRunAt || Date.parse(agent.nextRunAt) > now.getTime()) {
    return { runNow: false, nextRunAt: agent.nextRunAt ? new Date(agent.nextRunAt) : undefined };
  }
  const next = computeNextRun(agent, now, settingTimeZone);
  if (agent.schedule.missedRunPolicy === 'runOnce') {
    return { runNow: true, nextRunAt: next, trigger: 'missedRun' };
  }
  return { runNow: false, nextRunAt: next };
}

/**
 * Where `nextRunAt` goes after a manual run.
 *
 * `advance` keeps the schedule the user set up — pressing Run Now to check something should not
 * move tomorrow's nine o'clock report. `fromNow` restarts the interval, which is what somebody
 * wants when the manual run replaces the scheduled one.
 */
export function nextRunAfterManualRun(
  agent: Agent,
  now: Date,
  policy: 'advance' | 'fromNow',
  settingTimeZone?: string,
): Date | undefined {
  if (policy === 'advance' && agent.nextRunAt && Date.parse(agent.nextRunAt) > now.getTime()) {
    return new Date(agent.nextRunAt);
  }
  return computeNextRun(agent, now, settingTimeZone);
}

/** Random delay before a scheduled run, in seconds. Manual runs never get one. */
export function pickJitterSeconds(
  trigger: RunTrigger,
  jitterSeconds: number,
  random: () => number = Math.random,
): number {
  if (trigger === 'manual' || jitterSeconds <= 0) {
    return 0;
  }
  return Math.floor(random() * Math.min(1800, jitterSeconds));
}
