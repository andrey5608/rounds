import type { PermissionResult, RoundsTool, ToolContext, ToolOutput } from './registry.js';

/** What the editor reports about a tool another extension registered. */
export interface ExternalToolInfo {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  tags?: readonly string[];
}

/** The result of an invocation, already reduced to the parts this extension can render. */
export interface ExternalToolResult {
  text: string;
  /** True when the tool answered with parts that are not text, so the caller can say so. */
  hadUnreadableParts?: boolean;
}

/**
 * Invokes a tool by name. The vscode implementation calls `lm.invokeTool`.
 *
 * `signal` is how the deadline in `withDeadline` reaches the invocation; a tool that ignores it
 * still stops mattering, because the caller stops waiting.
 */
export type ExternalToolInvoker = (
  name: string,
  input: unknown,
  signal: { isCancelled: () => boolean },
) => Promise<ExternalToolResult>;

/** Names this extension owns. An external tool may not take one over. */
export const BUILT_IN_TOOL_NAMES = ['readFile', 'listFiles', 'runScript'] as const;

/**
 * How long an invocation may take before the loop gives up on it.
 *
 * `invokeTool` shows a confirmation dialog for tools that ask for one, even outside a chat
 * request, and a scheduled run has nobody to answer it. Nothing in the reported information says
 * which tools those are, so the deadline is the only honest defence: the run continues with a
 * denial the model can act on rather than waiting for a dialog until the window closes.
 */
export const EXTERNAL_TOOL_TIMEOUT_MS = 60_000;

/** Marks a tool that came from another extension, for the form and for the audit trail. */
export interface ExternalTool<TInput = unknown> extends RoundsTool<TInput> {
  readonly external: true;
  readonly tags: readonly string[];
}

/**
 * Turns what the editor reports into a tool the registry can hold.
 *
 * Everything the loop already does — denials fed back to the model, the audit record, the
 * truncation of the result — applies unchanged, which is the whole reason this is an adapter
 * rather than a second execution path.
 */
export function toExternalTool(
  info: ExternalToolInfo,
  invoke: ExternalToolInvoker,
  options: { timeoutMs?: number } = {},
): ExternalTool {
  return {
    external: true,
    name: info.name,
    description: info.description,
    // The editor validates the input against the tool's own schema, so this is passed through
    // rather than re-described here; a schema copied by hand would drift from the real one.
    inputSchema: info.inputSchema ?? { type: 'object' },
    tags: info.tags ?? [],

    parseInput: (raw: unknown) => raw,

    checkPermission: (_input: unknown, context: ToolContext): PermissionResult => {
      if (context.workspaceTrusted === false) {
        return {
          allowed: false,
          reason: `this workspace is not trusted, so tools from other extensions are not available. Trust it (Workspaces: Manage Workspace Trust) or take "${info.name}" off this agent`,
        };
      }
      return { allowed: true };
    },

    execute: async (input: unknown, context: ToolContext): Promise<ToolOutput> => {
      // The input may carry issue text, so its size is logged and its content is not.
      context.logger.info(
        `Calling the tool "${info.name}" from another extension with ${sizeOf(input)} character(s) of input.`,
      );

      const result = await withDeadline(
        (signal) => invoke(info.name, input, signal),
        options.timeoutMs ?? EXTERNAL_TOOL_TIMEOUT_MS,
        context,
      );

      if (result.kind === 'timedOut') {
        return {
          content: `The tool "${info.name}" did not answer within ${Math.round((options.timeoutMs ?? EXTERNAL_TOOL_TIMEOUT_MS) / 1000)}s. It may be waiting for a confirmation nobody is here to give. Continue without it.`,
          truncated: false,
        };
      }

      const note = result.value.hadUnreadableParts
        ? '\n\n(part of the answer was in a format Rounds does not render and was left out)'
        : '';
      return { content: `${result.value.text}${note}`, truncated: false };
    },
  };
}

/** True when this tool came from another extension rather than from this one. */
export function isExternalTool(tool: RoundsTool<never> | undefined): boolean {
  return (tool as ExternalTool | undefined)?.external === true;
}

type DeadlineOutcome<T> = { kind: 'answered'; value: T } | { kind: 'timedOut' };

/**
 * Races a promise against a deadline and against the run being cancelled.
 *
 * The invocation is not aborted — nothing in the API promises that is possible — the caller
 * simply stops waiting for it, which is what keeps one unanswerable dialog from holding a
 * scheduled run open until the editor closes.
 */
async function withDeadline<T>(
  work: (signal: { isCancelled: () => boolean }) => Promise<T>,
  timeoutMs: number,
  context: ToolContext,
): Promise<DeadlineOutcome<T>> {
  let expired = false;
  const signal = { isCancelled: () => expired || context.isCancelled?.() === true };

  const deadline = new Promise<DeadlineOutcome<T>>((resolve) => {
    const timer = setTimeout(() => {
      expired = true;
      resolve({ kind: 'timedOut' });
    }, timeoutMs);
    // Nothing should keep the extension host alive waiting for this.
    timer.unref?.();
  });

  return Promise.race([
    work(signal).then((value): DeadlineOutcome<T> => ({ kind: 'answered', value })),
    deadline,
  ]);
}

function sizeOf(input: unknown): number {
  try {
    return typeof input === 'string' ? input.length : JSON.stringify(input).length;
  } catch {
    return 0;
  }
}
