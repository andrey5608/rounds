import * as vscode from 'vscode';

import type { FileFinder } from './registry.js';

/**
 * File search backed by the editor.
 *
 * Using the editor's own search means the user's `files.exclude` and `search.exclude` settings
 * apply for free, so a tool listing files sees the same workspace the user does.
 */
export function createVscodeFileFinder(): FileFinder {
  return async (globPattern: string, limit: number) => {
    const found = await vscode.workspace.findFiles(globPattern, undefined, limit);
    return found.map((uri) => vscode.workspace.asRelativePath(uri, false));
  };
}
