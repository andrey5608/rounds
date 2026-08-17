import * as vscode from 'vscode';

import type { RoundsStore } from '../state/store.js';
import type { RunRecord } from '../state/types.js';

/** Scheme of the read-only detail documents. */
export const RUN_DETAILS_SCHEME = 'rounds';

/** Where a run item points when it is clicked. */
export function runDocumentUri(run: RunRecord): vscode.Uri {
  if (run.resultFilePath) {
    return vscode.Uri.file(run.resultFilePath);
  }
  // A run without a result file still has something to show, so it gets a virtual document
  // instead of a dead click. Chat-mode runs are the common case.
  return vscode.Uri.parse(`${RUN_DETAILS_SCHEME}:/${run.agentId}/${run.id}.md`);
}

/** Renders a run record as Markdown. */
export function renderRunDetails(run: RunRecord, agentName: string): string {
  const lines = [
    `# ${agentName}`,
    '',
    `- Status: **${run.status}**`,
    `- Summary: ${run.summary}`,
    `- Started: ${new Date(run.startedAt).toLocaleString()}`,
  ];
  if (run.finishedAt) {
    lines.push(`- Finished: ${new Date(run.finishedAt).toLocaleString()}`);
  }
  lines.push(
    `- Trigger: ${run.trigger}`,
    `- Mode: ${run.executionMode === 'api' ? 'result captured' : 'handed to chat'}`,
    `- Model: ${run.modelId}`,
    `- Source items: ${run.sourceItemCount}`,
    `- Prompt: ${run.promptResolution.source}${run.promptResolution.path ? ` (${run.promptResolution.path})` : ''}${run.promptResolution.usedSnapshot ? ', from the stored snapshot' : ''}`,
  );
  if (run.jitterSeconds) {
    lines.push(`- Delayed by ${run.jitterSeconds}s before starting`);
  }
  if (run.toolCalls.length > 0) {
    lines.push('', '## Tool calls', '');
    for (const call of run.toolCalls) {
      lines.push(
        `- \`${call.name}\` ${call.allowed ? 'ran' : 'was refused'} in ${call.durationMs} ms${call.error ? ` — ${call.error}` : ''}`,
      );
    }
  }
  if (run.error) {
    lines.push('', '## Error', '', `\`${run.error.code}\``, '', run.error.message);
  }
  if (run.status === 'handedOff') {
    lines.push(
      '',
      '## No output was captured',
      '',
      'This agent runs in chat mode: the prompt was opened in the chat view for review, so Rounds never sees the answer. Switch the agent to the other mode if you want the result stored in a file.',
    );
  } else if (!run.resultFilePath) {
    lines.push('', 'No result file was written for this run.');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Serves the read-only detail documents.
 *
 * A run that produced no file — a skipped one, a failure, a chat handoff — would otherwise be a row
 * that does nothing when clicked, which reads as a broken view rather than as an intentional
 * absence of output.
 */
export function registerRunDetails(
  context: vscode.ExtensionContext,
  store: RoundsStore,
): void {
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: async (uri) => {
      const [, agentId, file] = uri.path.split('/');
      const runId = (file ?? '').replace(/\.md$/, '');
      const state = await store.read();
      const run = state.history[agentId ?? '']?.find((candidate) => candidate.id === runId);
      const agent = state.agents.find((candidate) => candidate.id === agentId);
      if (!run) {
        return 'This run is no longer in the history.\n';
      }
      return renderRunDetails(run, agent?.name ?? 'Unknown agent');
    },
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(RUN_DETAILS_SCHEME, provider),
  );
}
