import { truncateList } from '../agents/truncate.js';

import { isDenied } from './paths.js';
import { ToolInputError } from './registry.js';
import type { PermissionResult, RoundsTool, ToolContext, ToolOutput } from './registry.js';

export const MAX_RESULTS = 200;

export interface ListFilesInput {
  globPattern: string;
}

/**
 * Lists files in the workspace.
 *
 * The search itself is delegated to the editor through `ToolContext.findFiles`, which brings
 * the user's own exclude settings along and keeps this file testable without an extension
 * host. Results stay workspace-relative: an absolute host path tells the model where somebody's
 * home directory is, and it has no use for that.
 */
export function createListFilesTool(): RoundsTool<ListFilesInput> {
  return {
    name: 'listFiles',
    description:
      'List files in the open workspace matching a glob pattern, for example src/**/*.ts. Returns workspace-relative paths, at most 200 of them.',
    inputSchema: {
      type: 'object',
      properties: {
        globPattern: {
          type: 'string',
          description: 'Glob pattern relative to the workspace, for example **/*.md.',
        },
      },
      required: ['globPattern'],
      additionalProperties: false,
    },

    parseInput(raw: unknown): ListFilesInput {
      if (typeof raw !== 'object' || raw === null) {
        throw new ToolInputError('Pass an object with a "globPattern" property.');
      }
      const globPattern = (raw as { globPattern?: unknown }).globPattern;
      if (typeof globPattern !== 'string' || globPattern.trim().length === 0) {
        throw new ToolInputError('"globPattern" must be a non-empty string.');
      }
      return { globPattern: globPattern.trim() };
    },

    checkPermission(input: ListFilesInput, context: ToolContext): PermissionResult {
      if (context.workspaceFolders.length === 0) {
        return { allowed: false, reason: 'no workspace is open, so there are no files to list' };
      }
      if (!context.findFiles) {
        return { allowed: false, reason: 'file search is not available in this window' };
      }
      if (input.globPattern.startsWith('/') || input.globPattern.includes('..')) {
        return {
          allowed: false,
          reason: 'the pattern must stay inside the workspace, so it may not be absolute or contain ".."',
        };
      }
      return { allowed: true };
    },

    async execute(input: ListFilesInput, context: ToolContext): Promise<ToolOutput> {
      const found = await context.findFiles?.(input.globPattern, MAX_RESULTS + 1);
      const allowed = (found ?? []).filter((path) => !isDenied(path));
      const { items, truncated } = truncateList(allowed, MAX_RESULTS);

      if (items.length === 0) {
        return { content: `No files match ${input.globPattern}.`, truncated: false };
      }
      const listed = items.map((path) => `- ${path}`).join('\n');
      return {
        content: truncated
          ? `${listed}\n\n[truncated: ${items.length} of ${allowed.length} matches shown]`
          : listed,
        truncated,
        meta: { matches: items.length },
      };
    },
  };
}
