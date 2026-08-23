import { mkdir, rename, stat, writeFile as writeFileToDisk } from 'node:fs/promises';
import { dirname, relative } from 'node:path';

import { isDenied, resolveWritePath } from './paths.js';
import { ToolInputError } from './registry.js';
import type { PermissionResult, RoundsTool, ToolContext, ToolOutput } from './registry.js';

/** As much as one call may write. The same ceiling `readFile` has, for the same reason. */
export const MAX_WRITE_BYTES = 200_000;

/**
 * Places a write is refused even inside a trusted workspace.
 *
 * These directories are executable configuration rather than content. A `tasks.json` can be set
 * to run when the folder is opened, and a workflow file runs on somebody else's machine after a
 * push. A model writing there would step around the script whitelist entirely, which is the one
 * gate the user configured by hand.
 */
export const WRITE_DENIED_PATTERNS = [
  /(^|[/\\])\.vscode([/\\]|$)/i,
  /(^|[/\\])\.github[/\\]workflows([/\\]|$)/i,
  /(^|[/\\])\.git([/\\]|$)/i,
];

export interface WriteFileInput {
  path: string;
  content: string;
  /** Replace a file that is already there. Absent means no. */
  overwrite?: boolean;
}

export interface WriteFileDependencies {
  writeFileImpl?: (path: string, content: string) => Promise<void>;
  mkdirImpl?: (path: string) => Promise<void>;
  statImpl?: (path: string) => Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  renameImpl?: (from: string, to: string) => Promise<void>;
  realpathImpl?: (path: string) => Promise<string>;
}

/** True when writing here is refused whatever the workspace says. */
export function isWriteDenied(path: string): boolean {
  return isDenied(path) || WRITE_DENIED_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Writes a text file into the workspace.
 *
 * A run that has something to produce should be able to produce it. Without this the model puts
 * everything it made into one answer, the whole thing lands in the result file, and the four files
 * it was asked for do not exist.
 *
 * The limits are the ones that keep an accident from becoming a loss: inside the workspace only,
 * never over the paths the tools already refuse to open, never in `.vscode` or a workflow folder,
 * not over an existing file unless the call says so, and not at all in an untrusted workspace.
 */
export function createWriteFileTool(
  dependencies: WriteFileDependencies = {},
): RoundsTool<WriteFileInput> {
  const writeImpl =
    dependencies.writeFileImpl ?? ((path, content) => writeFileToDisk(path, content, 'utf8'));
  const mkdirImpl =
    dependencies.mkdirImpl ?? ((path) => mkdir(path, { recursive: true }).then(() => undefined));
  const statImpl = dependencies.statImpl ?? ((path) => stat(path));
  const renameImpl = dependencies.renameImpl ?? ((from, to) => rename(from, to));

  return {
    name: 'writeFile',
    description:
      'Write a UTF-8 text file into the open workspace, creating the folders it needs. The path may be relative to a workspace folder. Set overwrite to true to replace a file that already exists. Paths outside the workspace, .vscode, workflow folders and content larger than 200 KB are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the file to write, relative to a workspace folder.',
        },
        content: {
          type: 'string',
          description: 'The full text of the file.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Replace the file if it already exists. Defaults to false.',
        },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },

    parseInput(raw: unknown): WriteFileInput {
      if (typeof raw !== 'object' || raw === null) {
        throw new ToolInputError('Pass an object with "path" and "content" properties.');
      }
      const { path, content, overwrite } = raw as {
        path?: unknown;
        content?: unknown;
        overwrite?: unknown;
      };
      if (typeof path !== 'string' || path.trim().length === 0) {
        throw new ToolInputError('"path" must be a non-empty string.');
      }
      // An empty file is a legitimate thing to write, so only the type is checked.
      if (typeof content !== 'string') {
        throw new ToolInputError('"content" must be a string holding the whole file.');
      }
      const input: WriteFileInput = { path, content };
      if (typeof overwrite === 'boolean') {
        input.overwrite = overwrite;
      }
      return input;
    },

    checkPermission(input: WriteFileInput, context: ToolContext): PermissionResult {
      if (context.workspaceFolders.length === 0) {
        return { allowed: false, reason: 'no workspace is open, so there is nowhere to write' };
      }
      // Opening a repository must not be enough to let a scheduled run put files in it. This is
      // the same gate `runScript` stands behind, and for the same reason: a written file can be
      // executable configuration.
      if (context.workspaceTrusted === false) {
        return {
          allowed: false,
          reason:
            'this workspace is not trusted, so nothing may be written. Trust it (Workspaces: Manage Workspace Trust) or take writeFile off this agent',
        };
      }
      if (isWriteDenied(input.path)) {
        return { allowed: false, reason: `${input.path} is on the list of paths Rounds never writes` };
      }
      const bytes = Buffer.byteLength(input.content, 'utf8');
      if (bytes > MAX_WRITE_BYTES) {
        return {
          allowed: false,
          reason: `the content is ${bytes} bytes, larger than the ${MAX_WRITE_BYTES} byte limit; write it in several smaller files`,
        };
      }
      return { allowed: true };
    },

    async execute(input: WriteFileInput, context: ToolContext): Promise<ToolOutput> {
      const resolved = await resolveWritePath(
        input.path,
        context.workspaceFolders,
        dependencies.realpathImpl,
      );
      if (!resolved.ok) {
        return { content: `Refused: ${resolved.reason}.`, truncated: false };
      }
      // The resolved path is checked too: a link inside the workspace pointing at `.vscode` is
      // exactly the case the pattern list exists for.
      if (isWriteDenied(resolved.path)) {
        return {
          content: `Refused: ${input.path} resolves to a path Rounds never writes.`,
          truncated: false,
        };
      }

      const existing = await statImpl(resolved.path).catch(() => undefined);
      if (existing?.isDirectory()) {
        return { content: `${input.path} is a folder, so nothing was written.`, truncated: false };
      }
      if (existing && !input.overwrite) {
        return {
          content: `${input.path} already exists. Pass overwrite: true to replace it, or write to a different path.`,
          truncated: false,
        };
      }

      await mkdirImpl(dirname(resolved.path));
      // Written beside the target and moved into place, so an interrupted run leaves the previous
      // file intact rather than half of the new one.
      const temporary = `${resolved.path}.rounds-${context.runId}.tmp`;
      await writeImpl(temporary, input.content);
      try {
        await renameImpl(temporary, resolved.path);
      } catch (error) {
        return {
          content: `${input.path} could not be written: ${error instanceof Error ? error.message : String(error)}`,
          truncated: false,
        };
      }

      const bytes = Buffer.byteLength(input.content, 'utf8');
      const relativePath =
        context.workspaceFolders
          .map((folder) => relative(folder, resolved.path))
          .find((candidate) => !candidate.startsWith('..')) ?? input.path;
      context.logger.info(
        `writeFile ${existing ? 'replaced' : 'created'} ${relativePath} (${bytes} bytes).`,
      );
      return {
        content: `${existing ? 'Replaced' : 'Wrote'} ${relativePath} (${bytes} bytes).`,
        truncated: false,
        meta: { path: relativePath, bytes, replaced: Boolean(existing) },
      };
    },
  };
}
