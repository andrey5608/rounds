import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

import { truncate } from '../agents/truncate.js';
import type { ScriptWhitelistEntry } from '../state/settings.js';

import { isInside } from './paths.js';
import { ToolInputError } from './registry.js';
import type {
  PermissionResult,
  ProcessResult,
  ProcessRunner,
  RoundsTool,
  ToolContext,
  ToolOutput,
} from './registry.js';

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_CHARS = 100_000;

/** Environment variables never passed to a spawned command. */
const SENSITIVE_ENV = /token|secret|password|passwd|key|credential/i;

export interface RunScriptInput {
  command: string;
  args: string[];
  cwd?: string;
}

/**
 * Checks one argument against one pattern.
 *
 * A pattern may end in `*` to allow any suffix, which covers the common case of a fixed
 * subcommand with a free argument (`run *`). Everything else must match exactly, because a
 * whitelist that quietly accepts more than it says is not a whitelist.
 */
export function argumentMatches(pattern: string, argument: string): boolean {
  if (pattern.endsWith('*')) {
    return argument.startsWith(pattern.slice(0, -1));
  }
  return pattern === argument;
}

/** Decides whether a command line is allowed by an entry. */
export function entryAllows(entry: ScriptWhitelistEntry, input: RunScriptInput): boolean {
  if (entry.command !== input.command) {
    return false;
  }
  const patterns = entry.args ?? [];
  // Arguments are matched pairwise: the entry describes exactly what may be passed, so extra
  // arguments are never silently accepted.
  if (input.args.length !== patterns.length) {
    return false;
  }
  return patterns.every((pattern, index) => argumentMatches(pattern, input.args[index] ?? ''));
}

/** The entry that allows this command, if any. */
export function findWhitelistEntry(
  whitelist: readonly ScriptWhitelistEntry[],
  input: RunScriptInput,
): ScriptWhitelistEntry | undefined {
  return whitelist.find((entry) => entryAllows(entry, input));
}

/** Copies the environment without anything that looks like a credential. */
export function scrubEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!SENSITIVE_ENV.test(key)) {
      result[key] = value;
    }
  }
  return result;
}

/** Spawns a process without a shell and collects its output. */
export const nodeProcessRunner: ProcessRunner = (options) =>
  new Promise<ProcessResult>((resolveResult) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      // Never a shell: with `shell: true`, an argument containing `;` or `&&` becomes another
      // command, and the whitelist would only be describing the first one.
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolveResult({ code: null, signal: null, stdout, stderr: `${stderr}${String(error)}`, timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolveResult({ code, signal, stdout, stderr, timedOut });
    });
  });

/**
 * Runs a command from the user's whitelist.
 *
 * This is the only tool that changes anything outside the editor, so it is the strictest: the
 * command has to be listed with its arguments, no shell is involved, the working directory has
 * to be inside the workspace, and the environment is stripped of anything that looks like a
 * credential. An empty whitelist means the tool refuses everything, which is the correct
 * default for a feature that executes code.
 */
export function createRunScriptTool(): RoundsTool<RunScriptInput> {
  return {
    name: 'runScript',
    description:
      'Run one of the commands the user has explicitly allowed, with its arguments, inside the workspace. Commands that are not on the list are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Executable name, exactly as whitelisted.' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments to pass. Must match the whitelisted pattern.',
        },
        cwd: {
          type: 'string',
          description: 'Working directory inside the workspace. Defaults to the first workspace folder.',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },

    parseInput(raw: unknown): RunScriptInput {
      if (typeof raw !== 'object' || raw === null) {
        throw new ToolInputError('Pass an object with a "command" property.');
      }
      const value = raw as { command?: unknown; args?: unknown; cwd?: unknown };
      if (typeof value.command !== 'string' || value.command.trim().length === 0) {
        throw new ToolInputError('"command" must be a non-empty string.');
      }
      if (value.args !== undefined && !Array.isArray(value.args)) {
        throw new ToolInputError('"args" must be an array of strings.');
      }
      const args = (value.args ?? []).map((argument) => {
        if (typeof argument !== 'string') {
          throw new ToolInputError('"args" must contain strings only.');
        }
        return argument;
      });
      if (value.cwd !== undefined && typeof value.cwd !== 'string') {
        throw new ToolInputError('"cwd" must be a string.');
      }
      return { command: value.command.trim(), args, cwd: value.cwd };
    },

    checkPermission(input: RunScriptInput, context: ToolContext): PermissionResult {
      if (context.workspaceFolders.length === 0) {
        return { allowed: false, reason: 'no workspace is open, so there is nowhere to run a command' };
      }
      // Opening a repository must not be enough to make it run commands. Workspace trust is the
      // editor's mechanism for exactly this, and the denial names both ways out because
      // "not permitted" without a next step is where support requests come from.
      if (context.workspaceTrusted === false) {
        return {
          allowed: false,
          reason:
            'this workspace is not trusted, so no command may run. Trust it (Workspaces: Manage Workspace Trust) or take runScript off this agent',
        };
      }
      if (context.scriptWhitelist.length === 0) {
        return {
          allowed: false,
          reason:
            'the script whitelist is empty, so no command may run. The user has to add commands to rounds.scriptWhitelist first',
        };
      }
      if (!findWhitelistEntry(context.scriptWhitelist, input)) {
        const allowed = context.scriptWhitelist
          .map((entry) => [entry.command, ...(entry.args ?? [])].join(' '))
          .join('; ');
        return {
          allowed: false,
          reason: `"${[input.command, ...input.args].join(' ')}" is not on the whitelist. Allowed: ${allowed}`,
        };
      }

      const cwd = resolveCwd(input, context);
      if (!cwd) {
        return { allowed: false, reason: 'the working directory must be inside the workspace' };
      }
      return { allowed: true };
    },

    async execute(input: RunScriptInput, context: ToolContext): Promise<ToolOutput> {
      const cwd = resolveCwd(input, context);
      if (!cwd) {
        return { content: 'Refused: the working directory must be inside the workspace.', truncated: false };
      }
      const runner = context.runProcess ?? nodeProcessRunner;
      const result = await runner({
        command: input.command,
        args: input.args,
        cwd,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        env: scrubEnvironment(process.env),
      });

      const stdout = truncate(result.stdout.trim(), MAX_OUTPUT_CHARS);
      const stderr = truncate(result.stderr.trim(), MAX_OUTPUT_CHARS);
      const status = result.timedOut
        ? `timed out after ${DEFAULT_TIMEOUT_MS / 1000}s and was killed`
        : `exited with code ${result.code ?? 'unknown'}${result.signal ? ` (signal ${result.signal})` : ''}`;

      const sections = [`${[input.command, ...input.args].join(' ')} ${status}.`];
      if (stdout.text.length > 0) {
        sections.push(`stdout:\n${stdout.text}`);
      }
      if (stderr.text.length > 0) {
        sections.push(`stderr:\n${stderr.text}`);
      }

      return {
        content: sections.join('\n\n'),
        truncated: stdout.truncated || stderr.truncated,
        meta: { exitCode: result.code, timedOut: result.timedOut },
      };
    },
  };
}

/** Working directory for the command, or `undefined` when it would leave the workspace. */
function resolveCwd(input: RunScriptInput, context: ToolContext): string | undefined {
  const first = context.workspaceFolders[0];
  if (!first) {
    return undefined;
  }
  if (!input.cwd) {
    return first;
  }
  const candidate = resolve(first, input.cwd);
  return context.workspaceFolders.some((folder) => isInside(folder, candidate))
    ? candidate
    : undefined;
}
