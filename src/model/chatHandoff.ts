import * as vscode from 'vscode';

/**
 * Hands a prompt to the built-in chat instead of calling the model directly.
 *
 * `isPartialQuery: true` puts the text in the input box without sending it, which is the point
 * of this mode: the user reviews the prompt, edits it if they like, and sends it themselves. The
 * consequence is that the extension never sees the answer, so a chat-mode run records only that
 * the handoff happened — and every place that shows such a run has to say so.
 */
export async function handOffToChat(prompt: string): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.chat.open', {
    query: prompt,
    isPartialQuery: true,
  });
}
