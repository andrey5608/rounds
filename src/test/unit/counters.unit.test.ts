import * as assert from 'node:assert/strict';

import {
  CountersService,
  countRun,
  evaluateCap,
  markCapNotified,
  rollover,
  shouldNotifyCap,
} from '../../state/counters.js';
import { MementoBackend, RoundsStore } from '../../state/store.js';
import type { MementoLike } from '../../state/store.js';
import { FixedClock, localDate } from '../../state/time.js';
import type { DailyCounters } from '../../state/types.js';
import { emptyState } from '../../state/validate.js';

class FakeMemento implements MementoLike {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

function counters(overrides: Partial<DailyCounters> = {}): DailyCounters {
  return { localDate: '2026-08-17', global: 0, perAgent: {}, ...overrides };
}

describe('daily counters', () => {
  it('resets when the local day changed', () => {
    const rolled = rollover(counters({ global: 5, perAgent: { 'agent-1': 5 } }), '2026-08-18');
    assert.deepEqual(rolled, { localDate: '2026-08-18', global: 0, perAgent: {} });
  });

  it('keeps the counters within the same day', () => {
    const same = counters({ global: 5 });
    assert.equal(rollover(same, '2026-08-17'), same);
  });

  it('allows a run below both limits', () => {
    const decision = evaluateCap(counters({ global: 3 }), '2026-08-17', { id: 'agent-1' }, 24);
    assert.deepEqual(decision, { allowed: true });
  });

  it('blocks on the global limit', () => {
    const decision = evaluateCap(counters({ global: 24 }), '2026-08-17', { id: 'agent-1' }, 24);
    assert.deepEqual(decision, { allowed: false, reason: 'globalCap', limit: 24 });
  });

  it('blocks on the agent limit before the global one', () => {
    const decision = evaluateCap(
      counters({ global: 24, perAgent: { 'agent-1': 2 } }),
      '2026-08-17',
      { id: 'agent-1', maxExecutionsPerDay: 2 },
      24,
    );
    assert.deepEqual(decision, { allowed: false, reason: 'agentCap', limit: 2 });
  });

  it('gives the budget back on a new local day', () => {
    const decision = evaluateCap(
      counters({ global: 24, perAgent: { 'agent-1': 24 } }),
      '2026-08-18',
      { id: 'agent-1', maxExecutionsPerDay: 2 },
      24,
    );
    assert.deepEqual(decision, { allowed: true });
  });

  it('counts runs per agent and globally', () => {
    const state = emptyState('2026-08-17');
    countRun(state, 'agent-1', '2026-08-17');
    countRun(state, 'agent-1', '2026-08-17');
    countRun(state, 'agent-2', '2026-08-17');

    assert.equal(state.counters.global, 3);
    assert.deepEqual(state.counters.perAgent, { 'agent-1': 2, 'agent-2': 1 });
  });

  it('drops yesterday numbers when counting on a new day', () => {
    const state = emptyState('2026-08-17');
    countRun(state, 'agent-1', '2026-08-17');
    countRun(state, 'agent-1', '2026-08-18');

    assert.equal(state.counters.localDate, '2026-08-18');
    assert.equal(state.counters.global, 1);
  });

  it('notifies about a reached cap once per local day', () => {
    const state = emptyState('2026-08-17');
    assert.equal(shouldNotifyCap(state.counters, '2026-08-17'), true);

    markCapNotified(state, '2026-08-17', '2026-08-17T09:00:00.000Z');
    assert.equal(shouldNotifyCap(state.counters, '2026-08-17'), false);
    assert.equal(shouldNotifyCap(state.counters, '2026-08-18'), true);
  });

  it('uses the local day of the effective time zone', () => {
    // 22:30 UTC is already the next day in Tokyo and still the same day in Berlin.
    const instant = new Date('2026-08-17T22:30:00.000Z');
    assert.equal(localDate(instant, 'Asia/Tokyo'), '2026-08-18');
    assert.equal(localDate(instant, 'Europe/Berlin'), '2026-08-18');
    assert.equal(localDate(instant, 'America/New_York'), '2026-08-17');
    assert.equal(localDate(instant, 'UTC'), '2026-08-17');
  });

  it('rolls over the stored counters when the clock crosses local midnight', async () => {
    const clock = new FixedClock(new Date('2026-08-17T22:30:00.000Z'));
    const store = new RoundsStore({
      backend: new MementoBackend(new FakeMemento()),
      clock,
      timeZone: 'America/New_York',
    });
    const service = new CountersService({
      store,
      clock,
      getGlobalLimit: () => 2,
      getTimeZone: () => 'America/New_York',
    });

    await service.count('agent-1');
    await service.count('agent-1');
    assert.deepEqual(await service.canRun({ id: 'agent-1' }), {
      allowed: false,
      reason: 'globalCap',
      limit: 2,
    });

    await service.markNotified();
    assert.equal(await service.shouldNotify(), false);

    // 22:30 UTC is 18:30 in New York during summer time, so midnight there is 5.5 hours
    // away. Six hours later the local day has changed and the budget is back.
    clock.advance(6 * 60 * 60 * 1000);
    assert.deepEqual(await service.canRun({ id: 'agent-1' }), { allowed: true });
    assert.equal(await service.shouldNotify(), true);
  });
});
