import * as vscode from 'vscode';

import type { ServiceContainer } from '../container.js';

import { ROUNDS_QUERY_TOOL, runQuery } from './roundsQuery.js';

/**
 * Registers the read-only tool the chat may call.
 *
 * `registerTool` does not resolve a language model, so the consent gate is untouched: nothing
 * here calls `selectChatModels`, and `check-consent-gate.mjs` keeps reporting one call site. The
 * next reader will wonder, which is why it is written down.
 *
 * Every invocation re-reads the state through the store rather than answering from a snapshot
 * taken at registration: a tool that answers from stale state is worse than no tool, because it
 * is confidently wrong.
 */
export function registerChatTools(container: ServiceContainer): vscode.Disposable {
  return vscode.lm.registerTool(ROUNDS_QUERY_TOOL, {
    prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<{ kind?: string }>) {
      const kind = options.input?.kind ?? 'agents';
      return { invocationMessage: `Reading scheduled agents (${kind})` };
    },

    async invoke(options: vscode.LanguageModelToolInvocationOptions<unknown>) {
      const state = await container.store.read();
      const result = runQuery(options.input, {
        state,
        now: new Date(),
        timeZone: container.settings().timezone,
        secrets: container.secrets.knownValues(),
      });
      container.logger.debug(
        `${ROUNDS_QUERY_TOOL} answered ${result.ok ? 'a question' : `with ${result.reason}`}.`,
      );
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2)),
      ]);
    },
  });
}
