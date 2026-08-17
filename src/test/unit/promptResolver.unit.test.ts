import * as assert from 'node:assert/strict';

import {
  MAX_PROMPT_FILE_BYTES,
  PromptResolver,
  PromptUnavailableError,
  hashContent,
} from '../../agents/promptResolver.js';
import { FixedClock } from '../../state/time.js';
import type { Agent, PromptConfig, PromptFileFallback } from '../../state/types.js';

const NOW = new Date('2026-08-17T06:00:00.000Z');
const FILE_TEXT = 'Summarize {{items}} from the tracker.';
const SNAPSHOT_TEXT = 'An older prompt that was captured earlier.';

function agent(prompt: PromptConfig): Agent {
  return {
    id: 'agent-1',
    name: 'Morning triage',
    enabled: true,
    executionMode: 'api',
    schedule: { cronExpressions: ['0 9 * * *'], runOnStartup: false, missedRunPolicy: 'skip' },
    source: { kind: 'jira', baseUrlRef: 'tracker', jql: 'project = ROUNDS', maxResults: 20 },
    prompt,
    modelId: 'model-a',
    tools: [],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  };
}

function snapshot(): PromptConfig['snapshot'] {
  return {
    content: SNAPSHOT_TEXT,
    hash: hashContent(SNAPSHOT_TEXT),
    capturedAt: '2026-08-10T06:00:00.000Z',
  };
}

interface FakeFile {
  content?: string;
  size?: number;
  error?: Error;
}

function resolver(file: FakeFile, fallback: PromptFileFallback = 'snapshot'): PromptResolver {
  return new PromptResolver({
    workspaceRoot: '/workspace',
    defaultFallback: fallback,
    clock: new FixedClock(NOW),
    statImpl: () => {
      if (file.error) {
        return Promise.reject(file.error);
      }
      return Promise.resolve({ size: file.size ?? (file.content?.length ?? 0) });
    },
    readFileImpl: () => {
      if (file.error) {
        return Promise.reject(file.error);
      }
      return Promise.resolve(file.content ?? '');
    },
  });
}

describe('prompt resolution', () => {
  it('returns an inline prompt as it is', async () => {
    const resolution = await resolver({}).resolve(
      agent({ source: 'inline', inlineText: 'Do the thing.' }),
    );

    assert.equal(resolution.text, 'Do the thing.');
    assert.equal(resolution.usedSnapshot, false);
    assert.deepEqual(resolution.record, { source: 'inline', usedSnapshot: false });
  });

  it('refuses an empty inline prompt', async () => {
    await assert.rejects(
      resolver({}).resolve(agent({ source: 'inline', inlineText: '   ' })),
      (error: unknown) => {
        assert.ok(error instanceof PromptUnavailableError);
        assert.equal(error.code, 'prompt.empty');
        return true;
      },
    );
  });

  it('resolves a relative path against the workspace', () => {
    const path = resolver({}).resolveFilePath(
      agent({ source: 'file', filePath: 'prompts/triage.md' }),
    );
    assert.equal(path, '/workspace/prompts/triage.md');
  });

  it('keeps an absolute path as it is', () => {
    const path = resolver({}).resolveFilePath(
      agent({ source: 'file', filePath: '/elsewhere/triage.md' }),
    );
    assert.equal(path, '/elsewhere/triage.md');
  });

  it('reads the file and reports the hash and path', async () => {
    const resolution = await resolver({ content: FILE_TEXT }).resolve(
      agent({ source: 'file', filePath: '/prompt.md' }),
    );

    assert.equal(resolution.text, FILE_TEXT);
    assert.equal(resolution.usedSnapshot, false);
    assert.equal(resolution.hash, hashContent(FILE_TEXT));
    assert.deepEqual(resolution.record, {
      source: 'file',
      path: '/prompt.md',
      usedSnapshot: false,
      hash: hashContent(FILE_TEXT),
    });
  });

  it('offers a refreshed snapshot when the file changed', async () => {
    const resolution = await resolver({ content: FILE_TEXT }).resolve(
      agent({ source: 'file', filePath: '/prompt.md', snapshot: snapshot() }),
    );

    assert.equal(resolution.refreshedSnapshot?.content, FILE_TEXT);
    assert.equal(resolution.refreshedSnapshot?.capturedAt, NOW.toISOString());
  });

  it('offers no refresh when the file matches the snapshot', async () => {
    const resolution = await resolver({ content: SNAPSHOT_TEXT }).resolve(
      agent({ source: 'file', filePath: '/prompt.md', snapshot: snapshot() }),
    );
    assert.equal(resolution.refreshedSnapshot, undefined);
  });

  it('fails when a file prompt has no path stored', async () => {
    await assert.rejects(
      resolver({}).resolve(agent({ source: 'file' })),
      (error: unknown) => {
        assert.ok(error instanceof PromptUnavailableError);
        assert.equal(error.code, 'prompt.unavailable');
        return true;
      },
    );
  });
});

