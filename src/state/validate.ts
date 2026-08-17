import type {
  Agent,
  AgentSchedule,
  AgentSource,
  DailyCounters,
  PersistedState,
  PromptConfig,
  CachedModel,
  CheckOutcome,
  RunClaim,
  RunHistory,
  RunRecord,
} from './types.js';

/** Bumped whenever the persisted shape changes in a way that needs a migration. */
export const CURRENT_SCHEMA_VERSION = 1;

/** An entry that could not be understood, kept aside instead of being dropped silently. */
export interface QuarantineEntry {
  kind: 'envelope' | 'agent' | 'run' | 'counters' | 'claim';
  reason: string;
  value: unknown;
}

export interface ValidationOutcome {
  state: PersistedState;
  quarantine: QuarantineEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isNonEmptyString(value: unknown): value is string {
  return isString(value) && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return isString(value) && (allowed as readonly string[]).includes(value);
}

/** An empty state, used on first run and when nothing readable could be recovered. */
export function emptyState(localDate: string): PersistedState {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: 0,
    agents: [],
    history: {},
    counters: { localDate, global: 0, perAgent: {} },
    runClaims: {},
    setup: {},
  };
}

/**
 * Reads the setup slice.
 *
 * Nothing here is critical: a missing or malformed value only means the user is asked to
 * run the setup command again, so unreadable parts are dropped rather than quarantined.
 */
function validateSetup(value: unknown): PersistedState['setup'] {
  if (!isRecord(value)) {
    return {};
  }
  const setup: PersistedState['setup'] = {};
  if (isString(value.consentGrantedAt)) {
    setup.consentGrantedAt = value.consentGrantedAt;
  }
  if (isString(value.modelsFetchedAt)) {
    setup.modelsFetchedAt = value.modelsFetchedAt;
  }
  if (isString(value.firstRunNoticeShownAt)) {
    setup.firstRunNoticeShownAt = value.firstRunNoticeShownAt;
  }
  if (isString(value.lastCheckAt)) {
    setup.lastCheckAt = value.lastCheckAt;
  }
  if (Array.isArray(value.models)) {
    const models: CachedModel[] = [];
    for (const candidate of value.models) {
      if (
        isRecord(candidate) &&
        isNonEmptyString(candidate.id) &&
        isString(candidate.name) &&
        isString(candidate.vendor) &&
        isString(candidate.family)
      ) {
        models.push({
          id: candidate.id,
          name: candidate.name,
          vendor: candidate.vendor,
          family: candidate.family,
        });
      }
    }
    setup.models = models;
  }
  if (Array.isArray(value.lastCheckResults)) {
    const results: CheckOutcome[] = [];
    for (const candidate of value.lastCheckResults) {
      if (
        isRecord(candidate) &&
        isNonEmptyString(candidate.id) &&
        isString(candidate.title) &&
        isOneOf(candidate.status, ['pass', 'warn', 'fail'] as const) &&
        isString(candidate.message)
      ) {
        results.push({
          id: candidate.id,
          title: candidate.title,
          status: candidate.status,
          message: candidate.message,
        });
      }
    }
    setup.lastCheckResults = results;
  }
  return setup;
}

function validateClaim(value: unknown): RunClaim | string {
  if (!isRecord(value)) {
    return 'claim is not an object';
  }
  if (!isNonEmptyString(value.windowId)) {
    return 'claim.windowId must be a non-empty string';
  }
  if (!isNonEmptyString(value.runId)) {
    return 'claim.runId must be a non-empty string';
  }
  if (!isString(value.startedAt) || !isString(value.heartbeatAt)) {
    return 'claim.startedAt and claim.heartbeatAt must be strings';
  }
  return {
    windowId: value.windowId,
    runId: value.runId,
    startedAt: value.startedAt,
    heartbeatAt: value.heartbeatAt,
  };
}

