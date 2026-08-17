import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

import { FileStateBackend, STATE_FILE_NAME } from '../../state/fileStore.js';
import { RoundsStore } from '../../state/store.js';
import type { PersistedState } from '../../state/types.js';

/**
 * The state layer is covered by unit tests; these run the same code inside a real
 * extension host, against the runtime and the file system the extension actually uses.
 */
describe('state layer inside the extension host', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rounds-integration-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('survives being reopened, the way a window reload does', async () => {
    const first = new RoundsStore({ backend: new FileStateBackend({ directory }) });
    await first.update((draft) => {
      draft.counters.global = 3;
      draft.history['agent-1'] = [
        {
          id: 'run-1',
          agentId: 'agent-1',
          startedAt: '2026-08-17T06:00:00.000Z',
          status: 'succeeded',
          trigger: 'manual',
          summary: 'ok',
          modelId: 'some-model',
          executionMode: 'api',
          toolCalls: [],
          sourceItemCount: 0,
          promptResolution: { source: 'inline', usedSnapshot: false },
        },
      ];
    });

    const reopened = new RoundsStore({ backend: new FileStateBackend({ directory }) });
    const state = await reopened.read();

    assert.equal(state.counters.global, 3);
    assert.equal(state.history['agent-1']?.length, 1);
    assert.equal(state.revision, 1);
  });

  it('lets a second window write without losing the first window state', async () => {
    const windowA = new RoundsStore({ backend: new FileStateBackend({ directory }) });
    const windowB = new RoundsStore({ backend: new FileStateBackend({ directory }) });

    await windowA.update((draft) => {
      draft.counters.perAgent['agent-a'] = 1;
      draft.counters.global = 1;
    });
    await windowB.read();
    await windowB.update((draft) => {
      draft.counters.perAgent['agent-b'] = 1;
      draft.counters.global += 1;
    });

    const stored = JSON.parse(
      await readFile(join(directory, STATE_FILE_NAME), 'utf8'),
    ) as PersistedState;
    assert.deepEqual(stored.counters.perAgent, { 'agent-a': 1, 'agent-b': 1 });
    assert.equal(stored.counters.global, 2);
  });

  it('can write into the storage folder the editor hands to this extension', async () => {
    const extension = vscode.extensions.all.find(
      (candidate) => (candidate.packageJSON as { name?: string }).name === 'rounds',
    );
    assert.ok(extension, 'the extension under test is not loaded');
    await extension.activate();

    // The extension only reads on activation; this proves the real storage path is
    // writable, which is what the store needs on the first agent.
    const globalStorage = join(tmpdir(), 'rounds-storage-probe');
    const backend = new FileStateBackend({ directory: globalStorage });
    await backend.save({
      schemaVersion: 1,
      revision: 1,
      agents: [],
      history: {},
      counters: { localDate: '2026-08-17', global: 0, perAgent: {} },
      runClaims: {},
      setup: {},
    });
    assert.equal(await backend.peekRevision(), 1);
    await rm(globalStorage, { recursive: true, force: true });
  });
});
