/**
 * The settings this extension contributes.
 *
 * This list is the single source of truth inside the code base; a guard test compares it
 * with the `contributes.configuration` block of `package.json`, so a key added in one
 * place and forgotten in the other fails the build.
 */
export const SETTINGS_SECTION = 'rounds';

export const SETTING_KEYS = [
  'rounds.enabled',
  'rounds.timezone',
  'rounds.jitterSeconds',
  'rounds.maxExecutionsPerDay',
  'rounds.minimumIntervalWarning',
  'rounds.manualRunNextRunPolicy',
  'rounds.defaultOutputFolder',
  'rounds.scriptWhitelist',
  'rounds.executionHistoryLimit',
  'rounds.promptFileFallback',
  'rounds.logLevel',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];