describe('prompt file fallback matrix', () => {
  const unreadable: FakeFile[] = [
    { error: new Error('ENOENT: no such file') },
    { content: '   ' },
    { content: 'x', size: MAX_PROMPT_FILE_BYTES + 1 },
  ];

  it('uses the snapshot under the snapshot policy', async () => {
    for (const file of unreadable) {
      const resolution = await resolver(file, 'snapshot').resolve(
        agent({ source: 'file', filePath: '/prompt.md', snapshot: snapshot() }),
      );
      assert.equal(resolution.text, SNAPSHOT_TEXT);
      assert.equal(resolution.usedSnapshot, true);
      assert.equal(resolution.record.usedSnapshot, true);
    }
  });

  it('fails under the snapshot policy when there is no snapshot', async () => {
    await assert.rejects(
      resolver(unreadable[0] as FakeFile, 'snapshot').resolve(
        agent({ source: 'file', filePath: '/prompt.md' }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof PromptUnavailableError);
        assert.equal(error.code, 'prompt.unavailable');
        return true;
      },
    );
  });

  it('fails with a snapshot present under blockWhenResolvable', async () => {
    await assert.rejects(
      resolver(unreadable[0] as FakeFile, 'blockWhenResolvable').resolve(
        agent({ source: 'file', filePath: '/prompt.md', snapshot: snapshot() }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof PromptUnavailableError);
        assert.equal(error.code, 'prompt.fileUnreadable');
        assert.match(error.message, /stop rather than run on the stored snapshot/);
        return true;
      },
    );
  });

  it('fails without a snapshot under blockWhenResolvable', async () => {
    await assert.rejects(
      resolver(unreadable[0] as FakeFile, 'blockWhenResolvable').resolve(
        agent({ source: 'file', filePath: '/prompt.md' }),
      ),
      PromptUnavailableError,
    );
  });

  it('fails either way under blockAlways', async () => {
    for (const config of [
      { source: 'file' as const, filePath: '/prompt.md', snapshot: snapshot() },
      { source: 'file' as const, filePath: '/prompt.md' },
    ]) {
      await assert.rejects(
        resolver(unreadable[0] as FakeFile, 'blockAlways').resolve(agent(config)),
        PromptUnavailableError,
      );
    }
  });

  it('still uses a readable file under every policy', async () => {
    for (const fallback of ['snapshot', 'blockWhenResolvable', 'blockAlways'] as const) {
      const resolution = await resolver({ content: FILE_TEXT }, fallback).resolve(
        agent({ source: 'file', filePath: '/prompt.md', snapshot: snapshot() }),
      );
      assert.equal(resolution.text, FILE_TEXT, `policy ${fallback}`);
    }
  });

  it('lets an agent override the setting', async () => {
    // The setting says snapshot, the agent says block; the agent wins.
    await assert.rejects(
      resolver(unreadable[0] as FakeFile, 'snapshot').resolve(
        agent({
          source: 'file',
          filePath: '/prompt.md',
          snapshot: snapshot(),
          fallback: 'blockAlways',
        }),
      ),
      PromptUnavailableError,
    );
  });
});