function validateSchedule(value: unknown): AgentSchedule | string {
  if (!isRecord(value)) {
    return 'schedule is not an object';
  }
  if (!isStringArray(value.cronExpressions) || value.cronExpressions.length === 0) {
    return 'schedule.cronExpressions must be a non-empty array of strings';
  }
  if (value.timezone !== undefined && !isString(value.timezone)) {
    return 'schedule.timezone must be a string';
  }
  if (typeof value.runOnStartup !== 'boolean') {
    return 'schedule.runOnStartup must be a boolean';
  }
  if (!isOneOf(value.missedRunPolicy, ['skip', 'runOnce'] as const)) {
    return 'schedule.missedRunPolicy must be skip or runOnce';
  }
  return {
    cronExpressions: value.cronExpressions,
    timezone: value.timezone,
    runOnStartup: value.runOnStartup,
    missedRunPolicy: value.missedRunPolicy,
  };
}

function validateSource(value: unknown): AgentSource | string {
  if (!isRecord(value)) {
    return 'source is not an object';
  }
  if (!isNonEmptyString(value.baseUrlRef)) {
    return 'source.baseUrlRef must be a non-empty string';
  }
  if (value.kind === 'jira') {
    if (!isNonEmptyString(value.jql)) {
      return 'source.jql must be a non-empty string';
    }
    if (typeof value.maxResults !== 'number' || value.maxResults <= 0) {
      return 'source.maxResults must be a positive number';
    }
    return {
      kind: 'jira',
      baseUrlRef: value.baseUrlRef,
      jql: value.jql,
      maxResults: value.maxResults,
    };
  }
  if (value.kind === 'git') {
    if (!isNonEmptyString(value.repo)) {
      return 'source.repo must be a non-empty string';
    }
    if (!isOneOf(value.mode, ['newPullRequests', 'updatedPullRequests'] as const)) {
      return 'source.mode must be newPullRequests or updatedPullRequests';
    }
    if (value.sinceCursor !== undefined && !isString(value.sinceCursor)) {
      return 'source.sinceCursor must be a string';
    }
    return {
      kind: 'git',
      baseUrlRef: value.baseUrlRef,
      repo: value.repo,
      mode: value.mode,
      sinceCursor: value.sinceCursor,
    };
  }
  return 'source.kind must be jira or git';
}

function validatePrompt(value: unknown): PromptConfig | string {
  if (!isRecord(value)) {
    return 'prompt is not an object';
  }
  if (!isOneOf(value.source, ['inline', 'file'] as const)) {
    return 'prompt.source must be inline or file';
  }
  if (value.source === 'inline' && !isNonEmptyString(value.inlineText)) {
    return 'prompt.inlineText must be a non-empty string for inline prompts';
  }
  if (value.source === 'file' && !isNonEmptyString(value.filePath)) {
    return 'prompt.filePath must be a non-empty string for file prompts';
  }
  const prompt: PromptConfig = { source: value.source };
  if (isString(value.inlineText)) {
    prompt.inlineText = value.inlineText;
  }
  if (isString(value.filePath)) {
    prompt.filePath = value.filePath;
  }
  if (isRecord(value.snapshot)) {
    const { content, hash, capturedAt } = value.snapshot;
    if (isString(content) && isString(hash) && isString(capturedAt)) {
      prompt.snapshot = { content, hash, capturedAt };
    }
  }
  if (isOneOf(value.fallback, ['snapshot', 'blockWhenResolvable', 'blockAlways'] as const)) {
    prompt.fallback = value.fallback;
  }
  return prompt;
}

