import { randomUUID } from 'node:crypto';

import { validatePrompt } from '../../agents/placeholders.js';
import { describeCron, nextRuns, validateCron } from '../../scheduler/cron.js';
import { parseTimeOfDay } from '../../scheduler/schedule.js';
import type { Agent, PersistedState } from '../../state/types.js';

/**
 * Validation for the wizard, kept away from the quick pick calls.
 *
 * These are the parts worth testing: everything that decides whether a value is acceptable, and
 * everything that turns collected values into an agent. Driving a quick pick from a test proves
 * very little and breaks whenever a label changes.
 */

export function validateAgentName(
  name: string,
  existing: readonly Agent[],
  currentId?: string,
): string | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return 'Enter a name.';
  }
  if (trimmed.length > 80) {
    return 'Use a shorter name.';
  }
  if (existing.some((agent) => agent.id !== currentId && agent.name.trim() === trimmed)) {
    return 'An agent with that name already exists.';
  }
  return undefined;
}

export function validateMaxResults(value: string): string | undefined {
  const parsed = Number.parseInt(value.trim(), 10);
  if (Number.isNaN(parsed) || String(parsed) !== value.trim()) {
    return 'Enter a whole number.';
  }
  if (parsed < 1 || parsed > 200) {
    return 'Enter a number between 1 and 200.';
  }
  return undefined;
}

export function validateRepo(value: string): string | undefined {
  return /^[^/\s]+\/[^/\s]+$/.test(value.trim())
    ? undefined
    : 'Enter the owner and the repository, for example octo/rounds. On a self-hosted Bitbucket host that is the project key and the repository, for example ROUNDS/rounds.';
}

export function validateJql(value: string): string | undefined {
  return value.trim().length === 0 ? 'Enter a search query.' : undefined;
}

