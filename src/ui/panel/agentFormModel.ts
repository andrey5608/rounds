import { PLACEHOLDERS } from '../../agents/placeholders.js';
import { sourceVocabulary } from '../../agents/sourceLabels.js';
import type { AgentDraft } from '../wizard/steps.js';
import {
  validateAgentName,
  validateJql,
  validateMaxResults,
  validateProject,
  validatePromptText,
  validateRepo,
  validateScheduleInput,
  validateTimeWindow,
  validateTimeZoneInput,
} from '../wizard/steps.js';
import type { Agent, CachedModel, EndpointConfig, GitProvider } from '../../state/types.js';

/** One field's problem, addressed to the field rather than to the form. */
export type FieldErrors = Partial<Record<FormField, string>>;

export type FormField =
  | 'name'
  | 'connection'
  | 'project'
  | 'repo'
  | 'jql'
  | 'maxResults'
  | 'prompt'
  | 'promptFile'
  | 'model'
  | 'schedule'
  | 'timezone'
  | 'window'
  | 'maxExecutionsPerDay';

/** One tool as the form shows it: ours, the workspace's, or one that is enabled and gone. */
export interface FormTool {
  name: string;
  description: string;
  /** True for a tool another extension registered. */
  external?: boolean;
  tags?: readonly string[];
  /** True when the agent enabled it and nothing registers it now. */
  missing?: boolean;
}

export interface FormContext {
  /** Every agent, so a name can be checked against the ones that exist. */
  agents: readonly Agent[];
  /** The agent being edited, absent when creating. */
  editing?: Agent;
  connections: readonly EndpointConfig[];
  models: readonly CachedModel[];
  tools: readonly FormTool[];
  /** True while `runScript` would refuse everything anyway. */
  emptyScriptWhitelist: boolean;
  /** What the chosen connection speaks, for the project field's label. */
  provider: GitProvider;
}

/**
 * Every rule the form applies, in one place.
 *
 * The webview holds the draft and draws the errors; it decides nothing. Each rule here is a
 * function `steps.ts` already exported and the unit tests already call, so the form and the
 * tests cannot drift apart — which is the objection phase 14 raised against a webview form and
 * the reason the quick-pick sequence goes rather than gains a sibling.
 */
export function validateDraft(draft: AgentDraft, context: FormContext): FieldErrors {
  const errors: FieldErrors = {};

  const name = validateAgentName(draft.name ?? '', context.agents, context.editing?.id);
  if (name) {
    errors.name = name;
  }
  if (!draft.endpointName) {
    errors.connection = 'Choose the connection this agent reads from.';
  }

  if (draft.sourceKind === 'jira') {
    const jql = validateJql(draft.jql ?? '');
    if (jql) {
      errors.jql = jql;
    }
    const maxResults = validateMaxResults(String(draft.maxResults ?? ''));
    if (maxResults) {
      errors.maxResults = maxResults;
    }
  } else {
    const project = validateProject(draft.project ?? '', context.provider);
    if (project) {
      errors.project = project;
    }
    const repo = validateRepo(draft.repo ?? '');
    if (repo) {
      errors.repo = repo;
    }
  }

  if (draft.promptSource === 'inline') {
    const prompt = validatePromptText(draft.promptText ?? '');
    if (prompt) {
      errors.prompt = prompt;
    }
  } else if (!draft.promptFile) {
    errors.promptFile = 'Choose the file the prompt is read from.';
  }

  if (!draft.modelId) {
    errors.model = 'Choose a model. Run Check Setup if the list is empty.';
  }

  const schedule = validateScheduleInput((draft.schedule ?? []).join('; '), draft.timezone);
  if (schedule) {
    errors.schedule = schedule;
  }
  const timezone = validateTimeZoneInput(draft.timezone ?? '');
  if (timezone) {
    errors.timezone = timezone;
  }
  const window = validateTimeWindow(draft.allowedTimeStart ?? '', draft.allowedTimeEnd ?? '');
  if (window) {
    errors.window = window;
  }
  if (
    draft.maxExecutionsPerDay !== undefined &&
    (!Number.isInteger(draft.maxExecutionsPerDay) || draft.maxExecutionsPerDay < 1)
  ) {
    errors.maxExecutionsPerDay = 'Enter a whole number of runs, or leave it empty.';
  }

  return errors;
}

