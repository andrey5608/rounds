/**
 * Time helpers.
 *
 * Every scheduling decision goes through a `Clock`, so tests can control time instead of
 * waiting for it. Stored timestamps are always ISO-8601 in UTC; local dates and times are
 * derived on demand in the effective time zone.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock that returns a fixed instant, moved forward explicitly. Test helper. */
export class FixedClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(instant: Date): void {
    this.current = new Date(instant.getTime());
  }

  advance(milliseconds: number): void {
    this.current = new Date(this.current.getTime() + milliseconds);
  }
}

function parts(date: Date, timeZone: string | undefined): Record<string, string> {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const result: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    result[part.type] = part.value;
  }
  return result;
}

/** `YYYY-MM-DD` in the given time zone; the system zone when none is given. */
export function localDate(date: Date, timeZone?: string): string {
  const { year, month, day } = parts(date, timeZone);
  return `${year}-${month}-${day}`;
}

/** `HH:mm` in the given time zone; the system zone when none is given. */
export function localTime(date: Date, timeZone?: string): string {
  const { hour, minute } = parts(date, timeZone);
  return `${hour}:${minute}`;
}

/** True when the time zone name is one the runtime understands. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}
