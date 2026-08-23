import type { FileFinder } from '../../tools/registry.js';

/** How many files the picker offers before it stops looking. */
export const PROMPT_FILE_LIMIT = 100;

/**
 * How many files the skill search may return before it is filtered.
 *
 * Generous on purpose, and separate from the picker's limit. A skill folder holds a `SKILL.md` and
 * whatever else it needs — a README, instructions, notes — and asking for fifty Markdown files
 * under every `skills` folder meant one busy folder could use the whole allowance and hide the
 * skills in the next one. The filter below is what makes the list short again.
 */
export const SKILL_SEARCH_LIMIT = 400;

/** How many skills the picker offers. */
export const SKILL_LIMIT = 50;

/**
 * Files that live beside skills without being one.
 *
 * A skill folder is a folder of documents, and all but one of them are support: the README that
 * explains the set, the instructions written for a chat agent, the notes. Offering them as skills
 * makes the list longer and every entry less trustworthy.
 */
const SUPPORT_FILE = /^(readme|contributing|license|licence|changelog|notes|index|agents|claude|copilot[-_ ]?instructions)$/i;

/**
 * Whether a Markdown file under a `skills` folder is a skill.
 *
 * Two layouts are real: `skills/<name>/SKILL.md`, which is what the tools that read skills expect,
 * and a flat `skills/<name>.md`. Anything else in those folders is support material.
 */
export function isSkillFile(path: string): boolean {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  const file = parts[parts.length - 1] ?? '';
  const base = file.replace(/\.md$/i, '');

  if (/^skill$/i.test(base)) {
    return true;
  }
  if (SUPPORT_FILE.test(base)) {
    return false;
  }
  // A flat layout: the file sits directly in a folder called `skills`.
  const parent = parts[parts.length - 2] ?? '';
  return /^skills$/i.test(parent);
}

export interface PromptFileCandidate {
  /** Workspace-relative path, as the picker shows it. */
  path: string;
  /** True for files under `.github/prompts`, which are prompts on purpose rather than by accident. */
  conventional: boolean;
  /**
   * A skill: a Markdown file describing a procedure, which the chat view loads by name.
   *
   * A run cannot invoke one — skills are addressed with a slash in the chat view, and nothing in
   * `vscode.lm.tools` answers to a slash. But a skill *is* instructions, so an agent can use it by
   * making it the prompt, which is what this flag is for: the picker offers them and says what
   * they are.
   */
  skill?: boolean;
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
  const skills = (await findFiles('**/skills/**/*.md', SKILL_SEARCH_LIMIT))
    .filter(isSkillFile)
    .slice(0, SKILL_LIMIT);
  const used = conventional.length + skills.length;
  const remaining = Math.max(0, limit - used);
  const others = remaining > 0 ? await findFiles('**/*.md', remaining + used) : [];

  const seen = new Set<string>();
  const candidates: PromptFileCandidate[] = [];

  for (const path of [...conventional].sort(comparePaths)) {
    if (!seen.has(path)) {
      seen.add(path);
      candidates.push({ path, conventional: true });
    }
  }
  for (const path of [...skills].sort(comparePaths)) {
    if (candidates.length >= limit) {
      break;
    }
    if (!seen.has(path)) {
      seen.add(path);
      candidates.push({ path, conventional: true, skill: true });
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
 * The name a skill goes by.
 *
 * A skill lives in a folder named after it, so `SKILL.md` on its own says nothing and the folder
 * says everything. Anything else keeps its file name.
 */
function describeSkill(path: string): string {
  const parts = path.split(/[\\/]/);
  const name = parts[parts.length - 1] ?? path;
  if (!/^skill\.md$/i.test(name)) {
    return name.replace(/\.md$/i, '');
  }
  return parts[parts.length - 2] ?? name;
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
  const note = candidate.skill ? 'skill' : candidate.conventional ? 'prompt folder' : undefined;
  return {
    label: candidate.skill ? `${describeSkill(candidate.path)} (skill)` : name,
    detail: note ? `${candidate.path} · ${note}` : candidate.path,
  };
}
