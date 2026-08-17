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

export interface LanguageModelGateway {
  /**
   * Resolves the models the user has access to.
   *
   * Must only be called from a user-initiated action: the first call triggers the consent
   * prompt, and a prompt nobody asked for is both confusing and easy to dismiss wrongly.
   */
  selectModels(): Promise<ModelInfo[]>;
}
