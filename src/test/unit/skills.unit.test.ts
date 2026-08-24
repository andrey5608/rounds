import * as assert from 'node:assert/strict';

import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  SkillUnavailableError,
  composePrompt,
  describeSkillFile,
  loadSkills,
  resolveSkillPath,
  skillName,
  declinedTools,
  toolsForSkills,
} from '../../agents/skills.js';

const ROOT = resolve(tmpdir(), 'rounds-skills');

/** A disk whose files are addressed the way `loadSkills` addresses them: resolved. */
function reader(files: Record<string, string>): (path: string) => Promise<string> {
  const resolved = Object.fromEntries(
    Object.entries(files).map(([stored, content]) => [resolveSkillPath(stored, ROOT), content]),
  );
  return (path) => {
    const found = resolved[path];
    return found === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(found);
  };
}

function load(paths: string[], files: Record<string, string>, folders: string[] = [ROOT]) {
  return loadSkills(paths, reader(files), { workspaceFolders: folders });
}

describe('the tools attaching a skill turns on', () => {
  const available = ['readFile', 'listFiles', 'runScript', 'a_workspace_tool'];
  /** The tools this extension owns; everything else in `available` belongs to somebody else. */
  const ours = ['readFile', 'listFiles', 'searchText', 'writeFile', 'runScript'];

  it('turns on reading, because a procedure about a repository needs to see it', () => {
    const needed = toolsForSkills([{ path: 'a', name: 'a', tools: [] }], available);
    assert.deepEqual(needed.sort(), ['listFiles', 'readFile']);
  });

  it('turns on what the skill itself asked for, among the tools we own', () => {
    const needed = toolsForSkills(
      [{ path: 'a', name: 'a', tools: ['searchText'] }],
      [...available, 'searchText'],
      ours,
    );
    assert.ok(needed.includes('searchText'));
  });

  it('never turns on a tool from another extension, however the header asks', () => {
    // The editor may put a confirmation dialog in front of one, and a run at 09:00 has nobody
    // there to answer it. The person filling in the form can tick it; the form cannot decide.
    const skill = [{ path: 'a', name: 'a', tools: ['a_workspace_tool'] }];

    assert.ok(!toolsForSkills(skill, available, ours).includes('a_workspace_tool'));
    assert.deepEqual(declinedTools(skill, available, ours), ['a_workspace_tool']);
  });

  it('reports runScript as declined rather than silently dropping it', () => {
    assert.deepEqual(
      declinedTools([{ path: 'a', name: 'a', tools: ['runScript'] }], available, ours),
      ['runScript'],
    );
  });

  it('declines nothing when the skill asked for nothing unusual', () => {
    assert.deepEqual(declinedTools([{ path: 'a', name: 'a', tools: ['readFile'] }], available, ours), []);
  });

  it('never turns on runScript, however loudly a skill asks', () => {
    // It runs commands, behind a whitelist and workspace trust. A checkbox nobody ticked is not
    // consent to any of that.
    const needed = toolsForSkills([{ path: 'a', name: 'a', tools: ['runScript'] }], available);
    assert.ok(!needed.includes('runScript'));
  });

  it('skips a tool nothing registers rather than storing a name that fails the run', () => {
    const needed = toolsForSkills([{ path: 'a', name: 'a', tools: ['gone'] }], available);
    assert.ok(!needed.includes('gone'));
  });

  it('turns on nothing when no skill is attached', () => {
    assert.deepEqual(toolsForSkills([], available), []);
  });
});

