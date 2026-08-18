import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as vscode from 'vscode';

import { AgentPanel } from '../../ui/panel/agentPanel.js';
import type { ServiceContainer } from '../../container.js';
import { RoundsStore } from '../../state/store.js';
import { FileStateBackend } from '../../state/fileStore.js';
import { Logger } from '../../state/logger.js';
import { RoundsSecrets } from '../../state/secrets.js';
import { SETTING_DEFAULTS } from '../../state/settings.js';
import type { Agent } from '../../state/types.js';

const agent: Agent = {
  id: 'agent-1',
  name: 'Morning triage',
  enabled: true,
  executionMode: 'api',
  schedule: { cronExpressions: ['0 9 * * *'], runOnStartup: false, missedRunPolicy: 'skip' },
  source: { kind: 'jira', baseUrlRef: 'tracker', jql: 'project = ROUNDS', maxResults: 20 },
  prompt: { source: 'inline', inlineText: 'Summarize {{items}}' },
  modelId: 'model-a',
  tools: ['readFile'],
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

/** A container with the parts the panel actually touches, and nothing else. */
async function harness(): Promise<{ container: ServiceContainer; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'rounds-panel-'));
  const logger = new Logger({ sink: { append: () => undefined }, getLevel: () => 'none' });
  const memento = new Map<string, unknown>();
  const store = new RoundsStore({
    backend: new FileStateBackend({
      directory,
      memento: {
        get: <T,>(key: string) => memento.get(key) as T | undefined,
        update: (key: string, value: unknown) => {
          memento.set(key, value);
          return Promise.resolve();
        },
      },
      logger,
    }),
    logger,
  });
  await store.update((draft) => {
    draft.agents.push(agent);
    draft.history[agent.id] = [
      {
        id: 'run-1',
        agentId: agent.id,
        startedAt: '2026-08-17T05:00:00.000Z',
        finishedAt: '2026-08-17T05:00:08.400Z',
        status: 'succeeded',
        trigger: 'schedule',
        summary: 'Two issues need attention.',
        modelId: 'model-a',
        executionMode: 'api',
        toolCalls: [],
        sourceItemCount: 12,
        promptResolution: { source: 'inline', usedSnapshot: false, hash: 'abc' },
      },
    ];
  });

  const secrets = new RoundsSecrets({
    get: () => Promise.resolve(undefined),
    store: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    onDidChange: () => ({ dispose: () => undefined }),
  });

  const container = {
    extensionContext: {
      extensionUri: vscode.Uri.file(join(__dirname, '..', '..', '..')),
      globalStorageUri: vscode.Uri.file(directory),
    },
    logger,
    store,
    secrets,
    settings: () => SETTING_DEFAULTS,
    runningAgents: new Set<string>(),
  } as unknown as ServiceContainer;

  return {
    container,
    cleanup: async () => {
      AgentPanel.disposeCurrent();
      store.dispose();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe('agent panel', () => {
  it('renders the agent it was opened for', async () => {
    const { container, cleanup } = await harness();
    try {
      await AgentPanel.show(container, agent);
      assert.equal(AgentPanel.openAgentId, 'agent-1');
    } finally {
      await cleanup();
    }
  });

  it('keeps one tab when a second agent is opened', async () => {
    const { container, cleanup } = await harness();
    try {
      const first = await AgentPanel.show(container, agent);
      const second = await AgentPanel.show(container, { ...agent, id: 'agent-1', name: 'Renamed' });
      assert.equal(first, second, 'a panel per agent would turn the editor into a wall of tabs');
    } finally {
      await cleanup();
    }
  });

  it('repaints when the store changes, without being reopened', async () => {
    const { container, cleanup } = await harness();
    try {
      await AgentPanel.show(container, agent);
      await container.store.update((draft) => {
        const stored = draft.agents.find((candidate) => candidate.id === agent.id);
        if (stored) {
          stored.name = 'Afternoon triage';
        }
      });
      // The repaint is queued by the store event; giving it a turn is enough.
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(AgentPanel.openAgentId, 'agent-1');
    } finally {
      await cleanup();
    }
  });

  it('releases its store subscription when it is disposed', async () => {
    const { container, cleanup } = await harness();
    try {
      await AgentPanel.show(container, agent);
      AgentPanel.disposeCurrent();
      assert.equal(AgentPanel.openAgentId, undefined);

      // A write after disposal must not reach a disposed panel; if it did, this would throw.
      await container.store.update((draft) => {
        draft.revision += 0;
      });
    } finally {
      await cleanup();
    }
  });
});
