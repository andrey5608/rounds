import * as assert from 'node:assert/strict';

import {
  describeCron,
  hasOverlap,
  minIntervalMinutes,
  nextRunAt,
  validateCron,
} from '../../scheduler/cron.js';
import {
  computeNextRun,
  decideMissedRun,
  evaluateDue,
  isWithinAllowedWindow,
  nextRunAfterManualRun,
  parseTimeOfDay,
  pickJitterSeconds,
} from '../../scheduler/schedule.js';
import type { Agent } from '../../state/types.js';

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Morning triage',
    enabled: true,
    executionMode: 'api',
    schedule: { cronExpressions: ['0 9 * * *'], runOnStartup: false, missedRunPolicy: 'skip' },
    source: { kind: 'jira', baseUrlRef: 'tracker', jql: 'project = ROUNDS', maxResults: 20 },
    prompt: { source: 'inline', inlineText: 'Summarize {{items}}' },
    modelId: 'model-a',
    tools: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('cron expressions', () => {
  it('accepts an ordinary expression', () => {
    assert.deepEqual(validateCron('0 9 * * *'), { valid: true });
  });

  it('rejects nonsense with an explanation', () => {
    const result = validateCron('every morning');
    assert.equal(result.valid, false);
    assert.ok((result.error ?? '').length > 0);
  });

  it('asks for a schedule when the field is empty', () => {
    assert.match(validateCron('  ').error ?? '', /Enter a schedule/);
  });

  it('computes the next occurrence in a given time zone', () => {
    const after = new Date('2026-08-17T06:00:00.000Z');
    assert.equal(
      nextRunAt(['0 9 * * *'], after, 'Europe/Berlin')?.toISOString(),
      '2026-08-17T07:00:00.000Z',
    );
    assert.equal(
      nextRunAt(['0 9 * * *'], after, 'UTC')?.toISOString(),
      '2026-08-17T09:00:00.000Z',
    );
  });

  it('takes the earliest occurrence across several expressions', () => {
    const after = new Date('2026-08-17T06:00:00.000Z');
    const next = nextRunAt(['0 18 * * *', '0 9 * * *'], after, 'UTC');
    assert.equal(next?.toISOString(), '2026-08-17T09:00:00.000Z');
  });

  it('ignores an expression that does not parse instead of failing outright', () => {
    const after = new Date('2026-08-17T06:00:00.000Z');
    const next = nextRunAt(['nonsense', '0 9 * * *'], after, 'UTC');
    assert.equal(next?.toISOString(), '2026-08-17T09:00:00.000Z');
  });

  it('returns nothing when no expression is usable', () => {
    assert.equal(nextRunAt(['nonsense'], new Date(), 'UTC'), undefined);
  });

  it('describes a schedule in words', () => {
    assert.match(describeCron(['0 9 * * *']), /09:00/);
    assert.match(describeCron(['0 9 * * *', '0 18 * * 0']), /;/);
  });

  it('falls back to the raw expression it cannot describe', () => {
    assert.equal(describeCron(['not a cron']), 'not a cron');
  });

  it('measures how often a schedule fires', () => {
    const from = new Date('2026-08-17T00:00:00.000Z');
    assert.equal(minIntervalMinutes(['0 9 * * *'], from, 'UTC'), 1440);
    assert.equal(minIntervalMinutes(['*/5 * * * *'], from, 'UTC'), 5);
    assert.equal(minIntervalMinutes(['0,5 * * * *'], from, 'UTC'), 5);
  });

  it('reports the smallest gap across expressions', () => {
    const from = new Date('2026-08-17T00:00:00.000Z');
    assert.equal(minIntervalMinutes(['0 9 * * *', '*/10 * * * *'], from, 'UTC'), 10);
  });

  it('notices two expressions that fire at the same time', () => {
    const from = new Date('2026-08-17T00:00:00.000Z');
    assert.equal(hasOverlap(['0 9 * * *', '0 9 * * *'], from), true);
    assert.equal(hasOverlap(['0 9 * * *', '0 18 * * *'], from), false);
    assert.equal(hasOverlap(['0 9 * * *'], from), false);
  });
});