/** Validates one agent. Returns the agent, or a reason explaining why it was rejected. */
export function validateAgent(value: unknown): Agent | string {
  if (!isRecord(value)) {
    return 'agent is not an object';
  }
  if (!isNonEmptyString(value.id)) {
    return 'agent.id must be a non-empty string';
  }
  if (!isNonEmptyString(value.name)) {
    return 'agent.name must be a non-empty string';
  }
  if (typeof value.enabled !== 'boolean') {
    return 'agent.enabled must be a boolean';
  }
  if (!isOneOf(value.executionMode, ['api', 'chat'] as const)) {
    return 'agent.executionMode must be api or chat';
  }
  const schedule = validateSchedule(value.schedule);
  if (isString(schedule)) {
    return schedule;
  }
  const source = validateSource(value.source);
  if (isString(source)) {
    return source;
  }
  const prompt = validatePrompt(value.prompt);
  if (isString(prompt)) {
    return prompt;
  }
  if (!isString(value.modelId)) {
    return 'agent.modelId must be a string';
  }
  if (!isStringArray(value.tools)) {
    return 'agent.tools must be an array of strings';
  }

  const agent: Agent = {
    id: value.id,
    name: value.name,
    enabled: value.enabled,
    executionMode: value.executionMode,
    schedule,
    source,
    prompt,
    modelId: value.modelId,
    tools: value.tools,
    createdAt: isString(value.createdAt) ? value.createdAt : new Date(0).toISOString(),
    updatedAt: isString(value.updatedAt) ? value.updatedAt : new Date(0).toISOString(),
  };
  if (isString(value.outputFolder)) {
    agent.outputFolder = value.outputFolder;
  }
  if (typeof value.maxExecutionsPerDay === 'number') {
    agent.maxExecutionsPerDay = value.maxExecutionsPerDay;
  }
  if (isString(value.allowedTimeStart)) {
    agent.allowedTimeStart = value.allowedTimeStart;
  }
  if (isString(value.allowedTimeEnd)) {
    agent.allowedTimeEnd = value.allowedTimeEnd;
  }
  if (isString(value.lastRunAt)) {
    agent.lastRunAt = value.lastRunAt;
  }
  if (isString(value.nextRunAt)) {
    agent.nextRunAt = value.nextRunAt;
  }
  return agent;
}

/** Validates one run record. Returns the record, or a reason explaining the rejection. */
export function validateRunRecord(value: unknown): RunRecord | string {
  if (!isRecord(value)) {
    return 'run is not an object';
  }
  if (!isNonEmptyString(value.id) || !isNonEmptyString(value.agentId)) {
    return 'run.id and run.agentId must be non-empty strings';
  }
  if (!isString(value.startedAt)) {
    return 'run.startedAt must be a string';
  }
  const statuses = [
    'running',
    'succeeded',
    'failed',
    'skipped',
    'handedOff',
    'interrupted',
  ] as const;
  if (!isOneOf(value.status, statuses)) {
    return `run.status must be one of ${statuses.join(', ')}`;
  }
  if (!isOneOf(value.trigger, ['schedule', 'manual', 'startup', 'missedRun'] as const)) {
    return 'run.trigger must be schedule, manual, startup or missedRun';
  }
  const promptResolution = isRecord(value.promptResolution) ? value.promptResolution : {};
  const record: RunRecord = {
    id: value.id,
    agentId: value.agentId,
    startedAt: value.startedAt,
    status: value.status,
    trigger: value.trigger,
    summary: isString(value.summary) ? value.summary : '',
    modelId: isString(value.modelId) ? value.modelId : '',
    executionMode: isOneOf(value.executionMode, ['api', 'chat'] as const)
      ? value.executionMode
      : 'api',
    toolCalls: Array.isArray(value.toolCalls) ? (value.toolCalls as RunRecord['toolCalls']) : [],
    sourceItemCount: typeof value.sourceItemCount === 'number' ? value.sourceItemCount : 0,
    promptResolution: {
      source: isOneOf(promptResolution.source, ['inline', 'file'] as const)
        ? promptResolution.source
        : 'inline',
      usedSnapshot: promptResolution.usedSnapshot === true,
      path: isString(promptResolution.path) ? promptResolution.path : undefined,
      hash: isString(promptResolution.hash) ? promptResolution.hash : undefined,
    },
  };
  if (isString(value.finishedAt)) {
    record.finishedAt = value.finishedAt;
  }
  if (isString(value.resultFilePath)) {
    record.resultFilePath = value.resultFilePath;
  }
  if (isRecord(value.error) && isString(value.error.code) && isString(value.error.message)) {
    record.error = { code: value.error.code, message: value.error.message };
  }
  if (typeof value.jitterSeconds === 'number') {
    record.jitterSeconds = value.jitterSeconds;
  }
  return record;
}

