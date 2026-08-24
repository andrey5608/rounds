import { isAbsolute, resolve as resolvePath } from 'node:path';

import { parsePromptFile } from './promptFrontMatter.js';

/** One skill, ready to be put in front of a prompt. */
export interface LoadedSkill {
  /** What it is called: the folder for a `SKILL.md`, the file name otherwise. */
  name: string;
  /** Its instructions, header removed. */
  content: string;
  path: string;
}

/** Why a skill could not be used. Two different problems that used to share one sentence. */
export type SkillFailure = 'unreadable' | 'empty';

export class SkillUnavailableError extends Error {
  readonly code = 'prompt.skillUnreadable';

  constructor(
    readonly path: string,
    /** Every place it was looked for. More than one when the workspace has several folders. */
    readonly attempted: string[] = [],
    readonly failure: SkillFailure = 'unreadable',
  ) {
    const where =
      attempted.length > 0 && !(attempted.length === 1 && attempted[0] === path)
        ? ` Looked for it at ${attempted.join(', ')}.`
        : '';
    // "Could not be read" for a file that was read perfectly well and turned out to hold nothing
    // sends somebody to check permissions on a file whose problem is that it is empty.
    const problem =
      failure === 'empty'
        ? `The skill file "${path}" has no instructions in it, only a header`
        : `The skill file "${path}" could not be read`;
    super(
      `${problem}, so this run would follow different instructions than the agent was given.${where} Fix the path or take the skill off the agent.`,
    );
    this.name = 'SkillUnavailableError';
  }
}

/**
 * Reads the skills an agent uses.
 *
 * A missing one fails the run rather than being skipped. The whole point of attaching a skill is
 * that the run follows those instructions; running without them would produce a confident answer
 * to a different question, and nobody compares the result against the instructions afterwards.
 */
export async function loadSkills(
  paths: readonly string[],
  readFileImpl: (path: string) => Promise<string>,
  options: { workspaceFolders?: readonly string[] } = {},
): Promise<LoadedSkill[]> {
  const skills: LoadedSkill[] = [];
  for (const path of paths) {
    // Stored relative to the workspace, because that is what the picker offers and what stays
    // true when the folder moves. Reading it relative to whatever the extension host's working
    // directory happens to be is how every skill came back unreadable.
    const candidates = skillPathCandidates(path, options.workspaceFolders);
    let raw: string | undefined;

    // Every folder, not only the first. With two folders open, a skill in the second one is a
    // perfectly ordinary skill, and resolving it against the first found nothing and blamed the
    // path the user had chosen from a list.
    for (const candidate of candidates) {
      try {
        raw = await readFileImpl(candidate);
        break;
      } catch {
        continue;
      }
    }
    if (raw === undefined) {
      throw new SkillUnavailableError(path, candidates, 'unreadable');
    }

    // A skill file carries the same kind of header a prompt file does, and it is addressed to the
    // editor rather than to the model.
    const content = parsePromptFile(raw).text.trim();
    if (content.length === 0) {
      throw new SkillUnavailableError(path, candidates, 'empty');
    }
    skills.push({ name: skillName(path), content, path });
  }
  return skills;
}

/** Every place a stored skill path could be, in the order they are tried. */
export function skillPathCandidates(
  path: string,
  workspaceFolders: readonly string[] = [],
): string[] {
  if (isAbsolute(path)) {
    return [path];
  }
  if (workspaceFolders.length === 0) {
    return [resolvePath(path)];
  }
  return [...new Set(workspaceFolders.map((folder) => resolvePath(folder, path)))];
}

/** A stored skill path as a path on disk, against one folder. */
export function resolveSkillPath(path: string, workspaceRoot?: string): string {
  if (isAbsolute(path)) {
    return path;
  }
  return workspaceRoot ? resolvePath(workspaceRoot, path) : resolvePath(path);
}

/**
 * Puts the skills in front of the prompt.
 *
 * Instructions first, then the task: a skill says how this kind of work is done, and the prompt
 * says what to do now. Each one is headed with its name so the model can tell them apart, and the
 * text goes in verbatim — placeholders belong to the prompt, and rewriting somebody's procedure to
 * look like one would be the same mistake as editing their query.
 */
export function composePrompt(prompt: string, skills: readonly LoadedSkill[]): string {
  if (skills.length === 0) {
    return prompt;
  }
  const sections = skills.map((skill) => `## Skill: ${skill.name}\n\n${skill.content}`);
  return `${sections.join('\n\n')}\n\n---\n\n${prompt}`;
}

/**
 * A skill as a list shows it: what it is called and what it is for.
 *
 * Read from the file's own header, because that is where a skill introduces itself. Picking a
 * skill should be picking a skill, not picking the file it happens to live in.
 */
export interface SkillSummary {
  path: string;
  name: string;
  description?: string;
  /** Tools the skill's header asks for. A skill that reads files says so here. */
  tools: string[];
}

/** Describes one skill file without loading it into a prompt. */
export function describeSkillFile(path: string, content: string): SkillSummary {
  const header = parsePromptFile(content).frontMatter;
  const summary: SkillSummary = {
    path,
    name: header?.name?.trim() || skillName(path),
    tools: header?.tools ?? [],
  };
  const description = header?.description?.trim();
  if (description) {
    summary.description = description;
  }
  return summary;
}

/**
 * The tools an agent needs once it follows these skills.
 *
 * Two sources, both honest. What a skill declares in its header is what its author said it needs.
 * And reading is the floor: a procedure written about a repository cannot be followed without
 * looking at it, and an agent that silently could not read would produce an answer about nothing.
 *
 * `runScript` is never added. It runs commands, it is gated by a whitelist and by workspace trust,
 * and a checkbox somebody did not tick is not consent to any of that.
 *
 * Neither is a tool belonging to another extension, whatever the header names. Such a tool is
 * somebody else's code, and the editor may put a confirmation dialog in front of it — which a
 * scheduled run has nobody to answer. A skill asking for one is a suggestion to the person filling
 * in the form, not a decision it may take for them; `declinedTools` is what the form tells them.
 */
export function toolsForSkills(
  skills: readonly SkillSummary[],
  available: readonly string[],
  ours: readonly string[] = available,
): string[] {
  if (skills.length === 0) {
    return [];
  }
  const wanted = new Set<string>(['readFile', 'listFiles']);
  for (const skill of skills) {
    for (const tool of skill.tools) {
      wanted.add(tool);
    }
  }
  wanted.delete('runScript');
  return [...wanted].filter((tool) => available.includes(tool) && ours.includes(tool));
}

/** The tools these skills asked for that will not be turned on for them, and why. */
export function declinedTools(
  skills: readonly SkillSummary[],
  available: readonly string[],
  ours: readonly string[],
): string[] {
  const declined = new Set<string>();
  for (const skill of skills) {
    for (const tool of skill.tools) {
      if (tool === 'runScript' || (available.includes(tool) && !ours.includes(tool))) {
        declined.add(tool);
      }
    }
  }
  return [...declined];
}

/** A `SKILL.md` is named by its folder; anything else by its file name. */
export function skillName(path: string): string {
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  const file = parts[parts.length - 1] ?? path;
  if (!/^skill\.md$/i.test(file)) {
    return file.replace(/\.md$/i, '');
  }
  return parts[parts.length - 2] ?? file;
}
