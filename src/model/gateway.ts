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
}
