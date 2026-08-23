import { readFile as readFileFromDisk, stat } from 'node:fs/promises';

import { MAX_FILE_BYTES, looksBinary } from './readFile.js';
import { isDenied, resolveWorkspacePath } from './paths.js';
import { ToolInputError } from './registry.js';
import type { PermissionResult, RoundsTool, ToolContext, ToolOutput } from './registry.js';

/** How many files one search opens. Beyond this the answer is a narrower pattern, not more reading. */
export const MAX_FILES_SEARCHED = 300;
/** How many matching lines come back. */
export const MAX_MATCHES = 60;
/** A matching line is quoted up to here; a minified file would otherwise fill the whole answer. */
export const MAX_LINE_LENGTH = 300;
/** A search that has run this long stops and says so, rather than holding up the run. */
export const SEARCH_BUDGET_MS = 10_000;

export interface SearchTextInput {
  pattern: string;
  globPattern?: string;
  isRegex?: boolean;
  caseSensitive?: boolean;
}

export interface SearchTextDependencies {
  readFileImpl?: (path: string) => Promise<Buffer>;
  statImpl?: (path: string) => Promise<{ size: number; isFile(): boolean }>;
  realpathImpl?: (path: string) => Promise<string>;
  now?: () => number;
}

/** A literal pattern as a regular expression that means exactly itself. */
export function escapeRegex(pattern: string): string {
  return pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Searches the text of the workspace.
 *
 * Without it "where is X mentioned" costs one `readFile` per candidate, and a run spends its rounds
 * opening files instead of answering. One search replaces that.
 *
 * It reads through the editor's own file search, so the user's exclude settings apply, and it keeps
 * the same refusals `readFile` has: nothing outside the workspace, nothing on the deny list, no
 * binaries, no enormous files.
 */
export function createSearchTextTool(
  dependencies: SearchTextDependencies = {},
): RoundsTool<SearchTextInput> {
  const readImpl = dependencies.readFileImpl ?? ((path) => readFileFromDisk(path));
  const statImpl = dependencies.statImpl ?? ((path) => stat(path));
  const now = dependencies.now ?? (() => Date.now());

  return {
    name: 'searchText',
    description:
      'Search the text of files in the open workspace and return matching lines as path:line: text. Narrow it with a glob pattern, for example src/**/*.ts. The pattern is literal text unless isRegex is true. At most 60 matches from 300 files come back, so a pattern that matches everything answers nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'The text to look for.',
        },
        globPattern: {
          type: 'string',
          description: 'Which files to search, for example src/**/*.ts. Defaults to every file.',
        },
        isRegex: {
          type: 'boolean',
          description: 'Read the pattern as a regular expression. Defaults to false.',
        },
        caseSensitive: {
          type: 'boolean',
          description: 'Match upper and lower case exactly. Defaults to false.',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },

    parseInput(raw: unknown): SearchTextInput {
      if (typeof raw !== 'object' || raw === null) {
        throw new ToolInputError('Pass an object with a "pattern" property.');
      }
      const { pattern, globPattern, isRegex, caseSensitive } = raw as {
        pattern?: unknown;
        globPattern?: unknown;
        isRegex?: unknown;
        caseSensitive?: unknown;
      };
      if (typeof pattern !== 'string' || pattern.trim().length === 0) {
        throw new ToolInputError('"pattern" must be a non-empty string.');
      }
      const input: SearchTextInput = { pattern };
      if (typeof globPattern === 'string' && globPattern.trim().length > 0) {
        input.globPattern = globPattern.trim();
      }
      if (typeof isRegex === 'boolean') {
        input.isRegex = isRegex;
      }
      if (typeof caseSensitive === 'boolean') {
        input.caseSensitive = caseSensitive;
      }
      return input;
    },

    checkPermission(input: SearchTextInput, context: ToolContext): PermissionResult {
      if (context.workspaceFolders.length === 0) {
        return { allowed: false, reason: 'no workspace is open, so there is nothing to search' };
      }
      if (!context.findFiles) {
        return { allowed: false, reason: 'file search is not available in this window' };
      }
      const glob = input.globPattern;
      if (glob && (glob.startsWith('/') || glob.includes('..'))) {
        return {
          allowed: false,
          reason: 'the glob pattern must stay inside the workspace, so it may not be absolute or contain ".."',
        };
      }
      if (input.isRegex) {
        try {
          new RegExp(input.pattern);
        } catch (error) {
          return {
            allowed: false,
            reason: `that is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
      return { allowed: true };
    },

    async execute(input: SearchTextInput, context: ToolContext): Promise<ToolOutput> {
      const glob = input.globPattern ?? '**/*';
      const found = (await context.findFiles?.(glob, MAX_FILES_SEARCHED + 1)) ?? [];
      const candidates = found.filter((path) => !isDenied(path));
      const expression = new RegExp(
        input.isRegex ? input.pattern : escapeRegex(input.pattern),
        input.caseSensitive ? '' : 'i',
      );

      const matches: string[] = [];
      const deadline = now() + SEARCH_BUDGET_MS;
      let searched = 0;
      let stopped: 'matches' | 'files' | 'time' | undefined =
        found.length > MAX_FILES_SEARCHED ? 'files' : undefined;

      for (const path of candidates.slice(0, MAX_FILES_SEARCHED)) {
        if (context.isCancelled?.()) {
          break;
        }
        if (now() > deadline) {
          stopped = 'time';
          break;
        }

        const resolved = await resolveWorkspacePath(
          path,
          context.workspaceFolders,
          dependencies.realpathImpl,
        );
        if (!resolved.ok) {
          continue;
        }
        const info = await statImpl(resolved.path).catch(() => undefined);
        if (!info?.isFile() || info.size > MAX_FILE_BYTES) {
          continue;
        }
        const buffer = await readImpl(resolved.path).catch(() => undefined);
        if (!buffer || looksBinary(buffer)) {
          continue;
        }
        searched += 1;

        const lines = buffer.toString('utf8').split(/\r?\n/);
        for (const [index, line] of lines.entries()) {
          // Long lines are cut before matching as well as before quoting: a minified bundle is one
          // line of a megabyte, and a regular expression is entitled to be slow on it.
          const text = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) : line;
          if (!expression.test(text)) {
            continue;
          }
          matches.push(`${path}:${index + 1}: ${text.trim()}`);
          if (matches.length >= MAX_MATCHES) {
            stopped = 'matches';
            break;
          }
        }
        if (stopped === 'matches') {
          break;
        }
      }

      const note =
        stopped === 'matches'
          ? `[stopped at ${MAX_MATCHES} matches; narrow the pattern or the glob to see the rest]`
          : stopped === 'files'
            ? `[searched the first ${MAX_FILES_SEARCHED} files under ${glob}; narrow the glob to cover the rest]`
            : stopped === 'time'
              ? `[stopped after ${searched} file(s): the search ran out of time, so this is not the whole workspace]`
              : '';

      if (matches.length === 0) {
        // A search that stopped early found nothing *yet*. Saying "nothing matched" would be read
        // as "it is not there", and the model would go on to answer a question it did not check.
        return {
          content: note
            ? `Nothing matched ${input.pattern} in the ${searched} file(s) searched under ${glob}.\n\n${note}`
            : `Nothing matched ${input.pattern} in ${searched} file(s) under ${glob}.`,
          truncated: stopped !== undefined,
          meta: { matches: 0, filesSearched: searched },
        };
      }

      return {
        content: note ? `${matches.join('\n')}\n\n${note}` : matches.join('\n'),
        truncated: stopped !== undefined,
        meta: { matches: matches.length, filesSearched: searched },
      };
    },
  };
}
