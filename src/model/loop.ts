import { LIMITS, truncate } from '../agents/truncate.js';
import type { StoreLogger } from '../state/store.js';
import type { ToolCallRecord } from '../state/types.js';
import type { ToolContext, ToolRegistry } from '../tools/registry.js';

import type { LanguageModelGateway, ModelMessage } from './gateway.js';

/** How many times the model may ask for tools before the run is stopped. */
export const MAX_ITERATIONS = 10;

/**
 * Thrown when the model produced nothing at all.
 *
 * Reported from a real run: the record said "succeeded" and the summary said "the model returned no
 * text", which tells the user neither what happened nor what to do. An answer with no text and no tool
 * calls is a failed run, not a successful one that happens to be empty.
 */
export class EmptyResponseError extends Error {
  readonly code = 'model.emptyResponse';

  constructor(readonly modelId: string) {
    super(
      `The model "${modelId}" returned no text and asked for no tools. Check the extended log for what was sent, and try a different model or a simpler prompt.`,
    );
    this.name = 'EmptyResponseError';
  }
}

export class IterationCapError extends Error {
  readonly code = 'model.iterationCap';

  constructor(iterations: number) {
    super(
      `The model kept asking for tools without producing an answer (${iterations} rounds). The run was stopped; simplify the prompt or enable fewer tools.`,
    );
    this.name = 'IterationCapError';
  }
}

export interface AgenticLoopOptions {
  gateway: LanguageModelGateway;
  registry: ToolRegistry;
  modelId: string;
  prompt: string;
  /** Names of the tools this agent enabled. */
  enabledTools: string[];
  toolContext: ToolContext;
  logger: StoreLogger;
  maxIterations?: number;
  isCancelled?: () => boolean;
}

export interface AgenticLoopResult {
  text: string;
  toolCalls: ToolCallRecord[];
  iterations: number;
}

export class RunCancelledError extends Error {
  readonly code = 'run.cancelled';

  constructor() {
    super('The run was cancelled.');
    this.name = 'RunCancelledError';
  }
}

/**
 * Runs the conversation until the model produces an answer.
 *
 * The shape is the usual one: send, collect tool calls, execute them, feed the results back,
 * repeat. Two details matter. The iteration cap is a failure, not a silent stop — a model
 * looping over tools forever would otherwise burn quota and produce nothing while looking like
 * a slow run. And tool results are capped before they go back, because a tool that returns a
 * megabyte would make the next request fail rather than the tool call.
 */
export async function runAgenticLoop(options: AgenticLoopOptions): Promise<AgenticLoopResult> {
  const maxIterations = options.maxIterations ?? MAX_ITERATIONS;
  const tools = options.registry.toChatTools(options.enabledTools);
  const messages: ModelMessage[] = [{ role: 'user', text: options.prompt }];
  const toolCalls: ToolCallRecord[] = [];

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (options.isCancelled?.()) {
      throw new RunCancelledError();
    }

    const started = Date.now();
    options.logger.debug(
      `Round ${iteration}: sending ${messages.length} message(s) and ${tools.length} tool declaration(s) to ${options.modelId}.`,
    );
    const turn = await options.gateway.sendRequest({
      modelId: options.modelId,
      messages,
      tools,
    });
    options.logger.info(
      `Round ${iteration} answered in ${Date.now() - started}ms: ${turn.text.length} character(s) of text, ${turn.toolCalls.length} tool call(s).`,
    );

    if (turn.toolCalls.length === 0) {
      if (turn.text.trim().length === 0) {
        // Nothing to write and nothing to act on: reporting this as a success would leave an empty
        // result file and a history entry that says everything went well.
        throw new EmptyResponseError(options.modelId);
      }
      options.logger.debug(
        `The model answered after ${iteration} round(s); the answer starts: ${turn.text.slice(0, 200)}`,
      );
      return { text: turn.text, toolCalls, iterations: iteration };
    }

    options.logger.debug(
      `Round ${iteration}: the model asked for ${turn.toolCalls.map((call) => call.name).join(', ')}.`,
    );
    messages.push({ role: 'assistant', text: turn.text, toolCalls: turn.toolCalls });

    const results: { callId: string; content: string }[] = [];
    for (const call of turn.toolCalls) {
      if (options.isCancelled?.()) {
        throw new RunCancelledError();
      }
      const outcome = await options.registry.invoke(call.name, call.input, options.toolContext);
      toolCalls.push(outcome.record);
      const capped = truncate(outcome.content, LIMITS.toolResult);
      results.push({ callId: call.callId, content: capped.text });
    }
    messages.push({ role: 'user', toolResults: results });
  }

  throw new IterationCapError(maxIterations);
}
