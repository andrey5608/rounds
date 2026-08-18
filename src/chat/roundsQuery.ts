import { describeCron, nextRuns, validateCron } from '../scheduler/cron.js';
import { effectiveTimeZone } from '../scheduler/schedule.js';
import { redact } from '../state/logger.js';
import type { Agent, PersistedState, RunRecord } from '../state/types.js';

/** The name the manifest contributes and the model refers to. */
export const ROUNDS_QUERY_TOOL = 'rounds_query';

export const QUERY_KINDS = [
  'list',
  'get',
  'history',
  'preview_cron',
  'list_models',
  'list_sources',
] as const;

export type QueryKind = (typeof QUERY_KINDS)[number];

/**
 * The fields each kind accepts.
 *
 * An explicit list rather than "ignore what you do not know": a model that guesses a field gets a
 * correction naming what it could have sent, which is the difference between one wasted turn and
 * three.
 */
const ALLOWED_FIELDS: Record<QueryKind, readonly string[]> = {
  list: ['kind', 'enabledOnly'],
  get: ['kind', 'id'],
  history: ['kind', 'id', 'limit'],
  preview_cron: ['kind', 'cronExpression', 'count', 'timeZone'],
  list_models: ['kind'],
  list_sources: ['kind'],
};

const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 50;
const DEFAULT_PREVIEW_COUNT = 3;
const MAX_PREVIEW_COUNT = 10;
const PROMPT_PREVIEW_CHARS = 160;

export type QueryResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; reason: 'validation' | 'notFound'; message: string };

export interface QueryContext {
  state: PersistedState;
  now: Date;
  /** The `rounds.timezone` setting, used where an agent does not name its own. */
  timeZone?: string;
  /** Values that must never appear in a result, the same list the logger redacts. */
  secrets?: readonly string[];
}

/**
 * Answers a question about agents, runs and schedules.
 *
 * Read-only by construction: nothing here takes a store, so there is no code path that could
 * write even by accident. That is the whole reason the phase starts with the reading half —
 * a tool that answers questions cannot put a one-minute schedule past the guards the wizard
 * applies.
 */
export function runQuery(input: unknown, context: QueryContext): QueryResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('The input must be an object with a "kind" field.');
  }
  const fields = input as Record<string, unknown>;
  const kind = fields.kind;
  if (typeof kind !== 'string' || !isKind(kind)) {
    return invalid(`"kind" must be one of: ${QUERY_KINDS.join(', ')}.`);
  }

  const allowed = ALLOWED_FIELDS[kind];
  const unexpected = Object.keys(fields).filter((field) => !allowed.includes(field));
  if (unexpected.length > 0) {
    return invalid(
      `Fields not allowed for kind="${kind}": ${unexpected.join(', ')}. Allowed: ${allowed.join(', ')}.`,
    );
  }

  const result = answer(kind, fields, context);
  return redactResult(result, context.secrets ?? []);
}

function answer(kind: QueryKind, fields: Record<string, unknown>, context: QueryContext): QueryResult {
  switch (kind) {
    case 'list':
      return listAgents(fields, context);
    case 'get':
      return getAgent(fields, context);
    case 'history':
      return agentHistory(fields, context);
    case 'preview_cron':
      return previewCron(fields, context);
    case 'list_models':
      return {
        ok: true,
        models: (context.state.setup.models ?? []).map((model) => ({
          id: model.id,
          name: model.name,
          vendor: model.vendor,
        })),
        hint: 'An agent must name one of these ids exactly; a run fails rather than substituting another model.',
      };
    case 'list_sources':
      return {
        ok: true,
        // Base URLs and connection names are configuration, and an answer that hides which host
        // an agent reads is not useful. Tokens live in secret storage and never come near this.
        sources: Object.values(context.state.endpoints).map((endpoint) => ({
          name: endpoint.name,
          kind: endpoint.kind,
          baseUrl: endpoint.baseUrl,
          provider: endpoint.provider,
        })),
      };
  }
}

function listAgents(fields: Record<string, unknown>, context: QueryContext): QueryResult {
  if (fields.enabledOnly !== undefined && typeof fields.enabledOnly !== 'boolean') {
    return invalid('"enabledOnly" must be true or false.');
  }
  const agents = context.state.agents.filter(
    (agent) => fields.enabledOnly !== true || agent.enabled,
  );
  return {
    ok: true,
    count: agents.length,
    promptTextOmitted: true,
    agents: agents.map((agent) => summarize(agent, context)),
    hint: 'Prompt bodies are omitted here. Use kind="get" for the full prompt, and never write a promptPreview back to an agent.',
  };
}

function getAgent(fields: Record<string, unknown>, context: QueryContext): QueryResult {
  const agent = findAgent(fields.id, context);
  if (!agent) {
    return notFound(fields.id, context);
  }
  return {
    ok: true,
    agent: {
      ...summarize(agent, context),
      prompt: {
        source: agent.prompt.source,
        filePath: agent.prompt.filePath,
        text:
          agent.prompt.source === 'inline'
            ? agent.prompt.inlineText
            : agent.prompt.snapshot?.content,
      },
    },
  };
}