describe('time of day', () => {
  it('parses a time', () => {
    assert.equal(parseTimeOfDay('09:30'), 570);
    assert.equal(parseTimeOfDay('9:05'), 545);
    assert.equal(parseTimeOfDay('00:00'), 0);
  });

  it('rejects anything that is not a time', () => {
    for (const value of [undefined, '', 'nine', '25:00', '09:60', '0930']) {
      assert.equal(parseTimeOfDay(value), undefined, String(value));
    }
  });
});

describe('allowed time window', () => {
  it('allows everything when no window is configured', () => {
    assert.equal(isWithinAllowedWindow(agent(), new Date('2026-08-17T03:00:00.000Z'), 'UTC'), true);
  });

  it('allows everything when only one end is configured', () => {
    assert.equal(
      isWithinAllowedWindow(agent({ allowedTimeStart: '09:00' }), new Date('2026-08-17T03:00:00.000Z'), 'UTC'),
      true,
    );
  });

  it('respects an ordinary daytime window', () => {
    const daytime = agent({ allowedTimeStart: '09:00', allowedTimeEnd: '17:00' });
    assert.equal(isWithinAllowedWindow(daytime, new Date('2026-08-17T10:00:00.000Z'), 'UTC'), true);
    assert.equal(isWithinAllowedWindow(daytime, new Date('2026-08-17T08:59:00.000Z'), 'UTC'), false);
    assert.equal(isWithinAllowedWindow(daytime, new Date('2026-08-17T17:00:00.000Z'), 'UTC'), false);
  });

  it('handles a window that crosses midnight', () => {
    const overnight = agent({ allowedTimeStart: '22:00', allowedTimeEnd: '06:00' });
    assert.equal(isWithinAllowedWindow(overnight, new Date('2026-08-17T23:30:00.000Z'), 'UTC'), true);
    assert.equal(isWithinAllowedWindow(overnight, new Date('2026-08-17T02:00:00.000Z'), 'UTC'), true);
    assert.equal(isWithinAllowedWindow(overnight, new Date('2026-08-17T12:00:00.000Z'), 'UTC'), false);
  });

  it('reads the window in the effective time zone', () => {
    const daytime = agent({
      allowedTimeStart: '09:00',
      allowedTimeEnd: '17:00',
      schedule: { cronExpressions: ['0 * * * *'], runOnStartup: false, missedRunPolicy: 'skip', timezone: 'Asia/Tokyo' },
    });
    // 01:00 UTC is 10:00 in Tokyo, inside the window; 20:00 UTC is 05:00 the next day, outside.
    assert.equal(isWithinAllowedWindow(daytime, new Date('2026-08-17T01:00:00.000Z'), 'Asia/Tokyo'), true);
    assert.equal(isWithinAllowedWindow(daytime, new Date('2026-08-17T20:00:00.000Z'), 'Asia/Tokyo'), false);
  });
});

describe('due evaluation', () => {
  const now = new Date('2026-08-17T09:00:30.000Z');

  it('is due once the next run time has passed', () => {
    const decision = evaluateDue({
      agent: agent({ nextRunAt: '2026-08-17T09:00:00.000Z' }),
      now,
      schedulingEnabled: true,
      timeZone: 'UTC',
    });
    assert.equal(decision.due, true);
  });

  it('is not due before its time', () => {
    const decision = evaluateDue({
      agent: agent({ nextRunAt: '2026-08-17T18:00:00.000Z' }),
      now,
      schedulingEnabled: true,
      timeZone: 'UTC',
    });
    assert.deepEqual(decision.reason, 'notYet');
    assert.equal(decision.due, false);
  });

  it('is never due while scheduling is switched off', () => {
    const decision = evaluateDue({
      agent: agent({ nextRunAt: '2026-08-17T09:00:00.000Z' }),
      now,
      schedulingEnabled: false,
    });
    assert.deepEqual(decision, { due: false, reason: 'globallyDisabled' });
  });

  it('is never due while the agent is disabled', () => {
    const decision = evaluateDue({
      agent: agent({ enabled: false, nextRunAt: '2026-08-17T09:00:00.000Z' }),
      now,
      schedulingEnabled: true,
    });
    assert.deepEqual(decision, { due: false, reason: 'disabled' });
  });

  it('is not due without a computed next run', () => {
    const decision = evaluateDue({ agent: agent(), now, schedulingEnabled: true });
    assert.equal(decision.due, false);
    assert.equal(decision.reason, 'notYet');
  });

  it('is not due outside the allowed window, even when the time has come', () => {
    const decision = evaluateDue({
      agent: agent({
        nextRunAt: '2026-08-17T09:00:00.000Z',
        allowedTimeStart: '22:00',
        allowedTimeEnd: '06:00',
      }),
      now,
      schedulingEnabled: true,
      timeZone: 'UTC',
    });
    assert.equal(decision.due, false);
    assert.equal(decision.reason, 'outsideWindow');
  });
});

