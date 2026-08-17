import { readFile as readFileFromDisk, stat } from 'node:fs/promises';
import { relative } from 'node:path';

import { truncate } from '../agents/truncate.js';

import { isDenied, resolveWorkspacePath } from './paths.js';
import { ToolInputError } from './registry.js';
import type { PermissionResult, RoundsTool, ToolContext, ToolOutput } from './registry.js';

export const MAX_FILE_BYTES = 200_000;

export interface ReadFileInput {
  path: string;
}

export interface ReadFileDependencies {
  readFileImpl?: (path: string) => Promise<Buffer>;
  statImpl?: (path: string) => Promise<{ size: number; isFile(): boolean }>;
  realpathImpl?: (path: string) => Promise<string>;
}

/** A NUL byte in the first kilobyte is the usual sign of a file that is not text. */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 1024).includes(0);
}

/**
 * Reads a file from the workspace.
 *
 * Refusals are worded for the model, not for a log: it has to be able to try something else, so
 * "outside the workspace" and "on the deny list" are different messages.
 */
export function createReadFileTool(dependencies: ReadFileDependencies = {}): RoundsTool<ReadFileInput> {
  const readImpl = dependencies.readFileImpl ?? ((path) => readFileFromDisk(path));
  const statImpl = dependencies.statImpl ?? ((path) => stat(path));

  return {
    name: 'readFile',
    description:
      'Read a UTF-8 text file from the open workspace. The path may be relative to a workspace folder. Files outside the workspace, binary files and files larger than 200 KB are refused.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path of the file, relative to a workspace folder or absolute inside it.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },

    parseInput(raw: unknown): ReadFileInput {
      if (typeof raw !== 'object' || raw === null) {
        throw new ToolInputError('Pass an object with a "path" property.');
      }
      const path = (raw as { path?: unknown }).path;
      if (typeof path !== 'string' || path.trim().length === 0) {
        throw new ToolInputError('"path" must be a non-empty string.');
      }
      return { path };
    },

    checkPermission(input: ReadFileInput, context: ToolContext): PermissionResult {
      if (context.workspaceFolders.length === 0) {
        return { allowed: false, reason: 'no workspace is open, so there are no files to read' };
      }
      if (isDenied(input.path)) {
        return { allowed: false, reason: `${input.path} is on the list of paths Rounds never opens` };
      }
      return { allowed: true };
    },

    async execute(input: ReadFileInput, context: ToolContext): Promise<ToolOutput> {
      const resolved = await resolveWorkspacePath(
        input.path,
        context.workspaceFolders,
        dependencies.realpathImpl,
      );
      if (!resolved.ok) {
        return { content: `Refused: ${resolved.reason}.`, truncated: false };
      }

      const info = await statImpl(resolved.path).catch(() => undefined);
      if (!info) {
        return { content: `There is no file at ${input.path}.`, truncated: false };
      }
      if (!info.isFile()) {
        return { content: `${input.path} is not a file.`, truncated: false };
      }
      if (info.size > MAX_FILE_BYTES) {
        return {
          content: `${input.path} is ${info.size} bytes, larger than the ${MAX_FILE_BYTES} byte limit. Read a smaller file or a specific part of it.`,
          truncated: false,
        };
      }

      const buffer = await readImpl(resolved.path);
      if (looksBinary(buffer)) {
        return { content: `${input.path} looks like a binary file, so it was not read.`, truncated: false };
      }

      const relativePath =
        context.workspaceFolders
          .map((folder) => relative(folder, resolved.path))
          .find((candidate) => !candidate.startsWith('..')) ?? input.path;
      const result = truncate(buffer.toString('utf8'), MAX_FILE_BYTES);
      return {
        content: `${relativePath}:\n${result.text}`,
        truncated: result.truncated,
        meta: { path: relativePath, bytes: info.size },
      };
    },
  };
}
