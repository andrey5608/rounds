import { parsePromptFile } from './promptFrontMatter.js';

/** One skill, ready to be put in front of a prompt. */
export interface LoadedSkill {
  /** What it is called: the folder for a `SKILL.md`, the file name otherwise. */
  name: string;
  /** Its instructions, header removed. */
  content: string;
  path: string;
}

export class SkillUnavailableError extends Error {
  readonly code = 'prompt.skillUnreadable';

  constructor(readonly path: string) {
    super(
      `The skill file "${path}" could not be read, so this run would follow different instructions than the agent was given. Fix the path or take the skill off the agent.`,
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
): Promise<LoadedSkill[]> {
  const skills: LoadedSkill[] = [];
  for (const path of paths) {
    let raw: string;
    try {
      raw = await readFileImpl(path);
    } catch {
      throw new SkillUnavailableError(path);
    }
    // A skill file carries the same kind of header a prompt file does, and it is addressed to the
    // editor rather than to the model.
    const content = parsePromptFile(raw).text.trim();
    if (content.length === 0) {
      throw new SkillUnavailableError(path);
    }
    skills.push({ name: skillName(path), content, path });
  }
  return skills;
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
}

/** Describes one skill file without loading it into a prompt. */
export function describeSkillFile(path: string, content: string): SkillSummary {
  const header = parsePromptFile(content).frontMatter;
  const summary: SkillSummary = { path, name: header?.name?.trim() || skillName(path) };
  const description = header?.description?.trim();
  if (description) {
    summary.description = description;
  }
  return summary;
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
