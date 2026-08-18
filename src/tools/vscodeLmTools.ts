import * as vscode from 'vscode';

import { BUILT_IN_TOOL_NAMES, toExternalTool } from './externalTools.js';
import type { ExternalTool, ExternalToolInfo, ExternalToolResult } from './externalTools.js';

/**
 * What the editor reports right now.
 *
 * Read when it is needed rather than cached at activation: extensions are installed, enabled and
 * disabled while a window is open, and a stale list offers the model a tool that is not there.
 *
 * A tool whose name collides with one of ours is skipped. Ours carry permission checks written
 * against this extension's promises — the workspace boundary, the script whitelist — and letting
 * another extension take the name over is how a whitelist stops meaning anything.
 */
export function listExternalTools(): ExternalToolInfo[] {
  const ours = new Set<string>(BUILT_IN_TOOL_NAMES);
  return vscode.lm.tools
    .filter((tool) => !ours.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: (tool.inputSchema ?? undefined) as Record<string, unknown> | undefined,
      tags: tool.tags,
    }));
}

/** The tools the editor reports, in the shape the registry holds. */
export function createExternalTools(): ExternalTool[] {
  return listExternalTools().map((info) => toExternalTool(info, invokeExternalTool));
}

/**
 * Calls a tool through the editor.
 *
 * `toolInvocationToken` is `undefined` because this is not a chat request. A tool that needs the
 * chat context rejects the call, and that rejection travels back to the model as a failed tool
 * call — which the loop already knows how to carry on from.
 */
async function invokeExternalTool(
  name: string,
  input: unknown,
  signal: { isCancelled: () => boolean },
): Promise<ExternalToolResult> {
  const cancellation = new vscode.CancellationTokenSource();
  const poll = setInterval(() => {
    if (signal.isCancelled()) {
      cancellation.cancel();
    }
  }, 250);

  try {
    const result = await vscode.lm.invokeTool(
      name,
      { input: input as object, toolInvocationToken: undefined },
      cancellation.token,
    );
    return readResult(result);
  } finally {
    clearInterval(poll);
    cancellation.dispose();
  }
}

/**
 * Reads the text out of a tool result.
 *
 * A result is an array of parts, and one of the shapes is `prompt-tsx`, which only means anything
 * to a caller that renders it. Those are counted rather than guessed at, so the model is told
 * something was left out instead of quietly receiving less than the tool sent.
 */
export function readResult(result: vscode.LanguageModelToolResult): ExternalToolResult {
  const text: string[] = [];
  let hadUnreadableParts = false;

  for (const part of result.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      text.push(part.value);
      continue;
    }
    // Structural fallback, for the same reason the model gateway has one: a part may come from
    // another copy of the API types, where `instanceof` is false for something that is a text
    // part in every way that matters.
    const candidate = part as { value?: unknown };
    if (typeof candidate?.value === 'string') {
      text.push(candidate.value);
    } else {
      hadUnreadableParts = true;
    }
  }

  return { text: text.join('\n'), hadUnreadableParts };
}
