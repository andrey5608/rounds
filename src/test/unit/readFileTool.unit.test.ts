import * as assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_FILE_BYTES, createReadFileTool, looksBinary } from '../../tools/readFile.js';
import { ToolRegistry } from '../../tools/registry.js';
import type { ToolContext } from '../../tools/registry.js';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function context(workspaceFolders: string[]): ToolContext {
  return { workspaceFolders, scriptWhitelist: [], logger: silentLogger, runId: 'run-1' };
}

describe('readFile tool', () => {
  let workspace: string;
  let outside: string;
  const tool = createReadFileTool();

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'rounds-tools-'));
    workspace = join(base, 'workspace');
    outside = join(base, 'outside');
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(workspace, 'notes.md'), '# Notes\nAll good.\n', 'utf8');
    await writeFile(join(outside, 'secrets.txt'), 'token=abc', 'utf8');
  });

  it('rejects input without a path', () => {
    assert.throws(() => tool.parseInput({}), /"path" must be a non-empty string/);
    assert.throws(() => tool.parseInput('notes.md'), /object with a "path" property/);
  });

  it('reads a file inside the workspace', async () => {
    const output = await tool.execute({ path: 'notes.md' }, context([workspace]));
    assert.match(output.content, /# Notes/);
    assert.equal(output.truncated, false);
    assert.equal(output.meta?.path, 'notes.md');
  });

  it('refuses a path outside the workspace', async () => {
    const output = await tool.execute({ path: join(outside, 'secrets.txt') }, context([workspace]));
    assert.match(output.content, /Refused: .* is outside the workspace/);
    assert.ok(!output.content.includes('token=abc'));
  });

  it('refuses traversal out of the workspace', async () => {
    const output = await tool.execute({ path: '../outside/secrets.txt' }, context([workspace]));
    assert.match(output.content, /Refused/);
    assert.ok(!output.content.includes('token=abc'));
  });

  it('refuses a symbolic link that points out of the workspace', async () => {
    await symlink(join(outside, 'secrets.txt'), join(workspace, 'link.txt'));
    const output = await tool.execute({ path: 'link.txt' }, context([workspace]));

    assert.match(output.content, /Refused: .* through a link/);
    assert.ok(!output.content.includes('token=abc'));
  });

  it('refuses paths on the deny list before touching the disk', () => {
    for (const path of ['.env', 'config/.env.local', 'keys/server.pem', '.git/config', 'node_modules/pkg/index.js']) {
      const permission = tool.checkPermission({ path }, context([workspace]));
      assert.equal(permission.allowed, false, `${path} should be denied`);
    }
  });

  it('allows an ordinary source file', () => {
    assert.deepEqual(tool.checkPermission({ path: 'src/index.ts' }, context([workspace])), {
      allowed: true,
    });
  });

  it('refuses everything when no workspace is open', async () => {
    assert.deepEqual(tool.checkPermission({ path: 'notes.md' }, context([])), {
      allowed: false,
      reason: 'no workspace is open, so there are no files to read',
    });
    const output = await tool.execute({ path: 'notes.md' }, context([]));
    assert.match(output.content, /Refused/);
  });

  it('reports a missing file plainly', async () => {
    const output = await tool.execute({ path: 'nope.md' }, context([workspace]));
    assert.match(output.content, /There is no file at nope\.md/);
  });

  it('reports a directory as not a file', async () => {
    await mkdir(join(workspace, 'src'), { recursive: true });
    const output = await tool.execute({ path: 'src' }, context([workspace]));
    assert.match(output.content, /is not a file/);
  });

  it('refuses a file that is too large without reading it', async () => {
    let read = false;
    const bigTool = createReadFileTool({
      statImpl: () => Promise.resolve({ size: MAX_FILE_BYTES + 1, isFile: () => true }),
      readFileImpl: () => {
        read = true;
        return Promise.resolve(Buffer.from('never'));
      },
    });

    const output = await bigTool.execute({ path: 'notes.md' }, context([workspace]));
    assert.match(output.content, /larger than the 200000 byte limit/);
    assert.equal(read, false);
  });

  it('refuses a binary file', async () => {
    await writeFile(join(workspace, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
    const output = await tool.execute({ path: 'image.bin' }, context([workspace]));
    assert.match(output.content, /looks like a binary file/);
  });

  it('detects binary content by a null byte', () => {
    assert.equal(looksBinary(Buffer.from('plain text')), false);
    assert.equal(looksBinary(Buffer.from([0x41, 0x00, 0x42])), true);
  });

  it('searches every workspace folder', async () => {
    const second = join(workspace, '..', 'second');
    await mkdir(second, { recursive: true });
    await writeFile(join(second, 'other.md'), 'from the second folder', 'utf8');

    const output = await tool.execute({ path: 'other.md' }, context([workspace, second]));
    assert.match(output.content, /from the second folder/);
  });

  it('records a denial as a tool result rather than an exception', async () => {
    const registry = new ToolRegistry();
    registry.register(tool);

    const outcome = await registry.invoke('readFile', { path: '.env' }, context([workspace]));

    assert.match(outcome.content, /was not allowed to run/);
    assert.equal(outcome.record.allowed, false);
    assert.equal(outcome.record.name, 'readFile');
  });
});
