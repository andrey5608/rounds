import type { ScriptWhitelistEntry } from '../state/settings.js';
import type { StoreLogger } from '../state/store.js';
import type { ToolCallRecord } from '../state/types.js';

/** Finds files in the workspace. Supplied by the editor in production, faked in tests. */
export type FileFinder = (globPattern: string, limit: number) => Promise<string[]>;

/** What a spawned process reported. */
export interface ProcessResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a command without a shell. Supplied so tests never spawn anything real. */
export type ProcessRunner = (options: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: Record<string, string | undefined>;
}) => Promise<ProcessResult>;

export interface ToolContext {
  /** Absolute paths of the workspace folders. Nothing outside them may be touched. */
  workspaceFolders: string[];
  scriptWhitelist: ScriptWhitelistEntry[];
  logger: StoreLogger;
  runId: string;
  findFiles?: FileFinder;
  runProcess?: ProcessRunner;
  /** Set when the run was cancelled; long operations check it. */
  isCancelled?: () => boolean;
}

export interface ToolOutput {
  content: string;
  truncated: boolean;
  meta?: Record<string, unknown>;
}

export type PermissionResult = { allowed: true } | { allowed: false; reason: string };

export class ToolInputError extends Error {
  readonly code = 'tool.badInput';

  constructor(message: string) {
    super(message);
    this.name = 'ToolInputError';
  }
}

/**
 * One thing the model may ask for.
 *
 * Everything a tool needs to exist is in this object: its schema, how to validate an input,
 * whether a given input is allowed, and what it does. Adding a tool is therefore one file plus
 * one line in the registry, which is the property `CONTRIBUTING.md` promises.
 */
export interface RoundsTool<TInput = unknown> {
  name: string;
  /** English. The model reads this, and so does the user in the wizard. */
  description: string;
  inputSchema: Record<string, unknown>;
  parseInput(raw: unknown): TInput;
  checkPermission(input: TInput, context: ToolContext): PermissionResult;
  execute(input: TInput, context: ToolContext): Promise<ToolOutput>;
}

/** Shape the editor's language model API expects for a declared tool. */
export interface ChatToolDeclaration {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallOutcome {
  /** What is fed back to the model, whether the call succeeded, was denied or failed. */
  content: string;
  record: ToolCallRecord;
}

/** Keeps the input summary in the audit trail short and free of anything sensitive. */
export function summarizeInput(raw: unknown, limit = 200): string {
  let text: string;
  try {
    text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  } catch {
    text = String(raw);
  }
  text = (text ?? '').replace(/\s+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RoundsTool<never>>();

  register<TInput>(tool: RoundsTool<TInput>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`A tool named "${tool.name}" is already registered.`);
    }
    this.tools.set(tool.name, tool as unknown as RoundsTool<never>);
  }

  get(name: string): RoundsTool<never> | undefined {
    return this.tools.get(name);
  }

  list(): RoundsTool<never>[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Declarations for the tools an agent enabled, in the shape the model API wants. */
  toChatTools(enabled: readonly string[]): ChatToolDeclaration[] {
    return enabled
      .map((name) => this.tools.get(name))
      .filter((tool): tool is RoundsTool<never> => tool !== undefined)
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
  }

  /**
   * Runs one call and records it.
   *
   * Nothing here throws. A bad input, a denial or a crash inside a tool all come back as text
   * for the model plus an audit record, because the model has to be able to react: "that path
   * is outside the workspace" is information it can use, an exception is not.
   */
  async invoke(name: string, raw: unknown, context: ToolContext): Promise<ToolCallOutcome> {
    const started = Date.now();
    const inputSummary = summarizeInput(raw);
    const tool = this.tools.get(name);

    if (!tool) {
      return this.outcome(name, inputSummary, started, {
        allowed: false,
        content: `There is no tool named "${name}". Available tools: ${this.names().join(', ') || 'none'}.`,
        error: 'unknown tool',
      });
    }

    let input: never;
    try {
      input = tool.parseInput(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.outcome(name, inputSummary, started, {
        allowed: true,
        content: `The input for "${name}" was rejected: ${message}`,
        error: message,
      });
    }

    const permission = tool.checkPermission(input, context);
    if (!permission.allowed) {
      context.logger.info(`Tool ${name} was denied: ${permission.reason}`);
      return this.outcome(name, inputSummary, started, {
        allowed: false,
        content: `The tool "${name}" was not allowed to run: ${permission.reason}`,
      });
    }

    try {
      const output = await tool.execute(input, context);
      return this.outcome(name, inputSummary, started, {
        allowed: true,
        content: output.content,
        truncated: output.truncated,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.logger.warn(`Tool ${name} failed: ${message}`);
      return this.outcome(name, inputSummary, started, {
        allowed: true,
        content: `The tool "${name}" failed: ${message}`,
        error: message,
      });
    }
  }

  private outcome(
    name: string,
    inputSummary: string,
    started: number,
    result: { allowed: boolean; content: string; truncated?: boolean; error?: string },
  ): ToolCallOutcome {
    return {
      content: result.content,
      record: {
        name,
        inputSummary,
        allowed: result.allowed,
        durationMs: Date.now() - started,
        outputBytes: Buffer.byteLength(result.content, 'utf8'),
        truncated: result.truncated ?? false,
        error: result.error,
      },
    };
  }
}
