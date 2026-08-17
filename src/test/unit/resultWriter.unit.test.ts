import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ResultWriter,
  renderFrontMatter,
  slugify,
  summarize,
  timestampFor,
} from '../../agents/resultWriter.js';
import type { ResultFileRequest } from '../../agents/resultWriter.js';
import type { RunRecord } from '../../state/types.js';

const STARTED = new Date('2026-08-17T22:30:45.000Z');

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'run-1',
    agentId: 'agent-1',
    startedAt: STARTED.toISOString(),
    finishedAt: '2026-08-17T22:31:00.000Z',
    status: 'succeeded',
    trigger: 'manual',
    summary: 'Two issues need attention.',
    modelId: 'model-a',
    executionMode: 'api',
    toolCalls: [
      { name: 'readFile', inputSummary: '{"path":"notes.md"}', allowed: true, durationMs: 12, outputBytes: 40, truncated: false },
    ],
    sourceItemCount: 2,
    promptResolution: { source: 'file', path: '/workspace/prompt.md', usedSnapshot: false, hash: 'abc' },
    ...overrides,
  };
}

function request(folder: string, overrides: Partial<ResultFileRequest> = {}): ResultFileRequest {
  return {
    folder,
    agentName: 'Morning triage',
    startedAt: STARTED,
    timeZone: 'UTC',
    record: record(),
    sourceItemIds: ['ROUNDS-1', 'ROUNDS-2'],
    truncated: false,
    body: '# Summary\n\nTwo issues need attention.',
    ...overrides,
  };
}

describe('result file naming', () => {
  it('slugifies an agent name', () => {
    assert.equal(slugify('Morning triage'), 'morning-triage');
    assert.equal(slugify('  Weird///name!!  '), 'weird-name');
    // Accented letters decompose to their base letter rather than disappearing. Written with
    // escapes so the English-only guard stays strict about literal non-English letters.
    assert.equal(slugify('\u00DCn\u00EFc\u00F6d\u00E9 name'), 'unicode-name');
    assert.equal(slugify('!!!'), 'agent');
  });

  it('caps a very long name', () => {
    assert.ok(slugify('x'.repeat(200)).length <= 60);
  });

  it('formats the timestamp in the effective time zone', () => {
    assert.equal(timestampFor(STARTED, 'UTC'), '20260817-223045');
    // The same instant is already the next day in Tokyo.
    assert.equal(timestampFor(STARTED, 'Asia/Tokyo'), '20260818-073045');
  });
});

describe('front matter', () => {
  it('lists every field the specification asks for', () => {
    const text = renderFrontMatter(request('/results'));

    assert.match(text, /^---\n/);
    assert.match(text, /\nagent: Morning triage\n/);
    assert.match(text, /\nagentId: agent-1\n/);
    assert.match(text, /\nmodel: model-a\n/);
    assert.match(text, /\nmode: api\n/);
    assert.match(text, /\ntrigger: manual\n/);
    assert.match(text, /\nstatus: succeeded\n/);
    assert.match(text, /\nsourceItems: \[ROUNDS-1, ROUNDS-2\]\n/);
    assert.match(text, /\ntoolCalls: \[\{ name: readFile, allowed: true, durationMs: 12 \}\]\n/);
    assert.match(text, /\npromptSource: file\n/);
    assert.match(text, /\npromptFile: \/workspace\/prompt.md\n/);
    assert.match(text, /\nusedPromptSnapshot: false\n/);
    assert.match(text, /\ntruncated: false\n/);
    assert.match(text, /\n---$/);
  });

  it('records the error code of a failed run', () => {
    const text = renderFrontMatter(
      request('/results', {
        record: record({ status: 'failed', error: { code: 'model.quotaExceeded', message: 'no' } }),
      }),
    );
    assert.match(text, /\nstatus: failed\n/);
    assert.match(text, /\nerrorCode: model.quotaExceeded\n/);
  });

  it('leaves the prompt file out for an inline prompt', () => {
    const text = renderFrontMatter(
      request('/results', {
        record: record({ promptResolution: { source: 'inline', usedSnapshot: false } }),
      }),
    );
    assert.ok(!text.includes('promptFile:'));
  });

  it('quotes values that would otherwise look like YAML structure', () => {
    const text = renderFrontMatter(request('/results', { agentName: 'triage: urgent' }));
    assert.match(text, /\nagent: "triage: urgent"\n/);
  });
});

describe('result writer', () => {
  let folder: string;

  beforeEach(async () => {
    folder = join(await mkdtemp(join(tmpdir(), 'rounds-results-')), 'results');
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('creates the folder and writes the file', async () => {
    const path = await new ResultWriter().write(request(folder));

    assert.equal(path, join(folder, 'morning-triage-20260817-223045.md'));
    const content = await readFile(path, 'utf8');
    assert.match(content, /^---\n/);
    assert.match(content, /Two issues need attention\.\n$/);
  });

  it('leaves no temporary file behind', async () => {
    await new ResultWriter().write(request(folder));
    assert.deepEqual(await readdir(folder), ['morning-triage-20260817-223045.md']);
  });

  it('avoids overwriting an existing result from the same second', async () => {
    const writer = new ResultWriter();
    const first = await writer.write(request(folder));
    const second = await writer.write(request(folder));
    const third = await writer.write(request(folder));

    assert.notEqual(first, second);
    assert.match(second, /-2\.md$/);
    assert.match(third, /-3\.md$/);
    assert.equal((await readdir(folder)).length, 3);
  });

  it('reports a folder it cannot create', async () => {
    const writer = new ResultWriter({
      mkdirImpl: () => Promise.reject(new Error('read-only file system')),
    });
    await assert.rejects(writer.write(request(folder)), /read-only file system/);
  });

  it('renames into place so a half-written file is never visible', async () => {
    const order: string[] = [];
    const writer = new ResultWriter({
      mkdirImpl: () => {
        order.push('mkdir');
        return Promise.resolve();
      },
      writeFileImpl: (path) => {
        order.push(`write ${path.endsWith('.md') ? 'final' : 'temporary'}`);
        return Promise.resolve();
      },
      renameImpl: () => {
        order.push('rename');
        return Promise.resolve();
      },
      existsImpl: () => Promise.resolve(false),
    });

    await writer.write(request(folder));
    assert.deepEqual(order, ['mkdir', 'write temporary', 'rename']);
  });
});

describe('run summary', () => {
  it('takes the first non-empty line', () => {
    assert.equal(summarize('\n\nTwo issues need attention.\nMore detail.'), 'Two issues need attention.');
  });

  it('strips a leading heading marker', () => {
    assert.equal(summarize('# Summary\n\nDetails follow.'), 'Summary');
  });

  it('caps a very long line', () => {
    const summary = summarize('x'.repeat(500));
    assert.equal(summary.length, 120);
    assert.match(summary, /…$/);
  });

  it('says so when there is no text at all', () => {
    assert.equal(summarize('   \n\n  '), 'The model returned no text.');
  });
});
