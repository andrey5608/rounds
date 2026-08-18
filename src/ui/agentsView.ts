import * as vscode from 'vscode';

import { describeCron, minIntervalMinutes, nextRuns } from '../scheduler/cron.js';
import { effectiveTimeZone } from '../scheduler/schedule.js';
import { evaluateReadiness } from '../setup/needsSetup.js';
import type { SecretName } from '../state/secrets.js';
import type { Agent, PersistedState, RunRecord, RunStatus } from '../state/types.js';

import { runDocumentUri } from './runDetails.js';

/** Identifier of the contributed tree view. Must match `package.json`. */
export const AGENTS_VIEW_ID = 'rounds.agentsView';

/** Context key that hides the welcome view once at least one agent exists. */
export const HAS_AGENTS_CONTEXT_KEY = 'rounds.hasAgents';

/** How many runs are listed under an agent. */
const RECENT_RUNS = 10;

export type TreeNode =
  | { kind: 'agent'; agent: Agent }
  | { kind: 'run'; agent: Agent; run: RunRecord }
  | { kind: 'message'; agent: Agent; text: string };

export interface AgentsViewData {
  state: PersistedState;
  storedSecrets: SecretName[];
  settingsTimeZone?: string;
  minimumIntervalWarning: number;
  /** Whether the user trusts this workspace. Only a definite `false` blocks anything. */
  workspaceTrusted?: boolean;
  /** Agents currently running in this window, so the tree can show it. */
  running: Set<string>;
}

const STATUS_ICON: Record<RunStatus, string> = {
  running: 'sync~spin',
  succeeded: 'pass',
  failed: 'error',
  skipped: 'debug-step-over',
  handedOff: 'comment-discussion',
  interrupted: 'warning',
};

/** Relative time in words, which is what a "next run" line wants. */
export function describeRelative(target: Date, now: Date): string {
  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  if (minutes < -1) {
    return 'overdue';
  }
  if (minutes <= 1) {
    return 'in a moment';
  }
  if (minutes < 60) {
    return `in ${minutes} min`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return `in ${hours} h`;
  }
  return `in ${Math.round(hours / 24)} d`;
}

/**
 * How long a run took, in the units somebody reads at a glance.
 *
 * A run without a finish time is one that never reported back — the window went away mid-run —
 * and saying "0 s" about it would be a lie the tree tells every time it repaints.
 */
