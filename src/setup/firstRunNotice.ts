import * as vscode from 'vscode';

import type { RoundsStore } from '../state/store.js';

const MESSAGE =
  'Rounds runs recurring agents that collect data from your tracker or repository host and send it through a prompt. Agents run only while this editor is open.';

/**
 * Tells the user, once, that the extension is there and how to set it up.
 *
 * Deliberately a plain notification with a button rather than anything that resolves models:
 * the consent prompt must come from something the user asked for. A user who dismisses this
 * never sees it again.
 */
export async function showFirstRunNotice(store: RoundsStore): Promise<void> {
  const state = await store.read();
  if (state.setup.firstRunNoticeShownAt !== undefined) {
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    MESSAGE,
    'Check Setup',
    "Don't show again",
  );

  // Recorded whatever the answer was, including dismissal: asking again on every start
  // would be worse than never asking.
  await store.update((draft) => {
    draft.setup.firstRunNoticeShownAt = new Date().toISOString();
  });

  if (choice === 'Check Setup') {
    await vscode.commands.executeCommand('rounds.checkSetup');
  }
}
