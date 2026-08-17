import * as vscode from 'vscode';

import { ConfigError } from '../connectors/errors.js';

import type {
  LanguageModelGateway,
  ModelInfo,
  ModelMessage,
  ModelRequest,
  ModelTurn,
  ToolCallRequest,
} from './gateway.js';

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
    const models = await this.resolveAll();
    return models.map((model) => ({
      id: model.id,
      name: model.name,
      vendor: model.vendor,
      family: model.family,
      version: model.version,
      maxInputTokens: model.maxInputTokens,
    }));
  }

  async sendRequest(request: ModelRequest): Promise<ModelTurn> {
    const models = await this.resolveAll();
    const model = models.find((candidate) => candidate.id === request.modelId);
    if (!model) {
      throw new ConfigError(
        `The model "${request.modelId}" is not available any more. Edit the agent and pick one of: ${models.map((candidate) => candidate.id).join(', ')}.`,
      );
    }

    const response = await model.sendRequest(
      request.messages.map(toChatMessage),
      {
        tools: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        })),
      },
    );

    let text = '';
    const toolCalls: ToolCallRequest[] = [];
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({ callId: part.callId, name: part.name, input: part.input });
      }
    }
    return { text, toolCalls };
  }

  private resolveAll(): Thenable<vscode.LanguageModelChat[]> {
    return vscode.lm.selectChatModels();
  }
}

/**
 * Translates one of our messages into the editor's shape.
 *
 * Tool calls and their results have to travel back to the model in the same conversation,
 * otherwise the second turn has no idea what the first one asked for.
 */
function toChatMessage(message: ModelMessage): vscode.LanguageModelChatMessage {
  const text =
    message.text !== undefined && message.text.length > 0
      ? [new vscode.LanguageModelTextPart(message.text)]
      : [];

  // The editor keeps the two roles apart: an assistant message may carry tool calls, a user
  // message may carry their results. Mixing them is a type error, and rightly so.
  if (message.role === 'assistant') {
    const calls = (message.toolCalls ?? []).map(
      (call) => new vscode.LanguageModelToolCallPart(call.callId, call.name, call.input as object),
    );
    return vscode.LanguageModelChatMessage.Assistant([...text, ...calls]);
  }

  const results = (message.toolResults ?? []).map(
    (result) =>
      new vscode.LanguageModelToolResultPart(result.callId, [
        new vscode.LanguageModelTextPart(result.content),
      ]),
  );
  return vscode.LanguageModelChatMessage.User([...text, ...results]);
}
