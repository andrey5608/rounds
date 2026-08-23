import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolContext } from '../../tools/registry.js';
import {
  MAX_MATCHES,
  createSearchTextTool,
  escapeRegex,
} from '../../tools/searchText.js';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Stands in for the editor's search: it returns whatever it was told to, workspace-relative. */
function finder(paths: string[]): { find: ToolContext['findFiles']; asked: string[] } {
  const asked: string[] = [];
  return {
    find: (globPattern: string) => {
      asked.push(globPattern);
      return Promise.resolve(paths);
    },
    asked,
  };
}

describe('searchText tool', () => {
  let workspace: string;
  const tool = createSearchTextTool();

  function context(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      workspaceFolders: [workspace],
      scriptWhitelist: [],
      logger: silentLogger,
      runId: 'run-1',
      findFiles: finder(['notes.md', 'src/app.ts']).find,
      ...overrides,
    };
  }

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'rounds-search-'));
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(
      join(workspace, 'notes.md'),
      '# Notes\nThe deadline is Friday.\nNothing else.\n',
      'utf8',
    );
    await writeFile(
      join(workspace, 'src', 'app.ts'),
      'export const deadline = 5;\nconst other = 1;\n',
      'utf8',
    );
  });

  it('rejects input without a pattern', () => {
    assert.throws(() => tool.parseInput({}), /"pattern" must be a non-empty string/);
    assert.throws(() => tool.parseInput('deadline'), /object with a "pattern" property/);
  });

  it('returns the matching lines with their file and line number', async () => {
    const output = await tool.execute({ pattern: 'deadline' }, context());

    assert.match(output.content, /notes\.md:2: The deadline is Friday\./);
    assert.match(output.content, /app\.ts:1: export const deadline = 5;/);
    assert.equal(output.meta?.matches, 2);
    assert.equal(output.meta?.filesSearched, 2);
    assert.equal(output.truncated, false);
  });

  it('ignores case unless it is told not to', async () => {
    assert.match((await tool.execute({ pattern: 'DEADLINE' }, context())).content, /notes\.md:2/);

    const strict = await tool.execute(
      { pattern: 'DEADLINE', caseSensitive: true },
      context(),
    );
    assert.match(strict.content, /Nothing matched/);
  });

  it('treats the pattern as text, not as a regular expression, unless asked', async () => {
    await writeFile(join(workspace, 'notes.md'), 'a.b happened\naxb did not\n', 'utf8');

    const literal = await tool.execute({ pattern: 'a.b' }, context());
    assert.match(literal.content, /a\.b happened/);
    assert.ok(!literal.content.includes('axb'), 'the dot matched itself, not any character');

    const regex = await tool.execute({ pattern: 'a.b', isRegex: true }, context());
    assert.match(regex.content, /axb did not/);
  });

  it('refuses a regular expression that does not compile, and says why', () => {
    const decision = tool.checkPermission({ pattern: '(unclosed', isRegex: true }, context());

    assert.equal(decision.allowed, false);
    assert.match(decision.allowed ? '' : decision.reason, /not a valid regular expression/);
  });

  it('escapes what a literal pattern must not mean', () => {
    assert.equal(escapeRegex('a.b*c'), 'a\\.b\\*c');
    assert.equal(escapeRegex('cost: $5 (net)'), 'cost: \\$5 \\(net\\)');
  });

  it('says nothing matched rather than returning an empty answer', async () => {
    const output = await tool.execute({ pattern: 'nowhere at all' }, context());

    assert.match(output.content, /Nothing matched nowhere at all in 2 file\(s\)/);
    assert.equal(output.meta?.matches, 0);
  });

  it('passes the glob on and defaults to searching everything', async () => {
    const narrow = finder(['src/app.ts']);
    await tool.execute({ pattern: 'deadline', globPattern: 'src/**/*.ts' }, context({ findFiles: narrow.find }));
    assert.deepEqual(narrow.asked, ['src/**/*.ts']);

    const all = finder(['notes.md']);
    await tool.execute({ pattern: 'deadline' }, context({ findFiles: all.find }));
    assert.deepEqual(all.asked, ['**/*']);
  });

  it('refuses a glob that reaches out of the workspace', () => {
    for (const globPattern of ['/etc/**', '../**/*.md']) {
      const decision = tool.checkPermission({ pattern: 'x', globPattern }, context());
      assert.equal(decision.allowed, false, globPattern);
    }
  });

  it('never opens a file on the deny list, whatever the search returned', async () => {
    await writeFile(join(workspace, '.env'), 'TOKEN=deadline-secret\n', 'utf8');
    const output = await tool.execute(
      { pattern: 'deadline' },
      context({ findFiles: finder(['.env', 'notes.md']).find }),
    );

    assert.ok(!output.content.includes('deadline-secret'));
    assert.equal(output.meta?.filesSearched, 1);
  });

  it('skips a binary file instead of quoting bytes at the model', async () => {
    await writeFile(join(workspace, 'blob.bin'), Buffer.from([0x64, 0x00, 0x65]));
    const output = await tool.execute(
      { pattern: 'd' },
      context({ findFiles: finder(['blob.bin']).find }),
    );

    assert.match(output.content, /Nothing matched/);
    assert.equal(output.meta?.filesSearched, 0);
  });

  it('stops at the match limit and says how to see the rest', async () => {
    const lines = Array.from({ length: MAX_MATCHES + 10 }, (_, index) => `deadline ${index}`);
    await writeFile(join(workspace, 'many.md'), `${lines.join('\n')}\n`, 'utf8');

    const output = await tool.execute(
      { pattern: 'deadline' },
      context({ findFiles: finder(['many.md']).find }),
    );

    assert.equal(output.meta?.matches, MAX_MATCHES);
    assert.match(output.content, /narrow the pattern or the glob/);
    assert.equal(output.truncated, true);
  });

  it('gives up on time rather than holding the run', async () => {
    // A clock that has already passed the budget by the first file: the run keeps its rounds.
    const slow = createSearchTextTool({ now: (() => {
      let calls = 0;
      return () => (calls++ === 0 ? 0 : 60_000);
    })() });

    const output = await slow.execute({ pattern: 'deadline' }, context());

    assert.match(output.content, /ran out of time/);
    assert.equal(output.truncated, true);
  });

  it('stops when the run was cancelled', async () => {
    const output = await tool.execute({ pattern: 'deadline' }, context({ isCancelled: () => true }));

    assert.match(output.content, /Nothing matched/);
    assert.equal(output.meta?.filesSearched, 0);
  });
});
