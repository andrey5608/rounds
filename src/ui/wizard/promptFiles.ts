import type { FileFinder } from '../../tools/registry.js';

/** How many files the picker offers before it stops looking. */
export const PROMPT_FILE_LIMIT = 50;

export interface PromptFileCandidate {
  /** Workspace-relative path, as the picker shows it. */
  path: string;
  /** True for files under `.github/prompts`, which are prompts on purpose rather than by accident. */
  conventional: boolean;
}

/**
 * The prompt files a workspace already has.
 *
 * Two globs rather than one, because the order matters more than the completeness: a file under
 * `.github/prompts` was put there to be a prompt, while any other Markdown file merely might be.
 * Conventional ones come first and the rest follow, deduplicated, so the picker's first entries
 * are the ones somebody was looking for.
 *
 * Discovery is an accelerator, never a cage: the caller keeps a way to browse for a file that is
 * not here, and an empty result is a normal outcome rather than an error.
 */
export async function discoverPromptFiles(
  findFiles: FileFinder,
  limit = PROMPT_FILE_LIMIT,
): Promise<PromptFileCandidate[]> {
  const conventional = await findFiles('**/.github/prompts/**/*.md', limit);
  const remaining = Math.max(0, limit - conventional.length);
  const others = remaining > 0 ? await findFiles('**/*.md', remaining + conventional.length) : [];

  const seen = new Set<string>();
  const candidates: PromptFileCandidate[] = [];

  for (const path of [...conventional].sort(comparePaths)) {
    if (!seen.has(path)) {
      seen.add(path);
      candidates.push({ path, conventional: true });
    }
  }
  for (const path of [...others].sort(comparePaths)) {
    if (candidates.length >= limit) {
      break;
    }
    if (!seen.has(path)) {
      seen.add(path);
      candidates.push({ path, conventional: false });
    }
  }
  return candidates;
}

/** Shallow paths first, then alphabetical: a prompt at the root is likelier than one six levels down. */
function comparePaths(left: string, right: string): number {
  const depth = segments(left) - segments(right);
  return depth !== 0 ? depth : left.localeCompare(right);
}

function segments(path: string): number {
  return path.split(/[\\/]/).length;
}

/**
 * The name a picker shows for a prompt file.
 *
 * The file name alone is ambiguous — every folder has a `README.md` — and the full path is noise,
 * so the label is the name and the description is where it lives.
 */
export function describeCandidate(candidate: PromptFileCandidate): { label: string; detail: string } {
  const parts = candidate.path.split(/[\\/]/);
  const name = parts[parts.length - 1] ?? candidate.path;
  return {
    label: name,
    detail: candidate.conventional ? `${candidate.path} · prompt folder` : candidate.path,
  };
}
