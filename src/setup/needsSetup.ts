import type { SecretName } from '../state/secrets.js';
import type { Agent, CachedModel, EndpointConfig, SourceKind } from '../state/types.js';

const SECRET_BY_KIND: Record<SourceKind, SecretName> = {
  jira: 'jiraToken',
  git: 'gitToken',
};

export type SetupProblem =
  | 'noConsent'
  | 'unknownModel'
  | 'missingEndpoint'
  | 'missingToken'
  | 'outputFolderUnwritable'
  | 'untrustedWorkspace';

export interface AgentReadiness {
  ready: boolean;
  problems: SetupProblem[];
  /** One line, ready to show as a tooltip or a skip reason. */
  reason?: string;
}

const PROBLEM_TEXT: Record<SetupProblem, string> = {
  noConsent: 'access to the language model API has not been granted',
  unknownModel: 'the configured model is not in the current model list',
  missingEndpoint: 'the source connection it references is not configured',
  missingToken: 'no token is stored for its source',
  outputFolderUnwritable: 'its result folder cannot be written to',
  untrustedWorkspace:
    'it may run commands and this workspace is not trusted, so runScript would refuse every one',
};

export interface ReadinessInput {
  agent: Agent;
  hasConsent: boolean;
  models: CachedModel[];
  endpoints: Record<string, EndpointConfig>;
  storedSecrets: SecretName[];
  outputFolderWritable?: boolean;
  /** Absent means trusted; only a definite `false` is a problem. */
  workspaceTrusted?: boolean;
}

/**
 * Decides whether an agent could run right now.
 *
 * The scheduler asks this before every run, and the tree uses it for the warning badge. It
 * is deliberately based on cached information only: finding out whether a model exists must
 * never trigger a consent prompt from a background tick.
 */
export function evaluateReadiness(input: ReadinessInput): AgentReadiness {
  const problems: SetupProblem[] = [];

  if (!input.hasConsent) {
    problems.push('noConsent');
  }
  // An empty cache means the list was never fetched; that is already covered by noConsent,
  // so only a non-empty list can prove a model is gone.
  if (input.models.length > 0 && !input.models.some((model) => model.id === input.agent.modelId)) {
    problems.push('unknownModel');
  }

  const endpoint = input.endpoints[input.agent.source.baseUrlRef];
  if (!endpoint || endpoint.kind !== input.agent.source.kind) {
    problems.push('missingEndpoint');
  }
  if (!input.storedSecrets.includes(SECRET_BY_KIND[input.agent.source.kind])) {
    problems.push('missingToken');
  }
  if (input.outputFolderWritable === false) {
    problems.push('outputFolderUnwritable');
  }
  // Better said now, while somebody is looking at the view, than at 09:00 in a log nobody reads.
  if (input.workspaceTrusted === false && input.agent.tools.includes('runScript')) {
    problems.push('untrustedWorkspace');
  }

  if (problems.length === 0) {
    return { ready: true, problems: [] };
  }
  const listed = problems.map((problem) => PROBLEM_TEXT[problem]);
  const reason =
    listed.length === 1
      ? `This agent cannot run because ${listed[0]}.`
      : `This agent cannot run because ${listed.slice(0, -1).join(', ')} and ${listed[listed.length - 1]}.`;
  return { ready: false, problems, reason };
}
