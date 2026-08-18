import * as vscode from 'vscode';

import { ConfigError } from '../connectors/errors.js';

import { dump } from '../state/dump.js';

import { describeModel } from './gateway.js';
import type {
  GatewayDisposable,
  LanguageModelGateway,
  ModelInfo,
  ModelMessage,
  ModelRequest,
  ModelTurn,
  ToolCallRequest,
} from './gateway.js';

/**
 * Vendors asked for explicitly when a bare request comes back empty.
 *
 * Consent is an authentication dialog, and the editor can only raise it for a provider it knows is
 * being asked for. A request with no selector returns the models this extension is *already* allowed
 * to use — which, before consent, is none, and no dialog appears. Naming the vendor is what turns
 * "nothing happened" into a prompt. One entry per known provider; adding another is one line.
 */
const CONSENT_VENDORS = ['copilot'];

/**
 * The only place in this code base that resolves language models.
 *
 * `selectChatModels` triggers the consent prompt on its first call, so it must never run
 * during activation or from a scheduler tick. The consent gate is what enforces that; this
 * file only performs the call. Adding a second call site elsewhere breaks
 * scripts/check-consent-gate.mjs on purpose.
 */
interface PartShape {
  kind: string;
  text?: string;
  toolCall?: ToolCallRequest;
}

/**
 * Works out what one streamed part is.
 *
 * `instanceof` alone was not enough: a part that fails both checks was silently dropped, which is
 * exactly what "the model returned no text" looked like from the outside. The structural fallback
 * catches a part that carries the same fields under a different identity, and anything left over is
 * logged whole rather than ignored.
 */
export function readPart(part: unknown): PartShape {
  if (part instanceof vscode.LanguageModelTextPart) {
    return { kind: 'text', text: part.value };
  }
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return {
      kind: 'toolCall',
      toolCall: { callId: part.callId, name: part.name, input: part.input },
    };
  }

  const candidate = part as { value?: unknown; callId?: unknown; name?: unknown; input?: unknown };
  if (typeof candidate?.value === 'string') {
    return { kind: `text (${describeIdentity(part)})`, text: candidate.value };
  }
  if (typeof candidate?.callId === 'string' && typeof candidate?.name === 'string') {
    return {
      kind: `toolCall (${describeIdentity(part)})`,
      toolCall: { callId: candidate.callId, name: candidate.name, input: candidate.input },
    };
  }
  return { kind: `unknown (${describeIdentity(part)})` };
}

function describeIdentity(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return typeof value;
  }
  return value.constructor?.name ?? 'object';
}

export class VscodeLanguageModelGateway implements LanguageModelGateway {
  /** Optional, so tests and callers that do not care are unaffected. */
  constructor(
    private readonly log?: (message: string) => void,
    private readonly debug?: (message: string) => void,
  ) {}

  async selectModels(): Promise<ModelInfo[]> {
    this.log?.('Asking the editor for the models this extension may use.');
    let models = await this.resolveAll();
    this.log?.(`A request with no selector returned ${models.length} model(s).`);

    if (models.length === 0) {
      for (const vendor of CONSENT_VENDORS) {
        try {
          models = await vscode.lm.selectChatModels({ vendor });
          this.log?.(`A request for vendor "${vendor}" returned ${models.length} model(s).`);
        } catch (error) {
          // A provider that refuses is information, not a reason to stop asking the others.
          this.log?.(`A request for vendor "${vendor}" failed: ${String(error)}`);
          continue;
        }
        if (models.length > 0) {
          break;
        }
      }
    }
    if (models.length > 0) {
      this.log?.(
        `Models available: ${models
          .map((model) => {
            const described = describeModel({
              id: model.id,
              name: model.name,
              vendor: model.vendor,
              family: model.family,
              version: model.version,
            });
            return `${model.id} (${described.detail})`;
          })
          .join(', ')}.`,
      );
    }
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

    this.debug?.(`Request sent to ${request.modelId}:\n${dump(request)}`);

    let text = '';
    const toolCalls: ToolCallRequest[] = [];
    const kinds: string[] = [];

    for await (const part of response.stream) {
      const shape = readPart(part);
      kinds.push(shape.kind);

      if (shape.text !== undefined) {
        text += shape.text;
      } else if (shape.toolCall) {
        toolCalls.push(shape.toolCall);
      }
    }

    this.log?.(
      `The model streamed ${kinds.length} part(s) [${kinds.join(', ') || 'none'}]: ${text.length} character(s) of text, ${toolCalls.length} tool call(s).`,
    );
    this.debug?.(`Collected response:\n${dump({ text, toolCalls })}`);
    return { text, toolCalls };
  }

  onDidChangeModels(listener: () => void): GatewayDisposable {
    return vscode.lm.onDidChangeChatModels(listener);
  }

  private resolveAll(): Thenable<vscode.LanguageModelChat[]> {
    // No selector: the editor returns every model this extension may use. A vendor-specific selector
    // would quietly exclude any provider other than the one named.
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
