import * as vscode from 'vscode';

import type { ServiceContainer } from '../container.js';
import type { Agent, RunRecord } from '../state/types.js';

/** Asks which agent to run when the command was invoked without one. */
export async function pickAgent(
  container: ServiceContainer,
  title: string,
): Promise<Agent | undefined> {
  const state = await container.store.read();
  if (state.agents.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      'There are no agents yet.',
      'Create Agent',
    );
    if (choice === 'Create Agent') {
      await vscode.commands.executeCommand('rounds.createAgent');
    }
    return undefined;
  }
  if (state.agents.length === 1) {
    return state.agents[0];
  }

  const picked = await vscode.window.showQuickPick(
    state.agents.map((agent) => ({
      label: agent.name,
      description: agent.enabled ? undefined : 'disabled',
      detail: agent.source.kind === 'jira' ? agent.source.jql : agent.source.repo,
      agent,
    })),
    { title, ignoreFocusOut: true },
  );
  return picked?.agent;
}

/**
 * The `rounds.runNow` command.
 *
 * Manual runs work in every window, leader or not, and skip the jitter: the user is watching, and
 * a delay meant to spread automated traffic out has no purpose when somebody just pressed a
 * button. The daily limit currently applies to manual runs as well; the confirmation that lets a
 * user exceed it deliberately arrives with the rest of the limit handling in phase 9.
 */
export async function runNowCommand(
  container: ServiceContainer,
  argument?: { agent?: Agent } | Agent,
): Promise<void> {
  // The tree passes its item, the palette passes nothing, and a caller may pass the agent.
  const fromArgument = argument && 'id' in argument ? argument : argument?.agent;
  const agent = fromArgument ?? (await pickAgent(container, 'Which agent should run now?'));
  if (!agent) {
    return;
  }

  container.statusBar.update({ kind: 'running', agentName: agent.name });
  let record: RunRecord;
  try {
    record = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Rounds: running ${agent.name}` },
      () => container.runner.run({ agent, trigger: 'manual' }),
    );
  } finally {
    const state = await container.store.read();
    container.statusBar.update({ kind: 'idle', agentCount: state.agents.length });
    container.agentsView.refresh();
  }

  await report(container, agent, record);
}

/** Tells the user what happened, quietly for a success and actionably for a failure. */
async function report(
  container: ServiceContainer,
  agent: Agent,
  record: RunRecord,
): Promise<void> {
  if (record.status === 'succeeded' && record.resultFilePath) {
    const choice = await vscode.window.showInformationMessage(
      `${agent.name}: ${record.summary}`,
      'Open Result',
    );
    if (choice === 'Open Result') {
      await openResult(record.resultFilePath);
    }
    return;
  }
  if (record.status === 'handedOff' || record.status === 'skipped') {
    await vscode.window.showInformationMessage(`${agent.name}: ${record.summary}`);
    return;
  }

  const choice = await vscode.window.showErrorMessage(
    `${agent.name}: ${record.summary}`,
    'Show Output',
  );
  if (choice === 'Show Output') {
    container.output.show();
  }
}

/** Opens a result file in the editor. */
export async function openResult(path: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  await vscode.window.showTextDocument(document, { preview: false });
}
