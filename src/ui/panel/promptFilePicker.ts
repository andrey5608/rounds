import * as vscode from 'vscode';

import { createVscodeFileFinder } from '../../tools/vscodeFileFinder.js';
import { describeCandidate, discoverPromptFiles } from '../wizard/promptFiles.js';
import type { PromptFileCandidate } from '../wizard/promptFiles.js';

/**
 * Offers the prompt files the workspace already has, with Browse… still available.
 *
 * Typing or hunting for a path was the whole interaction before; a repository that keeps its
 * prompts in `.github/prompts` should not make somebody find them again by hand.
 */
export async function pickPromptFile(): Promise<string | undefined> {
  const candidates = await discoverPromptFiles(createVscodeFileFinder());
  const browse = { label: '$(folder-opened) Browse…', detail: 'Choose any file on disk', browse: true };
  const items: (vscode.QuickPickItem & { candidate?: PromptFileCandidate; browse?: boolean })[] = [
    ...candidates.map((candidate) => {
      const described = describeCandidate(candidate);
      return { label: described.label, detail: described.detail, candidate };
    }),
    browse,
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: candidates.length > 0 ? 'Prompt file' : 'No prompt files found in the workspace',
    placeHolder: 'Files under .github/prompts come first',
    ignoreFocusOut: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.candidate) {
    const [folder] = vscode.workspace.workspaceFolders ?? [];
    return folder
      ? vscode.Uri.joinPath(folder.uri, picked.candidate.path).fsPath
      : picked.candidate.path;
  }

  const chosen = await vscode.window.showOpenDialog({
    title: 'Choose the prompt file',
    canSelectMany: false,
    filters: { Markdown: ['md', 'txt', 'prompt'] },
  });
  return chosen?.[0]?.fsPath;
}