function validateCounters(value: unknown, fallbackDate: string): DailyCounters | string {
  if (!isRecord(value)) {
    return 'counters is not an object';
  }
  if (!isNonEmptyString(value.localDate)) {
    return 'counters.localDate must be a non-empty string';
  }
  if (typeof value.global !== 'number' || value.global < 0) {
    return 'counters.global must be a non-negative number';
  }
  const perAgent: Record<string, number> = {};
  if (isRecord(value.perAgent)) {
    for (const [agentId, count] of Object.entries(value.perAgent)) {
      if (typeof count === 'number' && count >= 0) {
        perAgent[agentId] = count;
      }
    }
  }
  const counters: DailyCounters = {
    localDate: value.localDate || fallbackDate,
    global: value.global,
    perAgent,
  };
  if (isString(value.capNotifiedAt)) {
    counters.capNotifiedAt = value.capNotifiedAt;
  }
  return counters;
}

/**
 * Brings a stored envelope up to the current schema version.
 *
 * Version 1 is the starting point, so the chain is currently a single identity step. The
 * mechanism exists from day one so a later change has an obvious place to live.
 */
export function migrate(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return raw;
  }
  let current = raw;
  let version = typeof current.schemaVersion === 'number' ? current.schemaVersion : 1;
  while (version < CURRENT_SCHEMA_VERSION) {
    // Add one `if (version === n) { ... }` block per schema change.
    version += 1;
    current = { ...current, schemaVersion: version };
  }
  return current;
}

/**
 * Turns anything that was read from disk into a usable state.
 *
 * Malformed entries never crash activation and are never dropped silently: each one is
 * reported in `quarantine` so the caller can log it.
 */
export function normalizeState(raw: unknown, localDate: string): ValidationOutcome {
  const quarantine: QuarantineEntry[] = [];
  const migrated = migrate(raw);

  if (!isRecord(migrated)) {
    if (migrated !== undefined && migrated !== null) {
      quarantine.push({ kind: 'envelope', reason: 'state is not an object', value: migrated });
    }
    return { state: emptyState(localDate), quarantine };
  }

  const agents: Agent[] = [];
  if (Array.isArray(migrated.agents)) {
    for (const candidate of migrated.agents) {
      const agent = validateAgent(candidate);
      if (isString(agent)) {
        quarantine.push({ kind: 'agent', reason: agent, value: candidate });
      } else {
        agents.push(agent);
      }
    }
  } else if (migrated.agents !== undefined) {
    quarantine.push({ kind: 'envelope', reason: 'agents is not an array', value: migrated.agents });
  }

  const history: RunHistory = {};
  if (isRecord(migrated.history)) {
    for (const [agentId, runs] of Object.entries(migrated.history)) {
      if (!Array.isArray(runs)) {
        quarantine.push({ kind: 'run', reason: `history.${agentId} is not an array`, value: runs });
        continue;
      }
      const validated: RunRecord[] = [];
      for (const candidate of runs) {
        const record = validateRunRecord(candidate);
        if (isString(record)) {
          quarantine.push({ kind: 'run', reason: record, value: candidate });
        } else {
          validated.push(record);
        }
      }
      history[agentId] = validated;
    }
  }

  const runClaims: Record<string, RunClaim> = {};
  if (isRecord(migrated.runClaims)) {
    for (const [agentId, candidate] of Object.entries(migrated.runClaims)) {
      const claim = validateClaim(candidate);
      if (isString(claim)) {
        quarantine.push({ kind: 'claim', reason: claim, value: candidate });
      } else {
        runClaims[agentId] = claim;
      }
    }
  }

  const counters = validateCounters(migrated.counters, localDate);
  if (isString(counters)) {
    if (migrated.counters !== undefined) {
      quarantine.push({ kind: 'counters', reason: counters, value: migrated.counters });
    }
  }

  return {
    state: {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: typeof migrated.revision === 'number' ? migrated.revision : 0,
      agents,
      history,
      counters: isString(counters) ? emptyState(localDate).counters : counters,
      runClaims,
      setup: validateSetup(migrated.setup),
    },
    quarantine,
  };
}