export function describeDuration(run: RunRecord): string | undefined {
  if (!run.finishedAt) {
    return undefined;
  }
  const milliseconds = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return undefined;
  }
  if (milliseconds < 1000) {
    return `${milliseconds} ms`;
  }
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(1)} s`;
  }
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return `${minutes} min ${seconds} s`;
}

/**
 * The description line of a run: what it cost, then what came of it.
 *
 * The summary alone answered "what happened" and not "what did it do", which is the question a
 * row of identical-looking runs actually raises. A failed run leads with its code, because that
 * is the part somebody searches the log for.
 */
export function describeRun(run: RunRecord): string {
  const facts: string[] = [];
  if (run.sourceItemCount > 0) {
    facts.push(`${run.sourceItemCount} item${run.sourceItemCount === 1 ? '' : 's'}`);
  }
  const duration = describeDuration(run);
  if (duration) {
    facts.push(duration);
  }
  const prefix = facts.length > 0 ? `${facts.join(' · ')} — ` : '';
  return run.error ? `${prefix}${run.error.code}: ${run.summary}` : `${prefix}${run.summary}`;
}

/**
 * The description line of an agent: what it does and when it happens next.
 *
 * Deliberately dense — a tree row has one line, and "every day at 09:00 · next in 3 h" answers
 * both questions a user has about an agent they are looking at.
 */
export function describeAgent(agent: Agent, data: AgentsViewData, now: Date): string {
  const schedule = describeCron(agent.schedule.cronExpressions);
  if (!agent.enabled) {
    return `${schedule} · disabled`;
  }
  if (data.running.has(agent.id)) {
    return `${schedule} · running now`;
  }
  if (!agent.nextRunAt) {
    return schedule;
  }
  return `${schedule} · next ${describeRelative(new Date(agent.nextRunAt), now)}`;
}

interface AgentPresentation {
  icon: vscode.ThemeIcon;
  contextValue: string;
  tooltip: vscode.MarkdownString;
}

/**
 * Chooses the icon, the context value and the tooltip for one agent.
 *
 * The context value is what the menu `when` clauses key on, so it encodes the state the menus care
 * about: enabled, disabled or needing setup.
 */
export function presentAgent(
  agent: Agent,
  data: AgentsViewData,
  now: Date,
): AgentPresentation {
  const readiness = evaluateReadiness({
    agent,
    hasConsent: data.state.setup.consentGrantedAt !== undefined,
    models: data.state.setup.models ?? [],
    endpoints: data.state.endpoints,
    storedSecrets: data.storedSecrets,
    workspaceTrusted: data.workspaceTrusted,
  });
  const lastRun = data.state.history[agent.id]?.[0];
  const interval = minIntervalMinutes(
    agent.schedule.cronExpressions,
    now,
    effectiveTimeZone(agent, data.settingsTimeZone),
  );
  const tooFrequent = interval !== undefined && interval < data.minimumIntervalWarning;

  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${agent.name}**\n\n`);
  tooltip.appendMarkdown(`- Schedule: ${describeCron(agent.schedule.cronExpressions)}\n`);
  tooltip.appendMarkdown(
    `- Source: ${agent.source.kind === 'jira' ? `query \`${agent.source.jql}\`` : `${agent.source.repo} (${agent.source.mode === 'newPullRequests' ? 'new' : 'updated'} pull requests)`}\n`,
  );
  tooltip.appendMarkdown(`- Mode: ${agent.executionMode === 'api' ? 'result captured' : 'handed to chat'}\n`);
  tooltip.appendMarkdown(`- Model: ${agent.modelId}\n`);
  if (agent.allowedTimeStart && agent.allowedTimeEnd) {
    tooltip.appendMarkdown(`- Only between ${agent.allowedTimeStart} and ${agent.allowedTimeEnd}\n`);
  }
  if (agent.maxExecutionsPerDay !== undefined) {
    tooltip.appendMarkdown(`- At most ${agent.maxExecutionsPerDay} run(s) per day\n`);
  }
  tooltip.appendMarkdown(`- Last run: ${lastRun ? `${lastRun.status} — ${lastRun.summary}` : 'never'}\n`);
  if (agent.enabled) {
    // Three, not one: the rate is already in the schedule sentence above, and what a person
    // cannot check from that sentence is whether the time zone is the one they had in mind.
    const upcoming = nextRuns(
      agent.schedule.cronExpressions,
      3,
      now,
      effectiveTimeZone(agent, data.settingsTimeZone),
    );
    if (upcoming.length > 0) {
      tooltip.appendMarkdown(
        `- Next runs: ${upcoming.map((run) => run.toLocaleString()).join(', ')}\n`,
      );
    }
  }
  if (!readiness.ready) {
    tooltip.appendMarkdown(`\n$(warning) ${readiness.reason ?? ''}\n`);
  }
  if (tooFrequent) {
    tooltip.appendMarkdown(
      `\n$(warning) This agent runs every ${interval ?? 0} minute(s). Frequent automated requests can get a model provider account rate limited.\n`,
    );
  }
  tooltip.supportThemeIcons = true;

  if (data.running.has(agent.id)) {
    return { icon: new vscode.ThemeIcon('sync~spin'), contextValue: 'rounds.agent.enabled', tooltip };
  }
  if (!readiness.ready) {
    return { icon: new vscode.ThemeIcon('warning'), contextValue: 'rounds.agent.needsSetup', tooltip };
  }
  if (!agent.enabled) {
    return { icon: new vscode.ThemeIcon('circle-slash'), contextValue: 'rounds.agent.disabled', tooltip };
  }
  if (tooFrequent) {
    return { icon: new vscode.ThemeIcon('warning'), contextValue: 'rounds.agent.enabled', tooltip };
  }
  if (lastRun?.status === 'failed') {
    return { icon: new vscode.ThemeIcon('error'), contextValue: 'rounds.agent.enabled', tooltip };
  }
  return { icon: new vscode.ThemeIcon('play-circle'), contextValue: 'rounds.agent.enabled', tooltip };
}

/**
 * The agents view.
 *
 * Reads everything it shows from a snapshot supplied by the caller, so nothing here touches the
 * store or the secrets directly and the presentation logic stays testable.
 */
export class AgentsTreeDataProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  private data: AgentsViewData | undefined;
  private now: () => Date = () => new Date();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  /** Replaces the snapshot the tree renders from. */
  setData(data: AgentsViewData): void {
    this.data = data;
    this.changeEmitter.fire(undefined);
  }

  setClock(now: () => Date): void {
    this.now = now;
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'message') {
      const item = new vscode.TreeItem(element.text, vscode.TreeItemCollapsibleState.None);
      item.contextValue = 'rounds.message';
      return item;
    }
    if (element.kind === 'agent') {
      const data = this.data;
      const item = new vscode.TreeItem(element.agent.name, vscode.TreeItemCollapsibleState.Collapsed);
      if (data) {
        const presentation = presentAgent(element.agent, data, this.now());
        item.description = describeAgent(element.agent, data, this.now());
        item.iconPath = presentation.icon;
        item.contextValue = presentation.contextValue;
        item.tooltip = presentation.tooltip;
      }
      item.id = `agent:${element.agent.id}`;
      return item;
    }

    const { run } = element;
    const item = new vscode.TreeItem(
      new Date(run.startedAt).toLocaleString(),
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = `run:${run.id}`;
    item.description = describeRun(run);
    item.iconPath = new vscode.ThemeIcon(STATUS_ICON[run.status]);
    item.contextValue = 'rounds.run';
    item.tooltip = runTooltip(run);
    // The editor's own open command, deliberately: the v1 command list has no id for opening a
    // result, and inventing one would break the rule that identifiers come from the specification.
    item.command = {
      command: 'vscode.open',
      title: 'Open',
      arguments: [runDocumentUri(run)],
    };
    return item;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    const data = this.data;
    if (!data) {
      return [];
    }
    if (!element) {
      return [...data.state.agents]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((agent): TreeNode => ({ kind: 'agent', agent }));
    }
    if (element.kind !== 'agent') {
      return [];
    }
    const runs = data.state.history[element.agent.id] ?? [];
    if (runs.length === 0) {
      return [{ kind: 'message', agent: element.agent, text: 'No runs yet' }];
    }
    return runs
      .slice(0, RECENT_RUNS)
      .map((run): TreeNode => ({ kind: 'run', agent: element.agent, run }));
  }

  /** Asks the view to re-read everything. */
  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

/** Tooltip of one run, which is also where the chat-mode limitation is stated. */
function runTooltip(run: RunRecord): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString();
  tooltip.appendMarkdown(`**${run.status}** — ${run.summary}\n\n`);
  tooltip.appendMarkdown(`- Started: ${new Date(run.startedAt).toLocaleString()}\n`);
  if (run.finishedAt) {
    tooltip.appendMarkdown(`- Finished: ${new Date(run.finishedAt).toLocaleString()}\n`);
  }
  tooltip.appendMarkdown(`- Trigger: ${run.trigger}\n`);
  tooltip.appendMarkdown(`- Model: ${run.modelId}\n`);
  if (run.toolCalls.length > 0) {
    tooltip.appendMarkdown(`- Tool calls: ${run.toolCalls.map((call) => call.name).join(', ')}\n`);
  }
  if (run.jitterSeconds) {
    tooltip.appendMarkdown(`- Delayed by ${run.jitterSeconds}s before starting\n`);
  }
  if (run.status === 'handedOff') {
    tooltip.appendMarkdown(
      '\nThe prompt was opened in the chat view, so Rounds did not capture the answer.\n',
    );
  }
  if (run.error) {
    tooltip.appendMarkdown(`\n\`${run.error.code}\`: ${run.error.message}\n`);
  }
  return tooltip;
}

/** Registers the agents view. */
export function registerAgentsView(context: vscode.ExtensionContext): AgentsTreeDataProvider {
  const provider = new AgentsTreeDataProvider();
  context.subscriptions.push(
    provider,
    vscode.window.registerTreeDataProvider(AGENTS_VIEW_ID, provider),
  );
  void vscode.commands.executeCommand('setContext', HAS_AGENTS_CONTEXT_KEY, false);
  return provider;
}
