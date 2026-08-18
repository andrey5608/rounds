import * as vscode from 'vscode';

/** What the chat should open with, beyond the text itself. */
export interface ChatHandoffOptions {
  /** The model the agent is pinned to, so the chat does not open with whatever was used last. */
  modelId?: string;
}

/**
 * Hands a prompt to the built-in chat instead of calling the model directly.
 *
 * `isPartialQuery: true` puts the text in the input box without sending it, which is the point
 * of this mode: the user reviews the prompt, edits it if they like, and sends it themselves. The
 * consequence is that the extension never sees the answer, so a chat-mode run records only that
 * the handoff happened — and every place that shows such a run has to say so.
 *
 * The model is passed as a best-effort extra. `workbench.action.chat.open` is a built-in command
 * whose option shape is not part of the published API, so an editor build that does not know the
 * field ignores it, and one that rejects the whole call gets a second attempt without it. Either
 * way the handoff itself succeeds, and an option the editor ignored is not worth an error the
 * user has to read.
 */
export async function handOffToChat(
  prompt: string,
  options: ChatHandoffOptions = {},
): Promise<void> {
  const base = { query: prompt, isPartialQuery: true };
  if (options.modelId) {
    try {
      await vscode.commands.executeCommand('workbench.action.chat.open', {
        ...base,
        modelSelector: { id: options.modelId },
      });
      return;
    } catch {
      // Fall through: the model is a preference, the handoff is the job.
    }
  }
  await vscode.commands.executeCommand('workbench.action.chat.open', base);
}
