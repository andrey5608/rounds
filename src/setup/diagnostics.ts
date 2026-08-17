import * as vscode from 'vscode';

import type { Logger } from '../state/logger.js';

/**
 * Extensions that plausibly provide language models.
 *
 * Matching by name is a heuristic, and it is written down as one. The point is not to be exhaustive
 * but to answer the first question a "no models available" report raises: is a provider installed at
 * all, and did it activate? A very common answer is that the completions extension is present while
 * the chat extension, which is the one that registers models, is not.
 */
const PROVIDER_HINT = /copilot|claude|continue|codeium|tabnine|gemini|cody|amazonq/i;

/**
 * Writes what the environment looks like, once, at activation.
 *
 * Everything here is local: it goes to the output channel and to the log file on this machine, and
 * nothing is sent anywhere. It exists so that a report can be diagnosed from the file instead of a
 * conversation.
 */
export function logEnvironment(logger: Logger, context: vscode.ExtensionContext, logPath: string): void {
  const version = (context.extension.packageJSON as { version?: string }).version ?? 'unknown';
  logger.info(`Rounds ${version} on editor ${vscode.version} (${vscode.env.appName}, ${process.platform}).`);
  logger.info(`Extended log: ${logPath}`);
  logger.debug(`Global storage: ${context.globalStorageUri.fsPath}`);
  logger.debug(
    `Language model API present: ${typeof vscode.lm?.selectChatModels === 'function' ? 'yes' : 'no'}.`,
  );

  const providers = vscode.extensions.all
    .filter((extension) => PROVIDER_HINT.test(extension.id))
    .map((extension) => `${extension.id}${extension.isActive ? '' : ' (not active)'}`);
  logger.info(
    providers.length > 0
      ? `Possible language model providers installed: ${providers.join(', ')}.`
      : 'No extension that looks like a language model provider is installed. Chat models come from a provider such as GitHub Copilot Chat; the completions extension alone does not register any.',
  );
}
