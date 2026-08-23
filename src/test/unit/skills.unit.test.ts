import * as assert from 'node:assert/strict';

import {
  SkillUnavailableError,
  composePrompt,
  loadSkills,
  skillName,
} from '../../agents/skills.js';

function reader(files: Record<string, string>): (path: string) => Promise<string> {
  return (path) => {
    const found = files[path];
    return found === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(found);
  };
}

describe('skills attached to an agent', () => {
  it('is named after its folder, because SKILL.md says nothing on its own', () => {
    assert.equal(skillName('.github/skills/deep-research/SKILL.md'), 'deep-research');
    assert.equal(skillName('skills/triage.md'), 'triage');
    assert.equal(skillName('.claude\\\\skills\\\\review\\\\SKILL.md'), 'review');
  });

  it('is read with its header removed, like any other prompt file', async () => {
    const skills = await loadSkills(
      ['skills/research/SKILL.md'],
      reader({
        'skills/research/SKILL.md': ['---', 'name: research', '---', '', 'Ask three questions.'].join('\n'),
      }),
    );

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
    const skills = await loadSkills(
      ['skills/odd.md'],
      reader({ 'skills/odd.md': 'Mention {{items}} literally and keep <angle brackets>.' }),
    );

    assert.equal(skills[0]?.content, 'Mention {{items}} literally and keep <angle brackets>.');
  });

  it('fails the run when a skill cannot be read', async () => {
    // Running without it would follow different instructions than the agent was given, and
    // produce a confident answer to another question.
    await assert.rejects(loadSkills(['skills/gone.md'], reader({})), (error: unknown) => {
      assert.ok(error instanceof SkillUnavailableError);
      assert.equal(error.code, 'prompt.skillUnreadable');
      assert.match(error.message, /skills\/gone\.md/);
      return true;
    });
  });

  it('treats a skill that is only a header as unreadable', async () => {
    await assert.rejects(
      loadSkills(['skills/empty.md'], reader({ 'skills/empty.md': '---\nname: empty\n---\n' })),
      SkillUnavailableError,
    );
  });
});