describe('skills attached to an agent', () => {
  it('is named after its folder, because SKILL.md says nothing on its own', () => {
    assert.equal(skillName('.github/skills/deep-research/SKILL.md'), 'deep-research');
    assert.equal(skillName('skills/triage.md'), 'triage');
    assert.equal(skillName('.claude\\\\skills\\\\review\\\\SKILL.md'), 'review');
  });

  it('introduces itself from its own header, so a list can offer skills rather than files', () => {
    const summary = describeSkillFile(
      '.github/skills/deep-research/SKILL.md',
      [
        '---',
        'name: Deep research',
        'description: Reads the ticket, the linked issues and the code before answering.',
        '---',
        'Ask three questions.',
      ].join('\n'),
    );

    assert.deepEqual(summary, {
      path: '.github/skills/deep-research/SKILL.md',
      name: 'Deep research',
      description: 'Reads the ticket, the linked issues and the code before answering.',
      tools: [],
    });
  });

  it('reads the tools a skill says it needs', () => {
    const summary = describeSkillFile(
      'skills/research/SKILL.md',
      ['---', "tools: ['listFiles', 'a_workspace_tool']", '---', 'Instructions.'].join('\n'),
    );

    assert.deepEqual(summary.tools, ['listFiles', 'a_workspace_tool']);
  });

  it('falls back to the folder when a skill does not name itself', () => {
    const summary = describeSkillFile('.github/skills/triage/SKILL.md', 'Just instructions.');

    assert.equal(summary.name, 'triage');
    assert.equal(summary.description, undefined);
  });

  it('is read with its header removed, like any other prompt file', async () => {
    const skills = await load(['skills/research/SKILL.md'], {
      'skills/research/SKILL.md': ['---', 'name: research', '---', '', 'Ask three questions.'].join('\n'),
    });

    assert.equal(skills[0]?.content, 'Ask three questions.');
    assert.equal(skills[0]?.name, 'research');
  });

  it('goes in front of the prompt, with a heading naming it', () => {
    const composed = composePrompt('Summarize {{items}}.', [
      { name: 'research', content: 'Ask three questions.', path: 'skills/research/SKILL.md' },
    ]);

    assert.match(composed, /^## Skill: research\n\nAsk three questions\./);
    assert.match(composed, /---\n\nSummarize \{\{items\}\}\.$/);
  });

  it('keeps several in the order they were chosen', () => {
    const composed = composePrompt('Then do the work.', [
      { name: 'first', content: 'One.', path: 'a' },
      { name: 'second', content: 'Two.', path: 'b' },
    ]);

    assert.ok(composed.indexOf('## Skill: first') < composed.indexOf('## Skill: second'));
    assert.ok(composed.indexOf('## Skill: second') < composed.indexOf('Then do the work.'));
  });

  it('leaves a prompt with no skills exactly as it was', () => {
    assert.equal(composePrompt('Summarize {{items}}.', []), 'Summarize {{items}}.');
  });

  it('goes in verbatim, placeholders and all', async () => {
    // A skill is somebody's procedure. Rewriting it to look like a prompt would be the same
    // mistake as editing their query: placeholders belong to the prompt.
    const skills = await load(['skills/odd.md'], {
      'skills/odd.md': 'Mention {{items}} literally and keep <angle brackets>.',
    });

    assert.equal(skills[0]?.content, 'Mention {{items}} literally and keep <angle brackets>.');
  });

  it('is read relative to the workspace, not to wherever the editor was started', async () => {
    // The reported failure: every attached skill came back unreadable. The picker stores a
    // workspace-relative path, and reading it relative to the extension host's working directory
    // finds nothing at all.
    assert.equal(resolveSkillPath('skills/a/SKILL.md', ROOT), join(ROOT, 'skills', 'a', 'SKILL.md'));

    const skills = await load(['skills/a/SKILL.md'], { 'skills/a/SKILL.md': 'Do the thing.' });
    assert.equal(skills[0]?.content, 'Do the thing.');
  });

  it('leaves an absolute path alone', () => {
    const absolute = join(ROOT, 'elsewhere', 'SKILL.md');
    assert.equal(resolveSkillPath(absolute, ROOT), absolute);
  });

  it('says where it looked when a skill cannot be read', async () => {
    await assert.rejects(load(['skills/gone.md'], {}), (error: unknown) => {
      assert.ok(error instanceof SkillUnavailableError);
      assert.match(error.message, /skills\/gone\.md/);
      assert.match(error.message, /Looked for it at/);
      return true;
    });
  });

  it('fails the run when a skill cannot be read', async () => {
    // Running without it would follow different instructions than the agent was given, and
    // produce a confident answer to another question.
    await assert.rejects(load(['skills/gone.md'], {}), (error: unknown) => {
      assert.ok(error instanceof SkillUnavailableError);
      assert.equal(error.code, 'prompt.skillUnreadable');
      assert.match(error.message, /skills\/gone\.md/);
      return true;
    });
  });

  it('refuses a skill that is only a header, and says that is what it is', async () => {
    // It reads perfectly well and holds no instructions. Calling that "could not be read" sends
    // somebody to check file permissions on a file whose problem is that it is empty.
    await assert.rejects(
      load(['skills/empty.md'], { 'skills/empty.md': '---\nname: empty\n---\n' }),
      (error: unknown) => {
        assert.ok(error instanceof SkillUnavailableError);
        assert.equal(error.failure, 'empty');
        assert.match(error.message, /no instructions in it, only a header/);
        return true;
      },
    );
  });

  it('finds a skill in any workspace folder, not only the first', async () => {
    // The picker stores a workspace-relative path with no folder in it, so with two folders open
    // the second one's skills resolved against the first and came back missing.
    const second = join(ROOT, '..', 'other');
    const files = { [join(second, 'skills', 'b.md')]: 'read the tickets first' };
    const reads = (path: string) =>
      files[path] === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(files[path]);

    const skills = await loadSkills(['skills/b.md'], reads, { workspaceFolders: [ROOT, second] });

    assert.equal(skills.length, 1);
    assert.match(skills[0]?.content ?? '', /read the tickets first/);
  });

  it('names every folder it looked in, so the report says where to put the file', async () => {
    const second = join(ROOT, '..', 'other');
    await assert.rejects(load(['skills/gone.md'], {}, [ROOT, second]), (error: unknown) => {
      assert.ok(error instanceof SkillUnavailableError);
      assert.equal(error.attempted.length, 2);
      assert.match(error.message, /Looked for it at .*,/);
      return true;
    });
  });
});
