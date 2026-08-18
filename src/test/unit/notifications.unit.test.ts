import * as assert from 'node:assert/strict';

import { FixedClock } from '../../state/time.js';
import { Notifier } from '../../ui/notifications.js';
import type { MessageLevel, NotificationMode, NotifiedAgent } from '../../ui/notifications.js';

interface Shown {
  level: MessageLevel;
  message: string;
  actions: string[];
}

function harness(options: { mode?: NotificationMode; choose?: string } = {}): {
  notifier: Notifier;
  shown: Shown[];
  logged: string[];
  invoked: string[];
  clock: FixedClock;
  setMode: (mode: NotificationMode) => void;
} {
  const shown: Shown[] = [];
  const logged: string[] = [];
  const invoked: string[] = [];
  const clock = new FixedClock(new Date('2026-08-18T09:00:00.000Z'));
  let mode: NotificationMode = options.mode ?? 'failures';

  const notifier = new Notifier({
    host: {
      show: (level, message, actions) => {
        shown.push({ level, message, actions });
        return Promise.resolve(options.choose);
      },
    },
    commands: {
      showOutput: () => invoked.push('showOutput'),
      showHistory: (agent) => invoked.push(`showHistory:${agent.id}`),
      editAgent: (agent) => invoked.push(`editAgent:${agent.id}`),
      openSetting: (key) => invoked.push(`openSetting:${key}`),
      checkSetup: () => invoked.push('checkSetup'),
    },
    logger: {
      debug: (message) => logged.push(message),
      info: (message) => logged.push(message),
      warn: (message) => logged.push(message),
      error: (message) => logged.push(message),
    },
    mode: () => mode,
    timeZone: () => 'UTC',
    clock,
  });

  return { notifier, shown, logged, invoked, clock, setMode: (next) => (mode = next) };
}

const triage: NotifiedAgent = { id: 'agent-1', name: 'Morning triage' };
const release: NotifiedAgent = { id: 'agent-2', name: 'Release watch' };

describe('notification policy', () => {
  it('reports a failed run once per agent per local day', () => {
    const { notifier, shown, clock } = harness();

    notifier.runFailed(triage, 'the model returned no text');
    notifier.runFailed(triage, 'the model returned no text');
    assert.equal(shown.length, 1);
    assert.equal(shown[0]?.level, 'error');
    assert.match(shown[0]?.message ?? '', /Morning triage: the model returned no text/);

    // A different agent is a different subject, and tomorrow is a different day.
    notifier.runFailed(release, 'the host refused the token');
    assert.equal(shown.length, 2);

    clock.set(new Date('2026-08-19T09:00:00.000Z'));
    notifier.runFailed(triage, 'the model returned no text');
    assert.equal(shown.length, 3);
  });

  it('offers the actions that lead somewhere, and runs the chosen one', async () => {
    const { notifier, shown, invoked } = harness({ choose: 'Show Run History' });

    notifier.runFailed(triage, 'failed');
    assert.deepEqual(shown[0]?.actions, ['Show Output', 'Show Run History']);

    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(invoked, ['showHistory:agent-1']);
  });

  it('says nothing about a successful run unless it was asked to', () => {
    const { notifier, shown, setMode } = harness();

    notifier.runSucceeded(triage, '3 items summarized');
    assert.equal(shown.length, 0, 'automation stays quiet by default');

    setMode('all');
    notifier.runSucceeded(triage, '3 items summarized');
    assert.equal(shown.length, 1);
    assert.equal(shown[0]?.level, 'info');
  });

  it('turns several frequent agents into one warning', () => {
    // The reported behaviour: this is evaluated for every agent when a window takes over, so four
    // fast agents produced four separate warnings saying the same thing.
    const { notifier, shown } = harness();

    notifier.frequencyWarning([
      { agent: triage, intervalMinutes: 5 },
      { agent: release, intervalMinutes: 10 },
    ]);

    assert.equal(shown.length, 1);
    assert.match(shown[0]?.message ?? '', /2 agents/);
    assert.match(shown[0]?.message ?? '', /Morning triage, Release watch/);
    assert.match(shown[0]?.message ?? '', /rate limited/);
  });

  it('names the agent and offers to edit it when only one is frequent', () => {
    const { notifier, shown } = harness();
    notifier.frequencyWarning([{ agent: triage, intervalMinutes: 5 }]);

    assert.match(shown[0]?.message ?? '', /"Morning triage" runs every 5 minute/);
    assert.deepEqual(shown[0]?.actions, ['Edit Agent']);
  });

  it('repeats the frequency warning only when the set of agents changes', () => {
    const { notifier, shown } = harness();
    const both = [
      { agent: triage, intervalMinutes: 5 },
      { agent: release, intervalMinutes: 10 },
    ];

    notifier.frequencyWarning(both);
    notifier.frequencyWarning([...both].reverse());
    assert.equal(shown.length, 1, 'the same agents in another order are the same warning');

    notifier.frequencyWarning([{ agent: triage, intervalMinutes: 5 }]);
    assert.equal(shown.length, 2);
  });

  it('warns about the daily cap without deduplicating: the caller already did', () => {
    const { notifier, shown } = harness();
    notifier.capReached('Rounds reached its daily run limit.');
    notifier.capReached('Rounds reached its daily run limit.');

    assert.equal(shown.length, 2);
    assert.deepEqual(shown[0]?.actions, ['Open Settings']);
  });

  it('mentions missing model access once per window', () => {
    const { notifier, shown } = harness();
    notifier.consentMissing('No language model is available.');
    notifier.consentMissing('No language model is available.');

    assert.equal(shown.length, 1);
    assert.deepEqual(shown[0]?.actions, ['Check Setup']);
  });

  it('forgets window-scoped keys when leadership changes hands', () => {
    const { notifier, shown } = harness();
    notifier.consentMissing('No language model is available.');
    notifier.resetWindowScope();
    notifier.consentMissing('No language model is available.');

    assert.equal(shown.length, 2);
  });

  it('reports an unreadable prompt once per agent per day', () => {
    const { notifier, shown, clock } = harness();
    notifier.promptUnreadable(triage, 'the prompt file could not be read');
    notifier.promptUnreadable(triage, 'the prompt file could not be read');
    assert.equal(shown.length, 1);

    clock.set(new Date('2026-08-19T09:00:00.000Z'));
    notifier.promptUnreadable(triage, 'the prompt file could not be read');
    assert.equal(shown.length, 2);
  });

  it('silences the toast without silencing the information', () => {
    const { notifier, shown, logged } = harness({ mode: 'silent' });

    notifier.runFailed(triage, 'the host refused the token');
    assert.equal(shown.length, 0);
    assert.equal(logged.length, 1);
    assert.match(logged[0] ?? '', /suppressed \(rounds\.notifications=silent\)/);
    assert.match(logged[0] ?? '', /the host refused the token/);
  });

  it('still shows what the user asked for while silent', async () => {
    const { notifier, shown } = harness({ mode: 'silent' });

    await notifier.requested('info', 'Morning triage: 3 items summarized');
    assert.equal(shown.length, 1, 'somebody who pressed Run Now is waiting for the answer');
  });
});
