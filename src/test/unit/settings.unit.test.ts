import * as assert from 'node:assert/strict';

import { SETTING_DEFAULTS, readSettings } from '../../state/settings.js';
import type { ConfigurationLike } from '../../state/settings.js';

class FakeConfiguration implements ConfigurationLike {
  constructor(private readonly values: Record<string, unknown>) {}

  get<T>(section: string): T | undefined {
    return this.values[section] as T | undefined;
  }
}

describe('settings reader', () => {
  it('falls back to the documented defaults when nothing is configured', () => {
    assert.deepEqual(readSettings(new FakeConfiguration({})), SETTING_DEFAULTS);
  });

  it('reads configured values', () => {
    const settings = readSettings(
      new FakeConfiguration({
        'rounds.enabled': false,
        'rounds.timezone': 'Europe/Berlin',
        'rounds.jitterSeconds': 120,
        'rounds.maxExecutionsPerDay': 5,
        'rounds.manualRunNextRunPolicy': 'fromNow',
        'rounds.logLevel': 'debug',
      }),
    );

    assert.equal(settings.enabled, false);
    assert.equal(settings.timezone, 'Europe/Berlin');
    assert.equal(settings.jitterSeconds, 120);
    assert.equal(settings.maxExecutionsPerDay, 5);
    assert.equal(settings.manualRunNextRunPolicy, 'fromNow');
    assert.equal(settings.logLevel, 'debug');
  });

  it('treats an empty time zone and output folder as unset', () => {
    const settings = readSettings(
      new FakeConfiguration({ 'rounds.timezone': '   ', 'rounds.defaultOutputFolder': '' }),
    );
    assert.equal(settings.timezone, undefined);
    assert.equal(settings.defaultOutputFolder, undefined);
  });

  it('clamps numbers that are out of range instead of trusting them', () => {
    const settings = readSettings(
      new FakeConfiguration({
        'rounds.jitterSeconds': 99999,
        'rounds.maxExecutionsPerDay': 0,
        'rounds.executionHistoryLimit': -3,
      }),
    );
    assert.equal(settings.jitterSeconds, 1800);
    assert.equal(settings.maxExecutionsPerDay, 1);
    assert.equal(settings.executionHistoryLimit, 1);
  });

  it('ignores values of the wrong type', () => {
    const settings = readSettings(
      new FakeConfiguration({
        'rounds.jitterSeconds': 'ten minutes',
        'rounds.promptFileFallback': 'whatever',
        'rounds.logLevel': 42,
      }),
    );
    assert.equal(settings.jitterSeconds, SETTING_DEFAULTS.jitterSeconds);
    assert.equal(settings.promptFileFallback, SETTING_DEFAULTS.promptFileFallback);
    assert.equal(settings.logLevel, SETTING_DEFAULTS.logLevel);
  });

  it('keeps only well formed whitelist entries', () => {
    const settings = readSettings(
      new FakeConfiguration({
        'rounds.scriptWhitelist': [
          { command: 'npm', args: ['test'] },
          { args: ['no command here'] },
          'npm test',
          null,
        ],
      }),
    );
    assert.deepEqual(settings.scriptWhitelist, [{ command: 'npm', args: ['test'] }]);
  });
});
