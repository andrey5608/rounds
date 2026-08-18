import { CronExpressionParser } from 'cron-parser';
import cronstrue from 'cronstrue';

/** How many occurrences are inspected when measuring how often a schedule fires. */
const SAMPLE_SIZE = 50;

export interface CronValidation {
  valid: boolean;
  /** English explanation, present when the expression is not usable. */
  error?: string;
}

/** Checks one expression without throwing. */
export function validateCron(expression: string, timeZone?: string): CronValidation {
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Enter a schedule, for example 0 9 * * * for every day at 09:00.' };
  }
  try {
    CronExpressionParser.parse(trimmed, { tz: timeZone });
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `That is not a valid schedule: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The next time any of the expressions fires.
 *
 * An agent may carry several expressions — "every weekday at nine" and "Sunday evening" — so the
 * earliest upcoming occurrence across all of them is the one that matters. An expression that does
 * not parse is skipped rather than taking the others down with it; the wizard and the setup check
 * are where a bad expression gets reported.
 */
export function nextRunAt(
  expressions: readonly string[],
  after: Date,
  timeZone?: string,
): Date | undefined {
  const candidates: number[] = [];
  for (const expression of expressions) {
    try {
      const interval = CronExpressionParser.parse(expression.trim(), {
        tz: timeZone,
        currentDate: after,
      });
      candidates.push(interval.next().toDate().getTime());
    } catch {
      continue;
    }
  }
  if (candidates.length === 0) {
    return undefined;
  }
  return new Date(Math.min(...candidates));
}

/**
 * The next `count` times any of the expressions fires, in order.
 *
 * "Every 30 minutes" tells somebody the rate; three timestamps tell them whether the time zone is
 * the one they had in mind, which is the mistake a schedule preview is there to catch. Several
 * expressions are merged and duplicates dropped — two expressions that both fire at nine on Monday
 * are one run, and showing it twice would suggest otherwise.
 */
export function nextRuns(
  expressions: readonly string[],
  count: number,
  from: Date,
  timeZone?: string,
): Date[] {
  if (count <= 0) {
    return [];
  }
  const times = new Set<number>();
  for (const expression of expressions) {
    try {
      const interval = CronExpressionParser.parse(expression.trim(), {
        tz: timeZone,
        currentDate: from,
      });
      for (let taken = 0; taken < count; taken += 1) {
        times.add(interval.next().toDate().getTime());
      }
    } catch {
      // A single unparseable expression must not hide the preview of the ones that do parse.
      continue;
    }
  }
  return [...times]
    .sort((left, right) => left - right)
    .slice(0, count)
    .map((time) => new Date(time));
}

/** Human-readable description of a schedule, for the tree and the wizard. */
export function describeCron(expressions: readonly string[]): string {
  const described = expressions.map((expression) => {
    try {
      return cronstrue.toString(expression.trim(), { verbose: false });
    } catch {
      return expression.trim();
    }
  });
  return described.join('; ');
}

/**
 * The smallest gap between two consecutive runs, in minutes.
 *
 * Used for the "this runs very often" warning. Measured over a sample of upcoming occurrences
 * rather than parsed out of the expression: a step expression restricted to working hours and
 * `0,5 * * * *` both fire five minutes apart without either saying so anywhere in its text.
 */
export function minIntervalMinutes(
  expressions: readonly string[],
  from: Date = new Date(),
  timeZone?: string,
): number | undefined {
  let smallest: number | undefined;

  for (const expression of expressions) {
    try {
      const interval = CronExpressionParser.parse(expression.trim(), {
        tz: timeZone,
        currentDate: from,
      });
      let previous = interval.next().toDate().getTime();
      for (let index = 1; index < SAMPLE_SIZE; index += 1) {
        const current = interval.next().toDate().getTime();
        const gapMinutes = Math.round((current - previous) / 60_000);
        if (gapMinutes > 0 && (smallest === undefined || gapMinutes < smallest)) {
          smallest = gapMinutes;
        }
        previous = current;
      }
    } catch {
      continue;
    }
  }
  return smallest;
}

/**
 * True when several expressions can fire at the same minute.
 *
 * Two expressions that overlap are not an error, but they make a schedule fire twice as often as
 * either one suggests, which is worth knowing before a rate limit says so.
 */
export function hasOverlap(expressions: readonly string[], from: Date = new Date()): boolean {
  if (expressions.length < 2) {
    return false;
  }
  const occurrences = expressions.map((expression) => {
    try {
      const interval = CronExpressionParser.parse(expression.trim(), { currentDate: from });
      return new Set(
        Array.from({ length: 20 }, () => interval.next().toDate().toISOString().slice(0, 16)),
      );
    } catch {
      return new Set<string>();
    }
  });

  for (let left = 0; left < occurrences.length; left += 1) {
    for (let right = left + 1; right < occurrences.length; right += 1) {
      for (const value of occurrences[left] ?? []) {
        if (occurrences[right]?.has(value)) {
          return true;
        }
      }
    }
  }
  return false;
}
