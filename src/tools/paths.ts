import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * File name patterns a tool must never open, however it was asked.
 *
 * A model deciding on its own to read `.env` is not malice, it is a model looking for
 * configuration. The deny list means it finds a refusal instead of a token.
 */
export const DENIED_PATTERNS = [
  /(^|[/\\])\.env(\..*)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|[/\\])id_(rsa|dsa|ecdsa|ed25519)$/i,
  /(^|[/\\])\.git([/\\]|$)/i,
  /(^|[/\\])node_modules([/\\]|$)/i,
  /(^|[/\\])\.ssh([/\\]|$)/i,
  /(^|[/\\])\.aws([/\\]|$)/i,
];

export type PathRejection =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/** True when `candidate` is inside `root` (or is `root` itself). */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** True when the path matches something the tools refuse to touch. */
export function isDenied(path: string): boolean {
  return DENIED_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Resolves a path a tool was given, or explains why it is refused.
 *
 * The real path is checked as well as the given one, so a symbolic link inside the workspace
 * cannot be used to read something outside it — which is the whole point of the check, since
 * `..` alone is easy to normalise away and easy to remember, and symlinks are neither.
 *
 * The workspace folders are resolved the same way before comparing. Without that, an entirely
 * ordinary file is refused on systems where a parent directory is itself a link: on macOS
 * `/var` is a link to `/private/var`, so every temporary folder would look like an escape.
 */
export async function resolveWorkspacePath(
  raw: string,
  workspaceFolders: string[],
  realpathImpl: (path: string) => Promise<string> = realpath,
): Promise<PathRejection> {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, reason: 'no path was given' };
  }
  if (workspaceFolders.length === 0) {
    return {
      ok: false,
      reason: 'there is no open workspace, so there is nothing this tool may read',
    };
  }
  if (raw.includes('\0')) {
    return { ok: false, reason: 'the path contains a null byte' };
  }

  const realRoots = await Promise.all(
    workspaceFolders.map(async (folder) => {
      try {
        return await realpathImpl(folder);
      } catch {
        return folder;
      }
    }),
  );
  const roots = [...new Set([...workspaceFolders, ...realRoots])];

  const candidates = isAbsolute(raw)
    ? [resolve(raw)]
    : workspaceFolders.map((folder) => resolve(folder, raw));

  // A relative path is tried against every workspace folder, so an existing file wins over a
  // path that merely could exist: with two folders open, the file is in one of them.
  let insideButMissing: string | undefined;

  for (const candidate of candidates) {
    if (!roots.some((folder) => isInside(folder, candidate))) {
      continue;
    }
    if (isDenied(candidate)) {
      return { ok: false, reason: `${raw} is on the list of paths Rounds never opens` };
    }

    let real: string;
    try {
      real = await realpathImpl(candidate);
    } catch {
      // The path does not exist yet, so it cannot be a link escape. The tool reports the
      // missing file itself, which reads better than a permission refusal.
      insideButMissing = insideButMissing ?? candidate;
      continue;
    }
    if (!roots.some((folder) => isInside(folder, real))) {
      return {
        ok: false,
        reason: `${raw} points outside the workspace through a link (${real})`,
      };
    }
    if (isDenied(real)) {
      return { ok: false, reason: `${raw} resolves to a path Rounds never opens` };
    }
    return { ok: true, path: real };
  }

  if (insideButMissing) {
    return { ok: true, path: insideButMissing };
  }

  return {
    ok: false,
    reason: `${raw} is outside the workspace; tools may only read inside ${workspaceFolders.join(`${sep}, `)}`,
  };
}

/**
 * The workspace folders as the file system sees them, plus as they were given.
 *
 * Both, because a folder may be reached through a link: on macOS every temporary folder is, since
 * `/var` is a link to `/private/var`, and comparing only one form refuses perfectly ordinary files.
 */
export async function workspaceRoots(
  workspaceFolders: string[],
  realpathImpl: (path: string) => Promise<string> = realpath,
): Promise<string[]> {
  const resolved = await Promise.all(
    workspaceFolders.map(async (folder) => {
      try {
        return await realpathImpl(folder);
      } catch {
        return folder;
      }
    }),
  );
  return [...new Set([...workspaceFolders, ...resolved])];
}

/**
 * Resolves a path that is about to be written to.
 *
 * Writing needs a check reading does not. A file that does not exist yet has no real path, so the
 * link check in `resolveWorkspacePath` has nothing to follow — and `link/report.md`, where `link`
 * points out of the workspace, would be accepted and then written outside it. Reading survives that
 * because it goes on to find no file; writing creates one. So the nearest folder that does exist is
 * resolved instead, and the target is rebuilt underneath it.
 */
export async function resolveWritePath(
  raw: string,
  workspaceFolders: string[],
  realpathImpl: (path: string) => Promise<string> = realpath,
): Promise<PathRejection> {
  const resolved = await resolveWorkspacePath(raw, workspaceFolders, realpathImpl);
  if (!resolved.ok) {
    return resolved;
  }

  const roots = await workspaceRoots(workspaceFolders, realpathImpl);
  const missing: string[] = [];
  let current = resolved.path;
  let real: string | undefined;

  // Up to the first folder that exists. A path this deep in non-existent folders is unusual, but
  // the loop ends at the file system root either way.
  while (real === undefined) {
    try {
      real = await realpathImpl(current);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return { ok: false, reason: `${raw} has no existing parent folder` };
      }
      missing.unshift(basename(current));
      current = parent;
    }
  }

  const target = missing.length > 0 ? join(real, ...missing) : real;
  if (!roots.some((root) => isInside(root, target))) {
    return {
      ok: false,
      reason: `${raw} points outside the workspace through a link (${target})`,
    };
  }
  if (isDenied(target)) {
    return { ok: false, reason: `${raw} resolves to a path Rounds never opens` };
  }
  return { ok: true, path: target };
}
