import * as vscode from 'vscode';

import type { LanguageModelGateway, ModelInfo } from './gateway.js';

/**
 * The only place in this code base that resolves language models.
 *
 * `selectChatModels` triggers the consent prompt on its first call, so it must never run
 * during activation or from a scheduler tick. The consent gate is what enforces that; this
 * file only performs the call. Adding a second call site elsewhere breaks
 * scripts/check-consent-gate.mjs on purpose.
 */
export class VscodeLanguageModelGateway implements LanguageModelGateway {
  async selectModels(): Promise<ModelInfo[]> {
    const models = await vscode.lm.selectChatModels();
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      vendor: model.vendor,
      family: model.family,
      version: model.version,
      maxInputTokens: model.maxInputTokens,
    }));
  }
}
