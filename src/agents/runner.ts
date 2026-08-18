import { randomUUID } from 'node:crypto';

import { ConnectorError } from '../connectors/errors.js';
import type { RepositoryHostConnector } from '../connectors/git.js';
import type { FetchResult, SourceItem } from '../connectors/items.js';
import type { IssueTrackerConnector } from '../connectors/jira.js';
import { mapModelError } from '../model/errors.js';
import type { LanguageModelGateway } from '../model/gateway.js';
import {
  EmptyResponseError,
  IterationCapError,
  RunCancelledError,
  runAgenticLoop,
} from '../model/loop.js';
import { ModelNotFoundError } from '../setup/modelCatalog.js';
import type { ModelCatalog } from '../setup/modelCatalog.js';
import { evaluateReadiness } from '../setup/needsSetup.js';
import { resolveOutputFolder } from '../setup/outputFolder.js';
import type { RunClaims } from '../scheduler/runClaims.js';
import type { CountersService } from '../state/counters.js';
import type { HistoryService } from '../state/history.js';
import type { Logger } from '../state/logger.js';
import type { SecretName } from '../state/secrets.js';
import type { RoundsSettings } from '../state/settings.js';
import type { RoundsStore } from '../state/store.js';
import { systemClock } from '../state/time.js';
import type { Clock } from '../state/time.js';
import type { Agent, AgentSource, RunRecord, RunTrigger } from '../state/types.js';
import { createRunRegistry } from '../tools/index.js';
import type {
  FileFinder,
  ProcessRunner,
  RoundsTool,
  ToolContext,
  ToolRegistry,
} from '../tools/registry.js';

import { PromptValidationError, renderPrompt, validatePrompt } from './placeholders.js';
import { PromptUnavailableError, PromptResolver } from './promptResolver.js';
import type { PromptResolution } from './promptResolver.js';
import { ResultWriter, summarize } from './resultWriter.js';

/**
 * How many items a per-item prompt may be rendered for in one run.
 *
 * A prompt written around `{{issueKey}}` produces one model request per item, so a query
 * matching forty issues would quietly make forty requests. The cap keeps a single run's cost
 * predictable and is reported in the result.
 */
export const MAX_ITEM_PROMPTS = 10;

/**
 * Turns whatever a stage threw into a reason worth storing.
 *
 * Errors that already know what went wrong keep their own code and message. Only unrecognised
 * failures go through the model error mapping — routing everything through it produced
 * nonsense, because a `PromptUnavailableError` was reported as "the model is not available"
 * purely because its class name contains the word.
 */
export function describeFailure(error: unknown): { code: string; message: string } {
  if (
    error instanceof PromptUnavailableError ||
    error instanceof PromptValidationError ||
    error instanceof ConnectorError ||
    error instanceof ModelNotFoundError ||
    error instanceof IterationCapError ||
    error instanceof EmptyResponseError ||
    error instanceof RunCancelledError
  ) {
    return { code: error.code, message: error.message };
  }
  const mapped = mapModelError(error);
  return { code: mapped.code, message: mapped.message };
}

/** What a source fetch produced, whatever kind of source it was. */
interface SourceData extends FetchResult {
  diffs: Map<string, string>;
}

export interface ConnectorProvider {
  /** Only ever called for an agent that has a source; the runner checks before it asks. */
  forSource(source: AgentSource): Promise<{
    tracker?: IssueTrackerConnector;
    repositoryHost?: RepositoryHostConnector;
  }>;
}

export interface RunnerDependencies {
  store: RoundsStore;
  history: HistoryService;
  counters: CountersService;
  claims: RunClaims;
  models: ModelCatalog;
  gateway: LanguageModelGateway;
  registry: ToolRegistry;
  /**
   * Tools other extensions registered, read at the start of each run.
   *
   * A function rather than a list: what the editor reports changes while a window is open.
   */
  externalTools?: () => readonly RoundsTool<unknown>[];
  connectors: ConnectorProvider;
  resultWriter?: ResultWriter;
  /** Chat mode handoff. Absent means chat mode cannot run in this window. */
  handOffToChat?: (prompt: string, options: { modelId?: string }) => Promise<void>;
  settings: () => RoundsSettings;
  globalStorage: string;
  workspaceFolders: string[];
  /** Whether the user trusts this workspace. Injected so the runner stays free of `vscode`. */
  workspaceTrusted?: () => boolean;
  workspaceName?: string;
  findFiles?: FileFinder;
  runProcess?: ProcessRunner;
  logger: Logger;
  clock?: Clock;
  secretNames: () => Promise<SecretName[]>;
}

export interface RunRequest {
  agent: Agent;
  trigger: RunTrigger;
  /** Delay already applied before this run, recorded for the history. */
  jitterSeconds?: number;
  isCancelled?: () => boolean;
}

