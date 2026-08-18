import type { StoreLogger } from '../state/store.js';
import { localDate, systemClock } from '../state/time.js';
import type { Clock } from '../state/time.js';

/**
 * How much the extension is allowed to interrupt.
 *
 * `failures` is the default and matches what an unattended tool should do: say nothing while
 * things work. `all` exists for the first week after an agent is set up, when the question is
 * whether it ran at all. `silent` stops the toasts and nothing else — the log, the status bar
 * and the run record are unchanged, because turning notifications down must not turn
 * information off.
 */
export type NotificationMode = 'failures' | 'all' | 'silent';

export type MessageLevel = 'info' | 'warning' | 'error';

/**
 * The slice of the editor's message API this policy needs.
 *
 * A port rather than a direct call, so the decisions below are unit-testable without the
 * extension host — the same reason the tools take a `FileFinder`.
 */
export interface MessageHost {
  show(level: MessageLevel, message: string, actions: string[]): Promise<string | undefined>;
}

/** The agent fields a notification needs. Enough for the message and for the action. */
export interface NotifiedAgent {
  id: string;
  name: string;
}

/** What an action does when it is chosen. Injected so this file never imports `vscode`. */
export interface NotifierCommands {
  showOutput(): void;
  showHistory(agent: NotifiedAgent): void;
  editAgent(agent: NotifiedAgent): void;
  openSetting(key: string): void;
  checkSetup(): void;
}

export interface NotifierOptions {
  host: MessageHost;
  commands: NotifierCommands;
  logger: StoreLogger;
  /** Current value of `rounds.notifications`, read per call so a change applies at once. */
  mode: () => NotificationMode;
  /** Time zone the daily dedup keys are computed in; the same one the counters use. */
  timeZone?: () => string | undefined;
  clock?: Clock;
}

/** One notified thing, named so the dedup rules can be read in one place. */
type Topic =
  | 'runFailed'
  | 'runSucceeded'
  | 'capReached'
  | 'frequency'
  | 'consentMissing'
  | 'promptUnreadable';

/**
 * The one place that decides whether to interrupt.
 *
 * Before this existed the policy lived in three lambdas in `activate()`: failures deduplicated
 * through a map held in that closure, the cap through a stored timestamp, and the frequency
 * warning not at all — so four fast agents produced four warnings every time a window opened.
 * Collecting the rules here makes them reviewable and lets `rounds.notifications` mean one thing
 * rather than three.
 */
export class Notifier {
  private readonly seen = new Map<string, string>();
  private readonly clock: Clock;

  constructor(private readonly options: NotifierOptions) {
    this.clock = options.clock ?? systemClock;
  }

  /** A scheduled run failed. Once per agent per local day. */
  runFailed(agent: NotifiedAgent, summary: string): void {
    if (!this.claim('runFailed', agent.id, this.today())) {
      return;
    }
    this.raise('error', `${agent.name}: ${summary}`, [
      { title: 'Show Output', run: () => this.options.commands.showOutput() },
      { title: 'Show Run History', run: () => this.options.commands.showHistory(agent) },
    ]);
  }

  /** A scheduled run succeeded. Only ever shown in `all`, and never deduplicated: that is the point. */
  runSucceeded(agent: NotifiedAgent, summary: string): void {
    if (this.options.mode() !== 'all') {
      return;
    }
    this.raise('info', `${agent.name}: ${summary}`, [
      { title: 'Show Run History', run: () => this.options.commands.showHistory(agent) },
    ]);
  }

  /**
   * The daily limit stopped a run.
   *
   * Deduplicated by the caller through `counters.capNotifiedAt`, because "once per day" has to
   * survive a reload and in-memory state does not.
   */
  capReached(message: string): void {
    this.raise('warning', message, [
      {
        title: 'Open Settings',
        run: () => this.options.commands.openSetting('rounds.maxExecutionsPerDay'),
      },
    ]);
  }