function agentHistory(fields: Record<string, unknown>, context: QueryContext): QueryResult {
  const agent = findAgent(fields.id, context);
  if (!agent) {
    return notFound(fields.id, context);
  }
  if (fields.limit !== undefined && (typeof fields.limit !== 'number' || fields.limit < 1)) {
    return invalid('"limit" must be a positive number.');
  }
  const limit = Math.min(typeof fields.limit === 'number' ? fields.limit : DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
  const all = context.state.history[agent.id] ?? [];
  const runs = all.slice(0, limit);
  return {
    ok: true,
    agentId: agent.id,
    total: all.length,
    count: runs.length,
    hasMore: all.length > runs.length,
    runs: runs.map(describeRunRecord),
  };
}

function previewCron(fields: Record<string, unknown>, context: QueryContext): QueryResult {
  const expression = fields.cronExpression;
  if (typeof expression !== 'string' || expression.trim().length === 0) {
    return invalid('"cronExpression" must be a cron expression, for example "0 9 * * *".');
  }
  if (fields.timeZone !== undefined && typeof fields.timeZone !== 'string') {
    return invalid('"timeZone" must be an IANA time zone name, for example "Europe/Berlin".');
  }
  if (fields.count !== undefined && (typeof fields.count !== 'number' || fields.count < 1)) {
    return invalid('"count" must be a positive number.');
  }
  const timeZone = fields.timeZone ?? context.timeZone;
  const validation = validateCron(expression, timeZone);
  if (!validation.valid) {
    return invalid(validation.error ?? `"${expression}" is not a cron expression.`);
  }
  const count = Math.min(
    typeof fields.count === 'number' ? fields.count : DEFAULT_PREVIEW_COUNT,
    MAX_PREVIEW_COUNT,
  );
  return {
    ok: true,
    cronExpression: expression.trim(),
    description: describeCron([expression]),
    timeZone: timeZone ?? 'the system time zone',
    nextRuns: nextRuns([expression], count, context.now, timeZone).map((run) => run.toISOString()),
  };
}

/** Everything about an agent except its prompt body. */
function summarize(agent: Agent, context: QueryContext): Record<string, unknown> {
  const text =
    agent.prompt.source === 'inline'
      ? (agent.prompt.inlineText ?? '')
      : (agent.prompt.snapshot?.content ?? '');
  const collapsed = text.trim().replace(/\s+/gu, ' ');
  const zone = effectiveTimeZone(agent, context.timeZone);

  return {
    id: agent.id,
    name: agent.name,
    enabled: agent.enabled,
    executionMode: agent.executionMode,
    schedule: {
      cronExpressions: agent.schedule.cronExpressions,
      description: describeCron(agent.schedule.cronExpressions),
      timeZone: zone ?? 'the system time zone',
      nextRuns: agent.enabled
        ? nextRuns(agent.schedule.cronExpressions, DEFAULT_PREVIEW_COUNT, context.now, zone).map(
            (run) => run.toISOString(),
          )
        : [],
      runOnStartup: agent.schedule.runOnStartup,
      missedRunPolicy: agent.schedule.missedRunPolicy,
    },
    source:
      agent.source.kind === 'jira'
        ? { kind: 'jira', connection: agent.source.baseUrlRef, jql: agent.source.jql, maxResults: agent.source.maxResults }
        : {
            kind: 'git',
            connection: agent.source.baseUrlRef,
            repo: agent.source.repo,
            mode: agent.source.mode,
          },
    modelId: agent.modelId,
    tools: agent.tools,
    // Under its own key on purpose: a truncated preview must never be mistaken for the prompt,
    // and must never be written back to an agent as one.
    promptLength: text.length,
    promptPreview:
      collapsed.length > PROMPT_PREVIEW_CHARS
        ? `${collapsed.slice(0, PROMPT_PREVIEW_CHARS - 1)}…`
        : collapsed,
    lastRunAt: agent.lastRunAt,
    nextRunAt: agent.nextRunAt,
  };
}

function describeRunRecord(run: RunRecord): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    summary: run.summary,
    sourceItemCount: run.sourceItemCount,
    modelId: run.modelId,
    toolCalls: run.toolCalls.map((call) => call.name),
    errorCode: run.error?.code,
  };
}

function findAgent(id: unknown, context: QueryContext): Agent | undefined {
  if (typeof id !== 'string') {
    return undefined;
  }
  return context.state.agents.find((agent) => agent.id === id || agent.name === id);
}

function notFound(id: unknown, context: QueryContext): QueryResult {
  const names = context.state.agents.map((agent) => `${agent.name} (${agent.id})`).join(', ');
  return {
    ok: false,
    reason: 'notFound',
    message:
      typeof id === 'string'
        ? `No agent matches "${id}". Known agents: ${names || 'none'}.`
        : `"id" must be an agent id or name. Known agents: ${names || 'none'}.`,
  };
}

function invalid(message: string): QueryResult {
  // A failure is a value rather than an exception: a model can act on a value, and cannot act
  // on a stack trace it never sees.
  return { ok: false, reason: 'validation', message };
}

function isKind(value: string): value is QueryKind {
  return (QUERY_KINDS as readonly string[]).includes(value);
}

/**
 * Last gate before anything leaves the extension.
 *
 * The same redaction the logger uses, applied to the serialized result: this is the same class of
 * output leaving the process, and a second mechanism would rot at a different rate than the first.
 */
function redactResult(result: QueryResult, secrets: readonly string[]): QueryResult {
  if (secrets.length === 0) {
    return result;
  }
  return JSON.parse(redact(JSON.stringify(result), secrets)) as QueryResult;
}
