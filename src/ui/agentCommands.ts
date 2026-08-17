import * as vscode from 'vscode';

import { resolveOutputFolder } from '../setup/outputFolder.js';
import { removeAgentHistory } from '../state/history.js';
import type { Agent } from '../state/types.js';
import type { ServiceContainer } from '../container.js';

import { pickAgent } from './runNowCommand.js';
import { runDocumentUri } from './runDetails.js';
import { refreshView } from './viewState.js';
import { agentWizard } from './wizard/agentWizard.js';
import { deleteConfirmation, duplicateAgent } from './wizard/steps.js';

/** Pulls the agent out of a tree item argument, or asks for one. */
async function resolveAgent(
  container: ServiceContainer,
  argument: unknown,
  title: string,
): Promise<Agent | undefined> {
  if (argument && typeof argument === 'object') {
    if ('agent' in argument) {
      return (argument as { agent: Agent }).agent;
    }
    if ('id' in argument && 'name' in argument) {
      return argument as Agent;
    }
  }
  return pickAgent(container, title);
}

export async function createAgentCommand(container: ServiceContainer): Promise<void> {
  const agent = await agentWizard(container);
  if (!agent) {
    return;
  }
  await container.ticker.recomputeAll();
  await refreshView(container);
  const choice = await vscode.window.showInformationMessage(
    `The agent "${agent.name}" was created.`,
    'Run Now',
  );
  if (choice === 'Run Now') {
    await vscode.commands.executeCommand('rounds.runNow', agent);
  }
}

export async function editAgentCommand(
  container: ServiceContainer,
  argument?: unknown,
): Promise<void> {
  const agent = await resolveAgent(container, argument, 'Which agent would you like to edit?');
  if (!agent) {
    return;
  }
  const updated = await agentWizard(container, agent);
  if (!updated) {
    return;
  }
  // A changed schedule or time zone makes the stored next run meaningless.
  await container.ticker.recomputeAll();
  await refreshView(container);
}

export async function duplicateAgentCommand(
  container: ServiceContainer,
  argument?: unknown,
): Promise<void> {
  const agent = await resolveAgent(container, argument, 'Which agent would you like to copy?');
  if (!agent) {
    return;
  }
  const state = await container.store.read();
  const copy = duplicateAgent(agent, state.agents, new Date());
  await container.store.update((draft) => {
    draft.agents.push(copy);
  });
  await refreshView(container);
  await vscode.window.showInformationMessage(
    `Created "${copy.name}". It is disabled, so it will not run until you enable it.`,
  );
}

export async function deleteAgentCommand(
  container: ServiceContainer,
  argument?: unknown,
): Promise<void> {
  const agent = await resolveAgent(container, argument, 'Which agent would you like to delete?');
  if (!agent) {
    return;
  }
  const state = await container.store.read();
  const runCount = state.history[agent.id]?.length ?? 0;

  const choice = await vscode.window.showWarningMessage(
    deleteConfirmation(agent, runCount),
    { modal: true },
    'Delete',
  );
  if (choice !== 'Delete') {
    return;
  }

  await container.store.update((draft) => {
    draft.agents = draft.agents.filter((candidate) => candidate.id !== agent.id);
    removeAgentHistory(draft, agent.id);
    delete draft.runClaims[agent.id];
  });
  // Tokens are shared between agents of the same source kind, so deleting one agent must not take
  // the credentials of the others with it.
  container.logger.info(`Deleted the agent "${agent.name}".`);
  await refreshView(container);
}

export async function toggleAgentCommand(
  container: ServiceContainer,
  argument?: unknown,
): Promise<void> {
  const agent = await resolveAgent(container, argument, 'Which agent would you like to switch?');
  if (!agent) {
    return;
  }
  const enabled = !agent.enabled;
  await container.store.update((draft) => {
    const stored = draft.agents.find((candidate) => candidate.id === agent.id);
    if (stored) {
      stored.enabled = enabled;
      stored.updatedAt = new Date().toISOString();
      if (!enabled) {
        stored.nextRunAt = undefined;
      }
    }
  });
  if (enabled) {
    await container.ticker.recomputeAll();
  }
  await refreshView(container);
  container.logger.info(`Agent "${agent.name}" is now ${enabled ? 'enabled' : 'disabled'}.`);
}

export async function openResultFolderCommand(
  container: ServiceContainer,
  argument?: unknown,
): Promise<void> {
  const agent = await resolveAgent(container, argument, 'Whose results would you like to open?');
  const folder = resolveOutputFolder({
    agentFolder: agent?.outputFolder,
    settingFolder: container.settings().defaultOutputFolder,
    globalStorage: container.extensionContext.globalStorageUri.fsPath,
  });
  const uri = vscode.Uri.file(folder);
  await vscode.workspace.fs.createDirectory(uri);
  await vscode.commands.executeCommand('revealFileInOS', uri);
}

export async function showHistoryCommand(
  container: ServiceContainer,
  argument?: unknown,
): Promise<void> {
  const agent = await resolveAgent(container, argument, 'Whose history would you like to see?');
  if (!agent) {
    return;
  }
  const runs = await container.history.recent(agent.id, 50);
  if (runs.length === 0) {
    await vscode.window.showInformationMessage(`"${agent.name}" has not run yet.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    runs.map((run) => ({
      label: `${statusIcon(run.status)} ${new Date(run.startedAt).toLocaleString()}`,
      description: run.status,
      detail: run.summary,
      run,
    })),
    { title: `Runs of "${agent.name}"`, ignoreFocusOut: true },
  );
  if (!picked) {
    return;
  }
  await vscode.commands.executeCommand('vscode.open', runDocumentUri(picked.run));
}

function statusIcon(status: string): string {
  switch (status) {
    case 'succeeded':
      return '$(pass)';
    case 'failed':
      return '$(error)';
    case 'handedOff':
      return '$(comment-discussion)';
    case 'running':
      return '$(sync~spin)';
    case 'interrupted':
      return '$(warning)';
    default:
      return '$(debug-step-over)';
  }
}
