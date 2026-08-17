/**
 * The editor's language model API, behind an interface.
 *
 * Two reasons for the indirection. First, the real API can only be called inside an
 * extension host with user consent, which would make every test that touches model code an
 * integration test. Second, it keeps the number of call sites at exactly one, which is what
 * makes the consent rule checkable: see scripts/check-consent-gate.mjs.
 */

export interface ModelInfo {
  /** Stable identifier stored on an agent. A run fails rather than substituting another. */
  id: string;
  name: string;
  vendor: string;
  family: string;
  version?: string;
  maxInputTokens?: number;
}

/** A tool call the model asked for. */
export interface ToolCallRequest {
  callId: string;
  name: string;
  input: unknown;
}

/** One message in the conversation with the model. */
export interface ModelMessage {
  role: 'user' | 'assistant';
  text?: string;
  /** Tool calls the model made, on an assistant message. */
  toolCalls?: ToolCallRequest[];
  /** Results being fed back, on a user message. */
  toolResults?: { callId: string; content: string }[];
}

/** What one exchange with the model produced. */
export interface ModelTurn {
  text: string;
  toolCalls: ToolCallRequest[];
}

export interface ModelRequest {
  /** Exact model identifier. Resolution fails rather than substituting another model. */
  modelId: string;
  messages: ModelMessage[];
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
}

/**
 * How a model is described to a user.
 *
 * Providers do not all fill in every field: a real installation reported `auto` from vendor
 * `copilotcli` with an empty family, which rendered as "copilotcli · " in the picker and
 * "auto (copilotcli/)" in the log. Empty parts are dropped, and the id stands in for a missing name,
 * because a quick pick row with a blank label cannot be chosen with any confidence.
 */
export function describeModel(model: ModelInfo): { label: string; detail: string } {
  const detail = [model.vendor, model.family, model.version]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(' · ');
  return {
    label: model.name.trim().length > 0 ? model.name : model.id,
    detail: detail.length > 0 ? detail : model.id,
  };
}

export interface GatewayDisposable {
  dispose(): void;
}

export interface LanguageModelGateway {
  /**
   * Resolves the models the user has access to.
   *
   * Must only be called from a user-initiated action: the first call triggers the consent
   * prompt, and a prompt nobody asked for is both confusing and easy to dismiss wrongly.
   */
  selectModels(): Promise<ModelInfo[]>;

  /**
   * Sends one request and returns everything it produced.
   *
   * The stream is collected here rather than exposed, because nothing in v1 shows partial
   * output: the result is written to a file once the run finishes.
   */
  sendRequest(request: ModelRequest): Promise<ModelTurn>;

  /**
   * Fires when the set of available models changed.
   *
   * The editor documents that the list "might have changed and extensions should re-query", and this
   * is the only way to tell "no provider" apart from "the provider has not finished starting": a
   * provider that is still initialising reports nothing and then fires this.
   */
  onDidChangeModels?(listener: () => void): GatewayDisposable;
}
