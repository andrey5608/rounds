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
  'rounds.notifications',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

/** The slice of the editor's configuration this layer needs. Keeps the reader testable. */
export interface ConfigurationLike {
  get<T>(section: string): T | undefined;
}

export type ManualRunNextRunPolicy = 'advance' | 'fromNow';

/**
 * How much the extension is allowed to interrupt.
 *
 * `failures` is the default and matches what an unattended tool should do: say nothing while
 * things work. `all` exists for the first week after an agent is set up, when the question is
 * whether it ran at all. `silent` stops the toasts and nothing else — the log, the status bar
 * and the run record are unchanged, because turning notifications down must not turn
 * information off. It lives here rather than next to the policy because `state` is the layer
 * `ui` reads, never the other way round.
 */
export type NotificationMode = 'failures' | 'all' | 'silent';

export interface ScriptWhitelistEntry {
  command: string;
  args?: string[];
}

export interface RoundsSettings {
  enabled: boolean;
  /** Empty string in the settings means "use the system time zone", modelled as undefined. */
  timezone: string | undefined;
  jitterSeconds: number;
  maxExecutionsPerDay: number;
  minimumIntervalWarning: number;
  manualRunNextRunPolicy: ManualRunNextRunPolicy;
  defaultOutputFolder: string | undefined;
  scriptWhitelist: ScriptWhitelistEntry[];
  executionHistoryLimit: number;
  promptFileFallback: 'snapshot' | 'blockWhenResolvable' | 'blockAlways';
  logLevel: 'none' | 'error' | 'info' | 'debug';
  /** How much the extension may interrupt. See `src/ui/notifications.ts` for what each value means. */
  notifications: NotificationMode;
}

export const SETTING_DEFAULTS: RoundsSettings = {
  enabled: true,
  timezone: undefined,
  jitterSeconds: 600,
  maxExecutionsPerDay: 24,
  minimumIntervalWarning: 30,
  manualRunNextRunPolicy: 'advance',
  defaultOutputFolder: undefined,
  scriptWhitelist: [],
  executionHistoryLimit: 50,
  promptFileFallback: 'snapshot',
  logLevel: 'info',
  notifications: 'failures',
};

function clampNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * Reads the settings into a plain object.
 *
 * Values are validated here rather than at every use: a user can put anything into
 * `settings.json`, and a nonsensical value must degrade to the documented default instead
 * of producing a schedule that never fires or a cap that lets everything through.
 */
export function readSettings(configuration: ConfigurationLike): RoundsSettings {
  const whitelist = configuration.get<unknown>('rounds.scriptWhitelist');
  return {
    enabled: configuration.get<boolean>('rounds.enabled') ?? SETTING_DEFAULTS.enabled,
    timezone: readOptionalString(configuration.get('rounds.timezone')),
    jitterSeconds: clampNumber(
      configuration.get('rounds.jitterSeconds'),
      SETTING_DEFAULTS.jitterSeconds,
      0,
      1800,
    ),
    maxExecutionsPerDay: clampNumber(
      configuration.get('rounds.maxExecutionsPerDay'),
      SETTING_DEFAULTS.maxExecutionsPerDay,
      1,
      1000,
    ),
    minimumIntervalWarning: clampNumber(
      configuration.get('rounds.minimumIntervalWarning'),
      SETTING_DEFAULTS.minimumIntervalWarning,
      0,
      1440,
    ),
    manualRunNextRunPolicy: readEnum(
      configuration.get('rounds.manualRunNextRunPolicy'),
      ['advance', 'fromNow'] as const,
      SETTING_DEFAULTS.manualRunNextRunPolicy,
    ),
    defaultOutputFolder: readOptionalString(configuration.get('rounds.defaultOutputFolder')),
    scriptWhitelist: Array.isArray(whitelist)
      ? whitelist.filter(
          (entry): entry is ScriptWhitelistEntry =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as ScriptWhitelistEntry).command === 'string',
        )
      : SETTING_DEFAULTS.scriptWhitelist,
    executionHistoryLimit: clampNumber(
      configuration.get('rounds.executionHistoryLimit'),
      SETTING_DEFAULTS.executionHistoryLimit,
      1,
      1000,
    ),
    promptFileFallback: readEnum(
      configuration.get('rounds.promptFileFallback'),
      ['snapshot', 'blockWhenResolvable', 'blockAlways'] as const,
      SETTING_DEFAULTS.promptFileFallback,
    ),
    logLevel: readEnum(
      configuration.get('rounds.logLevel'),
      ['none', 'error', 'info', 'debug'] as const,
      SETTING_DEFAULTS.logLevel,
    ),
    notifications: readEnum(
      configuration.get('rounds.notifications'),
      ['failures', 'all', 'silent'] as const,
      SETTING_DEFAULTS.notifications,
    ),
  };
}