/**
 * Runs one agent from start to finish.
 *
 * The single most important property here: `run` never throws. Whatever goes wrong — a source
 * that refuses the token, a prompt file that vanished, a model that is gone, a tool that
 * crashed — becomes a recorded run with a status and a reason the user can read. A scheduler
 * that has to catch exceptions from the thing it schedules cannot report anything useful, and an
 * agent that fails silently is indistinguishable from one that never ran.
 */
export class AgentRunner {
  private readonly clock: Clock;
  private readonly resultWriter: ResultWriter;

  constructor(private readonly dependencies: RunnerDependencies) {
    this.clock = dependencies.clock ?? systemClock;
    this.resultWriter = dependencies.resultWriter ?? new ResultWriter();
  }

  async run(request: RunRequest): Promise<RunRecord> {
    const startedAt = this.clock.now();
    const runId = randomUUID();
    const logger = this.dependencies.logger.scope(`run:${runId.slice(0, 8)}`);
    const record: RunRecord = {
      id: runId,
      agentId: request.agent.id,
      startedAt: startedAt.toISOString(),
      status: 'running',
      trigger: request.trigger,
      summary: '',
      modelId: request.agent.modelId,
      executionMode: request.agent.executionMode,
      toolCalls: [],
      sourceItemCount: 0,
      promptResolution: { source: request.agent.prompt.source, usedSnapshot: false },
      jitterSeconds: request.jitterSeconds,
    };

    let claimed = false;
    try {
      const blocked = await this.validate(request.agent);
      if (blocked) {
        return this.finish(record, { status: 'skipped', summary: blocked, logger });
      }

      const claim = await this.dependencies.claims.tryClaim(request.agent.id, runId);
      if (!claim.granted) {
        return this.finish(record, {
          status: 'skipped',
          summary: `Another window is already running this agent (since ${claim.heldBy?.startedAt ?? 'unknown'}).`,
          logger,
        });
      }
      claimed = true;
      this.dependencies.claims.startHeartbeat(request.agent.id);
      await this.dependencies.history.record(record);

      return await this.execute(request, record, logger);
    } catch (error) {
      // Nothing above may escape: the reason has to reach the history.
      const failure = describeFailure(error);
      logger.error(`The run failed (${failure.code}): ${String(error)}`);
      return this.finish(record, {
        status: 'failed',
        summary: failure.message,
        error: failure,
        logger,
      });
    } finally {
      if (claimed) {
        this.dependencies.claims.stopHeartbeat(request.agent.id);
        await this.dependencies.claims.release(request.agent.id).catch(() => undefined);
      }
    }
  }

  /** Reasons not to run at all. Returns the reason, or `undefined` when the agent may run. */
  private async validate(agent: Agent): Promise<string | undefined> {
    const state = await this.dependencies.store.read();
    const readiness = evaluateReadiness({
      agent,
      hasConsent: state.setup.consentGrantedAt !== undefined,
      models: state.setup.models ?? [],
      endpoints: state.endpoints,
      storedSecrets: await this.dependencies.secretNames(),
      workspaceTrusted: this.dependencies.workspaceTrusted?.() ?? true,
    });
    if (!readiness.ready) {
      return readiness.reason;
    }

    const cap = await this.dependencies.counters.canRun(agent);
    if (!cap.allowed) {
      return cap.reason === 'agentCap'
        ? `This agent has already run ${cap.limit} time(s) today, which is its own limit.`
        : `Rounds has already run ${cap.limit} time(s) today, which is the limit in the settings.`;
    }
    return undefined;
  }

