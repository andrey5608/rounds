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

  it('does not ask for more files once the prompt folder filled the list', async () => {
    const conventional = Array.from({ length: 5 }, (_, index) => `.github/prompts/p${index}.md`);
    const { find, calls } = finder({ '**/.github/prompts/**/*.md': conventional });

    await discoverPromptFiles(find, 5);
    assert.deepEqual(calls, ['**/.github/prompts/**/*.md'], 'the second search would be wasted');
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