  /**
   * Agents whose schedule fires more often than the warning threshold.
   *
   * One message for all of them: this is evaluated for every agent when a window takes over, and
   * four agents used to mean four separate warnings saying the same thing.
   */
  frequencyWarning(entries: readonly FrequencyWarning[]): void {
    if (entries.length === 0) {
      return;
    }
    const key = [...entries].map((entry) => entry.agent.id).sort().join(',');
    if (!this.claim('frequency', key, 'window')) {
      return;
    }
    const [first] = entries;
    const subject =
      entries.length === 1 && first
        ? `The agent "${first.agent.name}" runs every ${first.intervalMinutes} minute(s).`
        : `${entries.length} agents run more often than every ${Math.max(
            ...entries.map((entry) => entry.intervalMinutes),
          )} minutes: ${entries.map((entry) => entry.agent.name).join(', ')}.`;

    const actions =
      entries.length === 1 && first
        ? [{ title: 'Edit Agent', run: () => this.options.commands.editAgent(first.agent) }]
        : [];
    this.raise(
      'warning',
      `${subject} Frequent automated requests can get your model provider account rate limited.`,
      actions,
    );
  }

  /** The model provider has not been granted access yet, found at run time. Once per window. */
  consentMissing(message: string): void {
    if (!this.claim('consentMissing', 'global', 'window')) {
      return;
    }
    this.raise('warning', message, [
      { title: 'Check Setup', run: () => this.options.commands.checkSetup() },
    ]);
  }

  /** An agent's prompt file could not be read. Once per agent per local day. */
  promptUnreadable(agent: NotifiedAgent, reason: string): void {
    if (!this.claim('promptUnreadable', agent.id, this.today())) {
      return;
    }
    this.raise('warning', `${agent.name}: ${reason}`, [
      { title: 'Edit Agent', run: () => this.options.commands.editAgent(agent) },
    ]);
  }

  /**
   * Shows a message the user asked for, whatever the mode says.
   *
   * Manual runs go through here: somebody who pressed Run Now is waiting for the answer, and
   * swallowing it because notifications are turned down would be a bug rather than a preference.
   */
  requested(level: MessageLevel, message: string, actions: NotificationAction[] = []): Promise<void> {
    return this.present(level, message, actions);
  }

  /** Forgets the window-scoped dedup keys. Used when leadership changes hands. */
  resetWindowScope(): void {
    for (const [key, token] of this.seen) {
      if (token === 'window') {
        this.seen.delete(key);
      }
    }
  }

  private raise(level: MessageLevel, message: string, actions: NotificationAction[]): void {
    if (this.options.mode() === 'silent') {
      // The information is not lost: the run record and the status bar are unchanged, and this
      // line makes the suppression itself visible when somebody wonders why it was quiet.
      this.options.logger.info(`Notification suppressed (rounds.notifications=silent): ${message}`);
      return;
    }
    void this.present(level, message, actions);
  }

  private async present(
    level: MessageLevel,
    message: string,
    actions: NotificationAction[],
  ): Promise<void> {
    const chosen = await this.options.host.show(
      level,
      message,
      actions.map((action) => action.title),
    );
    if (chosen === undefined) {
      return;
    }
    await actions.find((action) => action.title === chosen)?.run();
  }

  /** Returns true when this is the first time `topic` fires for `subject` within `token`. */
  private claim(topic: Topic, subject: string, token: string): boolean {
    const key = `${topic}:${subject}`;
    if (this.seen.get(key) === token) {
      return false;
    }
    this.seen.set(key, token);
    return true;
  }

  private today(): string {
    return localDate(this.clock.now(), this.options.timeZone?.());
  }
}

export interface NotificationAction {
  title: string;
  run: () => void | Promise<void>;
}

/** One agent whose schedule fires more often than the warning threshold. */
export interface FrequencyWarning {
  agent: NotifiedAgent;
  intervalMinutes: number;
}