  private async execute(
    request: RunRequest,
    record: RunRecord,
    logger: Logger,
  ): Promise<RunRecord> {
    const { agent } = request;
    const settings = this.dependencies.settings();
    const timeZone = agent.schedule.timezone ?? settings.timezone;

    const resolution = await this.resolvePrompt(agent, settings);
    record.promptResolution = resolution.record;
    const scan = validatePrompt(resolution.text, { hasSource: agent.source !== undefined });

    const source = await this.fetchSource(agent, {
      needsComments: resolution.text.includes('{{items}}') || scan.perItem,
      needsDiff: scan.used.includes('diff'),
    });
    record.sourceItemCount = source.items.length;
    if (agent.source) {
      logger.info(`Fetched ${source.items.length} item(s) from the ${agent.source.kind} source.`);
    } else {
      logger.info('This agent has no source; the prompt runs as written.');
    }

    const prompts = this.renderPrompts(resolution.text, source, scan.perItem, timeZone);
    // An agent with no source always has exactly one prompt, so an empty list can only mean a
    // source that returned nothing. Saying "the source returned nothing" about an agent that has
    // none would be a lie about why nothing happened.
    if (prompts.length === 0 && agent.source) {
      return this.finish(record, {
        status: 'skipped',
        summary: 'The source returned nothing to work on.',
        logger,
        resolution,
      });
    }

    if (agent.executionMode === 'chat') {
      return this.handOff(request, record, prompts, logger, resolution);
    }

    const model = await this.dependencies.models.resolveForRun(agent.modelId);

    // The tools this run may use: ours, plus whatever other extensions report right now.
    const external = this.dependencies.externalTools?.() ?? [];
    const registry = external.length > 0 ? createRunRegistry(external) : this.dependencies.registry;
    const missing = agent.tools.filter((name) => !registry.get(name));
    if (missing.length > 0) {
      // The same rule the specification applies to a model that is gone: fail and name it. A tool
      // quietly dropped from the request changes what the agent does without saying so.
      return this.finish(record, {
        status: 'failed',
        summary: `This agent uses ${missing.length === 1 ? 'a tool' : 'tools'} no extension provides right now: ${missing.join(', ')}.`,
        error: {
          code: 'tool.missing',
          message: `No extension currently registers: ${missing.join(', ')}. Available: ${registry.names().join(', ')}.`,
        },
        logger,
        resolution,
      });
    }

    const sections: string[] = [];
    let truncated = prompts.some((prompt) => prompt.truncated);

    for (const [index, prompt] of prompts.entries()) {
      if (request.isCancelled?.()) {
        break;
      }
      const outcome = await runAgenticLoop({
        gateway: this.dependencies.gateway,
        registry,
        modelId: model.id,
        prompt: prompt.text,
        enabledTools: agent.tools,
        toolContext: this.toolContext(record.id, settings, request.isCancelled),
        logger,
        isCancelled: request.isCancelled,
      });
      logger.info(
        `Model answer for prompt ${index + 1} of ${prompts.length}: ${outcome.text.length} character(s) after ${outcome.iterations} round(s), ${outcome.toolCalls.length} tool call(s).`,
      );
      record.toolCalls.push(...outcome.toolCalls);
      sections.push(
        prompts.length > 1 ? `## ${prompt.label ?? `Item ${index + 1}`}\n\n${outcome.text}` : outcome.text,
      );
    }

    if (prompts.length > MAX_ITEM_PROMPTS) {
      truncated = true;
    }

    const body = sections.join('\n\n---\n\n');
    const resultFilePath = await this.writeResult(agent, record, source, body, truncated, timeZone);
    return this.finish(record, {
      status: 'succeeded',
      summary: summarize(body),
      resultFilePath,
      logger,
      resolution,
      cursor: source.cursor,
    });
  }

  private async handOff(
    request: RunRequest,
    record: RunRecord,
    prompts: { text: string; truncated: boolean; label?: string }[],
    logger: Logger,
    resolution: PromptResolution,
  ): Promise<RunRecord> {
    if (!this.dependencies.handOffToChat) {
      return this.finish(record, {
        status: 'failed',
        summary: 'This window cannot open the chat view, so the handoff did not happen.',
        error: { code: 'chat.unavailable', message: 'The chat view is not available.' },
        logger,
        resolution,
      });
    }
    const first = prompts[0];
    // The agent's model is passed along so the chat does not open with whatever was used last.
    // Whether the editor honours it is out of our hands, which is why the summary below says the
    // model was requested rather than used.
    await this.dependencies.handOffToChat(first?.text ?? '', { modelId: record.modelId });
    const note =
      prompts.length > 1
        ? ` Only the first of ${prompts.length} rendered prompts was opened.`
        : '';
    logger.info('Opened the prompt in the chat view for review.');
    return this.finish(record, {
      status: 'handedOff',
      summary: `The prompt was opened in the chat view with ${record.modelId} requested; Rounds does not see the answer.${note}`,
      logger,
      resolution,
    });
  }

  private async resolvePrompt(agent: Agent, settings: RoundsSettings): Promise<PromptResolution> {
    const resolver = new PromptResolver({
      workspaceRoot: this.dependencies.workspaceFolders[0],
      defaultFallback: settings.promptFileFallback,
      clock: this.clock,
      logger: this.dependencies.logger,
    });
    const resolution = await resolver.resolve(agent);
    if (resolution.refreshedSnapshot) {
      const snapshot = resolution.refreshedSnapshot;
      await this.dependencies.store.update((draft) => {
        const stored = draft.agents.find((candidate) => candidate.id === agent.id);
        if (stored) {
          stored.prompt.snapshot = snapshot;
        }
      });
    }
    return resolution;
  }