/** The draft an empty form starts from. Named defaults rather than blanks where one is obvious. */
export function emptyDraft(context: FormContext): AgentDraft {
  return {
    name: '',
    enabled: true,
    executionMode: 'api',
    sourceKind: context.connections[0]?.kind ?? 'jira',
    endpointName: context.connections[0]?.name ?? '',
    jql: '',
    maxResults: 20,
    project: '',
    repo: '',
    gitMode: 'newPullRequests',
    promptSource: 'inline',
    promptText: 'Summarize {{items}} and list what needs attention.',
    modelId: context.models[0]?.id ?? '',
    tools: [],
    schedule: ['0 9 * * *'],
    runOnStartup: false,
    missedRunPolicy: 'skip',
  };
}

/** Reads a draft off the wire, where every value arrived as a string or is missing. */
export function draftFromMessage(value: unknown): AgentDraft {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const text = (key: string): string | undefined => {
    const found = raw[key];
    return typeof found === 'string' && found.trim().length > 0 ? found.trim() : undefined;
  };
  const number = (key: string): number | undefined => {
    const found = raw[key];
    const parsed = typeof found === 'string' ? Number.parseInt(found, 10) : Number(found);
    return Number.isFinite(parsed) ? parsed : undefined;
  };

  return {
    name: text('name') ?? '',
    enabled: raw.enabled === true || raw.enabled === 'true',
    executionMode: raw.executionMode === 'chat' ? 'chat' : 'api',
    sourceKind: raw.sourceKind === 'git' ? 'git' : 'jira',
    endpointName: text('endpointName') ?? '',
    jql: text('jql'),
    maxResults: number('maxResults'),
    project: text('project'),
    repo: text('repo'),
    gitMode: raw.gitMode === 'updatedPullRequests' ? 'updatedPullRequests' : 'newPullRequests',
    promptSource: raw.promptSource === 'file' ? 'file' : 'inline',
    promptText: typeof raw.promptText === 'string' ? raw.promptText : undefined,
    promptFile: text('promptFile'),
    modelId: text('modelId') ?? '',
    tools: Array.isArray(raw.tools) ? raw.tools.filter((tool): tool is string => typeof tool === 'string') : [],
    schedule: typeof raw.schedule === 'string' ? splitSchedule(raw.schedule) : [],
    timezone: text('timezone'),
    runOnStartup: raw.runOnStartup === true || raw.runOnStartup === 'true',
    missedRunPolicy: raw.missedRunPolicy === 'runOnce' ? 'runOnce' : 'skip',
    allowedTimeStart: text('allowedTimeStart'),
    allowedTimeEnd: text('allowedTimeEnd'),
    outputFolder: text('outputFolder'),
    maxExecutionsPerDay: number('maxExecutionsPerDay'),
  };
}

function splitSchedule(value: string): string[] {
  return value
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * What a message from the form does to the document.
 *
 * `patch` exists because of a bug worth remembering: every keystroke used to rebuild the whole
 * document, which replaces the element being typed into, so the field lost focus after one
 * character. Only a change that alters *which fields exist* may repaint; everything else sends
 * the errors back to be applied in place.
 */
export function panelUpdateKind(type: string | undefined): 'patch' | 'repaint' | 'action' | 'unknown' {
  switch (type) {
    case 'change':
    case 'touched':
      return 'patch';
    case 'reshape':
    case 'pickPromptFile':
      return 'repaint';
    case 'save':
    case 'run':
    case 'openFolder':
    case 'delete':
    case 'open':
      return 'action';
    default:
      return 'unknown';
  }
}

/** What the form needs back after a keystroke: the errors, the preview, and whether Save may fire. */
export interface FormState {
  errors: FieldErrors;
  schedulePreview?: string;
  canSave: boolean;
}

/** The label the project field carries, which is the host's own word for it. */
export function projectLabel(provider: GitProvider): string {
  return sourceVocabulary(provider).project;
}

/** Placeholder names, so the form can list what a prompt may refer to. */
export const PROMPT_PLACEHOLDERS = PLACEHOLDERS;