describe('missed runs', () => {
  const now = new Date('2026-08-19T12:00:00.000Z');

  it('does nothing when the next run is still ahead', () => {
    const decision = decideMissedRun(agent({ nextRunAt: '2026-08-20T09:00:00.000Z' }), now, 'UTC');
    assert.equal(decision.runNow, false);
    assert.equal(decision.nextRunAt?.toISOString(), '2026-08-20T09:00:00.000Z');
  });

  it('skips the missed occurrence and moves on under the skip policy', () => {
    const decision = decideMissedRun(agent({ nextRunAt: '2026-08-17T09:00:00.000Z' }), now, 'UTC');
    assert.equal(decision.runNow, false);
    assert.equal(decision.nextRunAt?.toISOString(), '2026-08-20T09:00:00.000Z');
  });

  it('runs a missed occurrence once under the runOnce policy', () => {
    const decision = decideMissedRun(
      agent({
        nextRunAt: '2026-08-17T09:00:00.000Z',
        schedule: { cronExpressions: ['0 9 * * *'], runOnStartup: false, missedRunPolicy: 'runOnce' },
      }),
      now,
      'UTC',
    );
    assert.equal(decision.runNow, true);
    assert.equal(decision.trigger, 'missedRun');
    // Two days were missed and exactly one run happens, not one per missed day.
    assert.equal(decision.nextRunAt?.toISOString(), '2026-08-20T09:00:00.000Z');
  });
});

describe('next run bookkeeping', () => {
  const now = new Date('2026-08-17T12:00:00.000Z');

  it('computes the next occurrence after a run', () => {
    assert.equal(computeNextRun(agent(), now, 'UTC')?.toISOString(), '2026-08-18T09:00:00.000Z');
  });

  it('keeps the scheduled run under the advance policy', () => {
    const next = nextRunAfterManualRun(
      agent({ nextRunAt: '2026-08-18T09:00:00.000Z' }),
      now,
      'advance',
      'UTC',
    );
    assert.equal(next?.toISOString(), '2026-08-18T09:00:00.000Z');
  });

  it('recomputes from now under the fromNow policy', () => {
    const next = nextRunAfterManualRun(
      agent({ nextRunAt: '2026-08-18T09:00:00.000Z' }),
      now,
      'fromNow',
      'UTC',
    );
    assert.equal(next?.toISOString(), '2026-08-18T09:00:00.000Z');
  });

  it('computes a fresh next run when the stored one is already past', () => {
    const next = nextRunAfterManualRun(
      agent({ nextRunAt: '2026-08-01T09:00:00.000Z' }),
      now,
      'advance',
      'UTC',
    );
    assert.equal(next?.toISOString(), '2026-08-18T09:00:00.000Z');
  });
});

describe('jitter', () => {
  it('never delays a manual run', () => {
    assert.equal(pickJitterSeconds('manual', 600, () => 0.9), 0);
  });

  it('delays a scheduled run by a random amount inside the bound', () => {
    assert.equal(pickJitterSeconds('schedule', 600, () => 0), 0);
    assert.equal(pickJitterSeconds('schedule', 600, () => 0.5), 300);
    assert.equal(pickJitterSeconds('schedule', 600, () => 0.999), 599);
  });

  it('respects the hard upper bound whatever the setting says', () => {
    assert.equal(pickJitterSeconds('schedule', 100_000, () => 0.999), 1798);
  });

  it('is off when the setting is zero', () => {
    assert.equal(pickJitterSeconds('schedule', 0, () => 0.9), 0);
  });
});
