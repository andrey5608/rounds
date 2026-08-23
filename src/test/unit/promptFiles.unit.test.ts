import * as assert from 'node:assert/strict';

import type { FileFinder } from '../../tools/registry.js';
import { describeCandidate, discoverPromptFiles } from '../../ui/wizard/promptFiles.js';

/** A finder that answers each glob with what a workspace would contain. */
function finder(byGlob: Record<string, string[]>): { find: FileFinder; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    find: (globPattern, limit) => {
      calls.push(globPattern);
      return Promise.resolve((byGlob[globPattern] ?? []).slice(0, limit));
    },
  };
}

describe('finding the prompt files a workspace already has', () => {
  it('puts the conventional folder first, then everything else', async () => {
    // A file under .github/prompts was put there to be a prompt. Any other Markdown file merely
    // might be one, so it follows rather than competing for the first row.
    const { find } = finder({
      '**/.github/prompts/**/*.md': ['.github/prompts/triage.md'],
      '**/*.md': ['README.md', '.github/prompts/triage.md', 'docs/notes.md'],
    });

    const found = await discoverPromptFiles(find);

    assert.deepEqual(
      found.map((candidate) => candidate.path),
      ['.github/prompts/triage.md', 'README.md', 'docs/notes.md'],
    );
    assert.deepEqual(
      found.map((candidate) => candidate.conventional),
      [true, false, false],
    );
  });

  it('lists a shallow file before a deep one, and sorts the rest by name', async () => {
    const { find } = finder({
      '**/.github/prompts/**/*.md': [],
      '**/*.md': ['docs/deep/nested/notes.md', 'b.md', 'a.md', 'docs/notes.md'],
    });

    assert.deepEqual(
      (await discoverPromptFiles(find)).map((candidate) => candidate.path),
      ['a.md', 'b.md', 'docs/notes.md', 'docs/deep/nested/notes.md'],
    );
  });

  it('returns nothing at all rather than failing when there is nothing to find', async () => {
    const { find } = finder({});
    assert.deepEqual(await discoverPromptFiles(find), []);
  });

  it('stops at the limit it was given', async () => {
    const many = Array.from({ length: 30 }, (_, index) => `note-${index}.md`);
    const { find } = finder({ '**/.github/prompts/**/*.md': [], '**/*.md': many });

    assert.equal((await discoverPromptFiles(find, 5)).length, 5);
  });

  it('does not search the whole workspace once the named folders filled the list', async () => {
    const conventional = Array.from({ length: 5 }, (_, index) => `.github/prompts/p${index}.md`);
    const { find, calls } = finder({ '**/.github/prompts/**/*.md': conventional });

    await discoverPromptFiles(find, 5);
    assert.deepEqual(
      calls,
      ['**/.github/prompts/**/*.md', '**/skills/**/*.md'],
      'the broad search over every Markdown file would be wasted',
    );
  });

  it('offers the skills a workspace has, named after their folder', async () => {
    // A run cannot invoke a skill: they are addressed with a slash in the chat view, and nothing
    // the editor lists as a tool answers to a slash. A skill is instructions, though, so an agent
    // uses one by making it the prompt.
    const { find } = finder({
      '**/.github/prompts/**/*.md': [],
      '**/skills/**/*.md': ['.github/skills/feature-research/SKILL.md'],
      '**/*.md': ['README.md'],
    });

    const found = await discoverPromptFiles(find);

    assert.equal(found[0]?.path, '.github/skills/feature-research/SKILL.md');
    assert.equal(found[0]?.skill, true);
    assert.ok(found[0]);
    assert.deepEqual(describeCandidate(found[0]), {
      label: 'feature-research (skill)',
      detail: '.github/skills/feature-research/SKILL.md · skill',
    });
  });

  it('names a skill that is a file rather than a folder by its file name', async () => {
    const { find } = finder({ '**/skills/**/*.md': ['skills/triage.md'] });
    const found = await discoverPromptFiles(find);

    assert.ok(found[0]);
    assert.equal(describeCandidate(found[0]).label, 'triage (skill)');
  });

  it('names a file by its file name and says where it lives', () => {
    // Every folder has a README.md, so the name alone is ambiguous and the full path is noise.
    assert.deepEqual(describeCandidate({ path: 'docs/notes.md', conventional: false }), {
      label: 'notes.md',
      detail: 'docs/notes.md',
    });
    assert.deepEqual(
      describeCandidate({ path: '.github/prompts/triage.md', conventional: true }),
      { label: 'triage.md', detail: '.github/prompts/triage.md · prompt folder' },
    );
  });

  it('reads a Windows path the same way', () => {
    assert.equal(
      describeCandidate({ path: 'docs\\notes.md', conventional: false }).label,
      'notes.md',
    );
  });
});