  private async fetchSource(
    agent: Agent,
    needs: { needsComments: boolean; needsDiff: boolean },
  ): Promise<SourceData> {
    const diffs = new Map<string, string>();
    const source = agent.source;
    if (!source) {
      // Nothing to fetch, and nothing asked for: no connector is built, so this run works in an
      // installation with no connections configured at all.
      return { items: [], truncated: false, diffs };
    }

    const connectors = await this.dependencies.connectors.forSource(source);

    if (source.kind === 'jira') {
      const tracker = connectors.tracker;
      if (!tracker) {
        throw new Error('The issue tracker connection could not be created.');
      }
      const result = await tracker.search({
        jql: source.jql,
        maxResults: source.maxResults,
        includeComments: needs.needsComments,
        includeLinks: needs.needsComments,
      });
      return { ...result, diffs };
    }

    const host = connectors.repositoryHost;
    if (!host) {
      throw new Error('The repository host connection could not be created.');
    }
    const result = await host.listPullRequests({
      project: source.project,
      repo: source.repo,
      mode: source.mode,
      cursor: source.sinceCursor,
    });
    if (needs.needsDiff) {
      for (const item of result.items.slice(0, MAX_ITEM_PROMPTS)) {
        const diff = await host.getDiff(source.project, source.repo, item.id);
        diffs.set(item.id, diff.text);
      }
    }
    return { ...result, diffs };
  }

  private renderPrompts(
    template: string,
    source: SourceData,
    perItem: boolean,
    timeZone: string | undefined,
  ): { text: string; truncated: boolean; label?: string }[] {
    const now = this.clock.now();
    const base = {
      items: source.items,
      now,
      timeZone,
      workspaceName: this.dependencies.workspaceName,
    };

    if (!perItem) {
      const rendered = renderPrompt(template, base);
      return [{ text: rendered.text, truncated: rendered.truncated }];
    }

    return source.items.slice(0, MAX_ITEM_PROMPTS).map((item: SourceItem) => {
      const rendered = renderPrompt(template, { ...base, item, diff: source.diffs.get(item.id) });
      return { text: rendered.text, truncated: rendered.truncated, label: `${item.id} ${item.title}` };
    });
  }

  private toolContext(
    runId: string,
    settings: RoundsSettings,
    isCancelled?: () => boolean,
  ): ToolContext {
    return {
      workspaceFolders: this.dependencies.workspaceFolders,
      scriptWhitelist: settings.scriptWhitelist,
      workspaceTrusted: this.dependencies.workspaceTrusted?.() ?? true,
      logger: this.dependencies.logger,
      runId,
      findFiles: this.dependencies.findFiles,
      runProcess: this.dependencies.runProcess,
      isCancelled,
    };
  }

  private async writeResult(
    agent: Agent,
    record: RunRecord,
    source: SourceData,
    body: string,
    truncated: boolean,
    timeZone: string | undefined,
  ): Promise<string | undefined> {
    const folder = resolveOutputFolder({
      agentFolder: agent.outputFolder,
      settingFolder: this.dependencies.settings().defaultOutputFolder,
      globalStorage: this.dependencies.globalStorage,
    });
    try {
      return await this.resultWriter.write({
        folder,
        agentName: agent.name,
        startedAt: new Date(record.startedAt),
        timeZone,
        record: { ...record, finishedAt: this.clock.now().toISOString(), status: 'succeeded' },
        sourceItemIds: source.items.map((item) => item.id),
        truncated,
        body,
      });
    } catch (error) {
      // A run whose output cannot be stored is still a run that happened; the history keeps it.
      this.dependencies.logger.error(`Could not write the result file: ${String(error)}`);
      return undefined;
    }
  }

  /** Stores the final record, counts the run and advances what a success is allowed to advance. */
  private async finish(
    record: RunRecord,
    outcome: {
      status: RunRecord['status'];
      summary: string;
      error?: RunRecord['error'];
      resultFilePath?: string;
      logger: Logger;
      resolution?: PromptResolution;
      cursor?: string;
    },
  ): Promise<RunRecord> {
    const finished: RunRecord = {
      ...record,
      status: outcome.status,
      summary: outcome.summary,
      error: outcome.error,
      resultFilePath: outcome.resultFilePath,
      finishedAt: this.clock.now().toISOString(),
      promptResolution: outcome.resolution?.record ?? record.promptResolution,
    };

    await this.dependencies.history.record(finished);

    if (outcome.status === 'succeeded' || outcome.status === 'handedOff') {
      // Both reach the model provider, so both count against the daily limit.
      await this.dependencies.counters.count(record.agentId);
      await this.dependencies.store.update((draft) => {
        const agent = draft.agents.find((candidate) => candidate.id === record.agentId);
        if (!agent) {
          return;
        }
        agent.lastRunAt = finished.finishedAt;
        // The cursor only moves on success: a failed run must see the same items again.
        if (outcome.status === 'succeeded' && outcome.cursor && agent.source?.kind === 'git') {
          agent.source.sinceCursor = outcome.cursor;
        }
      });
    }

    outcome.logger.info(`Run ${outcome.status}: ${outcome.summary}`);
    return finished;
  }
}
