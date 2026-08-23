import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ToolContext } from '../../tools/registry.js';
import { MAX_WRITE_BYTES, createWriteFileTool, isWriteDenied } from '../../tools/writeFile.js';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function context(workspaceFolders: string[], overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceFolders,
    scriptWhitelist: [],
    logger: silentLogger,
    runId: 'run-1',
    ...overrides,
  };
}

describe('writeFile tool', () => {
  let workspace: string;
  let outside: string;
  const tool = createWriteFileTool();

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'rounds-write-'));
    workspace = join(base, 'workspace');
    outside = join(base, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(workspace, 'notes.md'), 'the version already there\n', 'utf8');
  });

  it('rejects input that is not a path and a string of content', () => {
    assert.throws(() => tool.parseInput({ content: 'x' }), /"path" must be a non-empty string/);
    assert.throws(() => tool.parseInput({ path: 'a.md' }), /"content" must be a string/);
    assert.throws(() => tool.parseInput('a.md'), /object with "path" and "content"/);
    // An empty file is a file somebody meant to create.
    assert.deepEqual(tool.parseInput({ path: 'a.md', content: '' }), { path: 'a.md', content: '' });
  });

  it('writes a file, creating the folders it needs', async () => {
    const output = await tool.execute(
      { path: join('reports', 'week-42.md'), content: '# Week 42\n' },
      context([workspace]),
    );

    assert.equal(
      await readFile(join(workspace, 'reports', 'week-42.md'), 'utf8'),
      '# Week 42\n',
    );
    assert.match(output.content, /Wrote/);
    assert.equal(output.meta?.replaced, false);
  });

  it('leaves an existing file alone unless the call says to replace it', async () => {
    const refused = await tool.execute(
      { path: 'notes.md', content: 'something else' },
      context([workspace]),
    );
    assert.match(refused.content, /already exists.*overwrite: true/s);
    assert.equal(await readFile(join(workspace, 'notes.md'), 'utf8'), 'the version already there\n');

    const replaced = await tool.execute(
      { path: 'notes.md', content: 'something else', overwrite: true },
      context([workspace]),
    );
    assert.match(replaced.content, /Replaced/);
    assert.equal(await readFile(join(workspace, 'notes.md'), 'utf8'), 'something else');
  });

  it('leaves nothing behind when it is done', async () => {
    await tool.execute({ path: 'report.md', content: 'done' }, context([workspace]));
    // Written beside the target and moved into place; the temporary file must not survive that.
    assert.deepEqual((await readdir(workspace)).sort(), ['notes.md', 'report.md']);
  });

  it('refuses a path outside the workspace', async () => {
    const output = await tool.execute(
      { path: join(outside, 'planted.md'), content: 'x' },
      context([workspace]),
    );
    assert.match(output.content, /Refused: .* is outside the workspace/);
    assert.deepEqual(await readdir(outside), []);
  });

  it('refuses traversal out of the workspace', async () => {
    const output = await tool.execute(
      { path: join('..', 'outside', 'planted.md'), content: 'x' },
      context([workspace]),
    );
    assert.match(output.content, /Refused/);
    assert.deepEqual(await readdir(outside), []);
  });

  it('refuses to write through a link that leaves the workspace', async function () {
    try {
      await symlink(outside, join(workspace, 'link'));
    } catch {
      // Windows without the privilege. The rule is covered by the traversal case above.
      this.skip();
      return;
    }
    const output = await tool.execute(
      { path: join('link', 'planted.md'), content: 'x' },
      context([workspace]),
    );

    assert.match(output.content, /Refused/);
    assert.deepEqual(await readdir(outside), []);
  });

  it('refuses the places that run on their own', () => {
    // A tasks.json can be set to run when the folder opens, and a workflow runs after a push:
    // writing there would go around the script whitelist rather than through it.
    for (const path of [
      join('.vscode', 'tasks.json'),
      join('.github', 'workflows', 'ci.yml'),
      join('.git', 'hooks', 'pre-commit'),
      '.env',
      join('deploy', 'server.key'),
    ]) {
      assert.equal(isWriteDenied(path), true, path);
      const decision = tool.checkPermission({ path, content: 'x' }, context(['/workspace']));
      assert.equal(decision.allowed, false, path);
    }

    assert.equal(isWriteDenied(join('docs', 'notes.md')), false);
  });

  it('refuses to write in a workspace the user has not trusted', () => {
    const decision = tool.checkPermission(
      { path: 'notes.md', content: 'x' },
      context([workspace], { workspaceTrusted: false }),
    );

    assert.equal(decision.allowed, false);
    assert.match(decision.allowed ? '' : decision.reason, /not trusted/);
  });

  it('refuses content larger than the limit instead of writing part of it', () => {
    const decision = tool.checkPermission(
      { path: 'huge.md', content: 'x'.repeat(MAX_WRITE_BYTES + 1) },
      context([workspace]),
    );

    assert.equal(decision.allowed, false);
    assert.match(decision.allowed ? '' : decision.reason, /larger than/);
  });

  it('says a folder is a folder rather than failing the run', async () => {
    await mkdir(join(workspace, 'reports'), { recursive: true });
    const output = await tool.execute(
      { path: 'reports', content: 'x', overwrite: true },
      context([workspace]),
    );
    assert.match(output.content, /is a folder/);
  });
});