export function validatePromptText(value: string): string | undefined {
  if (value.trim().length === 0) {
    return 'Write a prompt.';
  }
  try {
    validatePrompt(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function validateScheduleInput(value: string, timeZone?: string): string | undefined {
  const outcome = describeScheduleInput(value, { timeZone });
  return outcome.kind === 'error' ? outcome.message : undefined;
}

/** How many upcoming runs a schedule preview shows. Three is enough to see a pattern. */
export const SCHEDULE_PREVIEW_COUNT = 3;

export type ScheduleFeedback =
  | { kind: 'error'; message: string }
  | { kind: 'preview'; message: string; runs: Date[] };

export interface ScheduleFeedbackOptions {
  timeZone?: string;
  now?: Date;
  /** Injected so the preview reads the way the user's editor formats dates, and so tests can pin it. */
  format?: (date: Date) => string;
}

/**
 * What to tell somebody about the schedule they are typing.
 *
 * An invalid expression already produced a message; a valid one produced nothing at all, so the
 * only confirmation that a schedule meant what it looked like came hours later when it fired. The
 * preview says it in words and then in three timestamps, which is what catches a time zone
 * somebody did not expect.
 */
export function describeScheduleInput(
  value: string,
  options: ScheduleFeedbackOptions = {},
): ScheduleFeedback {
  const expressions = splitSchedule(value);
  if (expressions.length === 0) {
    return { kind: 'error', message: 'Enter a schedule, for example 0 9 * * * for every day at 09:00.' };
  }
  for (const expression of expressions) {
    const result = validateCron(expression, options.timeZone);
    if (!result.valid) {
      return { kind: 'error', message: result.error ?? `"${expression}" is not a cron expression.` };
    }
  }

  const from = options.now ?? new Date();
  const runs = nextRuns(expressions, SCHEDULE_PREVIEW_COUNT, from, options.timeZone);
  const format = options.format ?? ((date: Date) => date.toLocaleString());
  const zone = options.timeZone ? ` (${options.timeZone})` : '';
  const upcoming = runs.length > 0 ? ` Next${zone}: ${runs.map(format).join(', ')}.` : '';
  return { kind: 'preview', message: `${describeCron(expressions)}.${upcoming}`, runs };
}

/** Several expressions may be entered at once, separated by a semicolon. */
export function splitSchedule(value: string): string[] {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function validateTimeWindow(start: string, end: string): string | undefined {
  if (start.trim().length === 0 && end.trim().length === 0) {
    return undefined;
  }
  if (parseTimeOfDay(start) === undefined || parseTimeOfDay(end) === undefined) {
    return 'Enter both ends as HH:mm, or leave both empty.';
  }
  return undefined;
}

export function validateTimeZoneInput(value: string): string | undefined {
  if (value.trim().length === 0) {
    return undefined;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() }).format(new Date());
    return undefined;
  } catch {
    return 'Enter an IANA time zone name, for example Europe/Berlin, or leave it empty.';
  }
}

/** Everything the wizard collects. */
export interface AgentDraft {
  name: string;
  executionMode: Agent['executionMode'];
  sourceKind: 'jira' | 'git';
  endpointName: string;
  jql?: string;
  maxResults?: number;
  repo?: string;
  gitMode?: 'newPullRequests' | 'updatedPullRequests';
  promptSource: 'inline' | 'file';
  promptText?: string;
  promptFile?: string;
  modelId: string;
  tools: string[];
  schedule: string[];
  timezone?: string;
  runOnStartup: boolean;
  missedRunPolicy: Agent['schedule']['missedRunPolicy'];
  allowedTimeStart?: string;
  allowedTimeEnd?: string;
  outputFolder?: string;
  maxExecutionsPerDay?: number;
}

/** Turns a draft into an agent, keeping the identity and history of an edited one. */
export function draftToAgent(draft: AgentDraft, now: Date, existing?: Agent): Agent {
  const base: Agent = {
    id: existing?.id ?? randomUUID(),
    name: draft.name.trim(),
    enabled: existing?.enabled ?? true,
    executionMode: draft.executionMode,
    schedule: {
      cronExpressions: draft.schedule,
      timezone: draft.timezone,
      runOnStartup: draft.runOnStartup,
      missedRunPolicy: draft.missedRunPolicy,
    },
    source:
      draft.sourceKind === 'jira'
        ? {
            kind: 'jira',
            baseUrlRef: draft.endpointName,
            jql: draft.jql ?? '',
            maxResults: draft.maxResults ?? 20,
          }
        : {
            kind: 'git',
            baseUrlRef: draft.endpointName,
            repo: draft.repo ?? '',
            mode: draft.gitMode ?? 'newPullRequests',
            // A source that changed kind starts over rather than inheriting a foreign cursor.
            sinceCursor:
              existing?.source.kind === 'git' && existing.source.repo === draft.repo
                ? existing.source.sinceCursor
                : undefined,
          },
    prompt:
      draft.promptSource === 'inline'
        ? { source: 'inline', inlineText: draft.promptText }
        : {
            source: 'file',
            filePath: draft.promptFile,
            // A prompt file that changed invalidates the snapshot of the previous one.
            snapshot:
              existing?.prompt.source === 'file' && existing.prompt.filePath === draft.promptFile
                ? existing.prompt.snapshot
                : undefined,
          },
    modelId: draft.modelId,
    tools: draft.tools,
    outputFolder: draft.outputFolder,
    maxExecutionsPerDay: draft.maxExecutionsPerDay,
    allowedTimeStart: draft.allowedTimeStart,
    allowedTimeEnd: draft.allowedTimeEnd,
    lastRunAt: existing?.lastRunAt,
    nextRunAt: existing?.nextRunAt,
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return base;
}

/** Fills a draft from an existing agent so the edit flow starts from what is stored. */
export function agentToDraft(agent: Agent): AgentDraft {
  return {
    name: agent.name,
    executionMode: agent.executionMode,
    sourceKind: agent.source.kind,
    endpointName: agent.source.baseUrlRef,
    jql: agent.source.kind === 'jira' ? agent.source.jql : undefined,
    maxResults: agent.source.kind === 'jira' ? agent.source.maxResults : undefined,
    repo: agent.source.kind === 'git' ? agent.source.repo : undefined,
    gitMode: agent.source.kind === 'git' ? agent.source.mode : undefined,
    promptSource: agent.prompt.source,
    promptText: agent.prompt.inlineText,
    promptFile: agent.prompt.filePath,
    modelId: agent.modelId,
    tools: [...agent.tools],
    schedule: [...agent.schedule.cronExpressions],
    timezone: agent.schedule.timezone,
    runOnStartup: agent.schedule.runOnStartup,
    missedRunPolicy: agent.schedule.missedRunPolicy,
    allowedTimeStart: agent.allowedTimeStart,
    allowedTimeEnd: agent.allowedTimeEnd,
    outputFolder: agent.outputFolder,
    maxExecutionsPerDay: agent.maxExecutionsPerDay,
  };
}

/** The copy made by Duplicate Agent. */
export function duplicateAgent(agent: Agent, existing: readonly Agent[], now: Date): Agent {
  let name = `${agent.name} (copy)`;
  let suffix = 2;
  while (existing.some((candidate) => candidate.name === name)) {
    name = `${agent.name} (copy ${suffix})`;
    suffix += 1;
  }
  return {
    ...structuredClone(agent),
    id: randomUUID(),
    name,
    // A copy starts disabled: duplicating an agent to change one field should not double the
    // traffic of the original in the meantime.
    enabled: false,
    lastRunAt: undefined,
    nextRunAt: undefined,
    source:
      agent.source.kind === 'git'
        ? { ...agent.source, sinceCursor: undefined }
        : { ...agent.source },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

/** The endpoints an agent of this kind can point at. */
export function endpointsForKind(state: PersistedState, kind: 'jira' | 'git'): string[] {
  return Object.values(state.endpoints)
    .filter((endpoint) => endpoint.kind === kind)
    .map((endpoint) => endpoint.name);
}

/** Text of the confirmation shown before an agent is deleted. */
export function deleteConfirmation(agent: Agent, runCount: number): string {
  return `Delete the agent "${agent.name}"? Its ${runCount} recorded run(s) are removed from the history. Result files already written are kept.`;
}
