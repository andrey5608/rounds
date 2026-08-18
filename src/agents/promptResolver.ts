import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import type { StoreLogger } from '../state/store.js';
import { systemClock } from '../state/time.js';
import type { Clock } from '../state/time.js';
import type { Agent, PromptFileFallback, PromptResolutionRecord } from '../state/types.js';

import { parsePromptFile } from './promptFrontMatter.js';

/** A prompt file larger than this is treated as unreadable rather than sent to a model. */
export const MAX_PROMPT_FILE_BYTES = 200_000;

export class PromptUnavailableError extends Error {
  constructor(
    readonly code: 'prompt.unavailable' | 'prompt.fileUnreadable' | 'prompt.empty',
    message: string,
  ) {
    super(message);
    this.name = 'PromptUnavailableError';
  }
}

export interface PromptResolution {
  text: string;
  usedSnapshot: boolean;
  path?: string;
  hash?: string;
  /** Set when the file was read successfully and its content differs from the snapshot. */
  refreshedSnapshot?: { content: string; hash: string; capturedAt: string };
  record: PromptResolutionRecord;
}

export interface PromptResolverOptions {
  /** First workspace folder, used to resolve a relative prompt path. */
  workspaceRoot?: string;
  /** Effective fallback when the agent does not override it. */
  defaultFallback: PromptFileFallback;
  clock?: Clock;
  logger?: StoreLogger;
  readFileImpl?: (path: string) => Promise<string>;
  statImpl?: (path: string) => Promise<{ size: number }>;
}

export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Produces the prompt text for a run.
 *
 * A file-based prompt has three ways to disappoint: the file is gone, it is unreadable, or it
 * is enormous. What happens then is the user's decision, not this function's, which is why the
 * fallback policy exists — some people want the last known good text, others would rather the
 * run stopped than have it run on a stale prompt.
 */
export class PromptResolver {
  private readonly clock: Clock;
  private readonly readFileImpl: (path: string) => Promise<string>;
  private readonly statImpl: (path: string) => Promise<{ size: number }>;

  constructor(private readonly options: PromptResolverOptions) {
    this.clock = options.clock ?? systemClock;
    this.readFileImpl = options.readFileImpl ?? ((path) => readFile(path, 'utf8'));
    this.statImpl = options.statImpl ?? ((path) => stat(path));
  }

  /** Absolute path of an agent's prompt file, resolved against the workspace when relative. */
  resolveFilePath(agent: Agent): string | undefined {
    const filePath = agent.prompt.filePath;
    if (!filePath) {
      return undefined;
    }
    if (isAbsolute(filePath)) {
      return filePath;
    }
    return this.options.workspaceRoot
      ? resolvePath(this.options.workspaceRoot, filePath)
      : resolvePath(filePath);
  }

  async resolve(agent: Agent): Promise<PromptResolution> {
    if (agent.prompt.source === 'inline') {
      const text = agent.prompt.inlineText ?? '';
      if (text.trim().length === 0) {
        throw new PromptUnavailableError(
          'prompt.empty',
          'This agent has an empty prompt. Edit the agent and write one.',
        );
      }
      return {
        text,
        usedSnapshot: false,
        record: { source: 'inline', usedSnapshot: false },
      };
    }

    const path = this.resolveFilePath(agent);
    if (!path) {
      throw new PromptUnavailableError(
        'prompt.unavailable',
        'This agent uses a prompt file but no path is stored. Edit the agent and choose the file again.',
      );
    }

    const fallback = agent.prompt.fallback ?? this.options.defaultFallback;
    const fileText = await this.tryReadFile(path);

    if (fileText !== undefined) {
      const hash = hashContent(fileText);
      const snapshotChanged = agent.prompt.snapshot?.hash !== hash;
      return {
        text: fileText,
        usedSnapshot: false,
        path,
        hash,
        refreshedSnapshot: snapshotChanged
          ? { content: fileText, hash, capturedAt: this.clock.now().toISOString() }
          : undefined,
        record: { source: 'file', path, usedSnapshot: false, hash },
      };
    }

    const snapshot = agent.prompt.snapshot;
    if (fallback === 'snapshot' && snapshot) {
      this.options.logger?.warn(
        `The prompt file ${path} could not be read; using the snapshot captured at ${snapshot.capturedAt}.`,
      );
      return {
        text: snapshot.content,
        usedSnapshot: true,
        path,
        hash: snapshot.hash,
        record: { source: 'file', path, usedSnapshot: true, hash: snapshot.hash },
      };
    }

    if (snapshot) {
      throw new PromptUnavailableError(
        'prompt.fileUnreadable',
        `The prompt file ${path} could not be read. This agent is configured to stop rather than run on the stored snapshot.`,
      );
    }
    throw new PromptUnavailableError(
      'prompt.unavailable',
      `The prompt file ${path} could not be read and no snapshot was ever stored. Edit the agent and choose a readable file.`,
    );
  }

  /**
   * Reads the file, or reports it as unreadable.
   *
   * "Unreadable" deliberately covers more than an error from the file system: an empty file
   * and an enormous one are both useless as a prompt, and finding that out here means the
   * fallback policy applies to them too.
   */
  private async tryReadFile(path: string): Promise<string | undefined> {
    try {
      const info = await this.statImpl(path);
      if (info.size > MAX_PROMPT_FILE_BYTES) {
        this.options.logger?.warn(
          `The prompt file ${path} is ${info.size} bytes, above the ${MAX_PROMPT_FILE_BYTES} byte limit.`,
        );
        return undefined;
      }
      const content = await this.readFileImpl(path);
      // A `.prompt.md` file opens with a YAML header addressed to the editor. Sending it to the
      // model asks it to read somebody else's instructions, so it is removed here — before the
      // snapshot is taken, so a stored snapshot is the prompt rather than the file.
      const parsed = parsePromptFile(content);
      if (parsed.frontMatter) {
        this.options.logger?.debug(
          `The prompt file ${path} carries a header; it was removed from the prompt.`,
        );
      }
      if (parsed.text.trim().length === 0) {
        this.options.logger?.warn(`The prompt file ${path} is empty.`);
        return undefined;
      }
      return parsed.text;
    } catch (error) {
      this.options.logger?.debug(`Could not read the prompt file ${path}: ${String(error)}`);
      return undefined;
    }
  }
}
