import type { SecretName } from '../state/secrets.js';
import type { RoundsSettings } from '../state/settings.js';
import type {
  Agent,
  CachedModel,
  CheckOutcome,
  EndpointConfig,
  SourceKind,
} from '../state/types.js';

export interface EndpointPing {
  ok: boolean;
  message: string;
}

/**
 * Everything the checks need, passed in as plain data and small functions.
 *
 * Written this way so the whole registry is unit testable: every combination of missing
 * prerequisites is a different context object, not a different editor state.
 */
export interface SetupCheckContext {
  settings: RoundsSettings;
  agents: Agent[];
  endpoints: Record<string, EndpointConfig>;
  hasConsent: boolean;
  models: CachedModel[];
  hasSecret: (name: SecretName) => Promise<boolean>;
  /** Live reachability test. Supplied by the connectors; without it the check only warns. */
  pingEndpoint?: (endpoint: EndpointConfig) => Promise<EndpointPing>;
  probeOutputFolder: () => Promise<{ ok: boolean; path: string; message: string }>;
  /** Smallest gap between two runs of a schedule, in minutes. Supplied by the scheduler. */
  minIntervalMinutes?: (expressions: string[]) => number | undefined;
}

export interface SetupCheck {
  id: string;
  title: string;
  /** Command that opens the right place to fix this, when one exists. */
  fixCommand?: string;
  run(context: SetupCheckContext): Promise<CheckOutcome> | CheckOutcome;
}

function outcome(
  check: Pick<SetupCheck, 'id' | 'title'>,
  status: CheckOutcome['status'],
  message: string,
): CheckOutcome {
  return { id: check.id, title: check.title, status, message };
}

const SECRET_BY_KIND: Record<SourceKind, SecretName> = {
  jira: 'jiraToken',
  git: 'gitToken',
};

const KIND_LABEL: Record<SourceKind, string> = {
  jira: 'Issue tracker',
  git: 'Repository host',
};

/** Builds the check for one source kind; the two differ only in labels and keys. */
function sourceCheck(kind: SourceKind): SetupCheck {
  const check = { id: kind, title: `${KIND_LABEL[kind]} connection` };
  return {
    ...check,
    fixCommand: 'rounds.checkSetup',
    async run(context) {
      const endpoints = Object.values(context.endpoints).filter(
        (endpoint) => endpoint.kind === kind,
      );
      const used = context.agents.some((agent) => agent.source.kind === kind);

      if (endpoints.length === 0) {
        return used
          ? outcome(
              check,
              'fail',
              `An agent uses this source but no base URL is configured for it. Add one before the agent can run.`,
            )
          : outcome(
              check,
              'warn',
              'No base URL configured. Add one when you create an agent for this source.',
            );
      }

      if (!(await context.hasSecret(SECRET_BY_KIND[kind]))) {
        return outcome(
          check,
          'fail',
          'A base URL is configured but no token is stored. Enter the token so runs can authenticate.',
        );
      }

      if (!context.pingEndpoint) {
        return outcome(
          check,
          'warn',
          `Configured with ${endpoints.length} base URL(s) and a stored token. Reachability was not verified.`,
        );
      }

      const failures: string[] = [];
      for (const endpoint of endpoints) {
        const ping = await context.pingEndpoint(endpoint);
        if (!ping.ok) {
          failures.push(`${endpoint.name}: ${ping.message}`);
        }
      }
      return failures.length === 0
        ? outcome(check, 'pass', `Reached ${endpoints.length} configured base URL(s).`)
        : outcome(check, 'fail', failures.join('; '));
    },
  };
}

const modelsCheck: SetupCheck = {
  id: 'models',
  title: 'Language model access',
  fixCommand: 'rounds.checkSetup',
  run(context) {
    const check = { id: modelsCheck.id, title: modelsCheck.title };
    if (!context.hasConsent) {
      return outcome(
        check,
        'fail',
        'Access to the language model API has not been granted yet. Grant it to let agents run.',
      );
    }
    if (context.models.length === 0) {
      return outcome(
        check,
        'fail',
        'Access was granted but no models are available. Check that a language model provider, such as GitHub Copilot, is installed and signed in.',
      );
    }
    return outcome(check, 'pass', `${context.models.length} model(s) available.`);
  },
};

const outputFolderCheck: SetupCheck = {
  id: 'outputFolder',
  title: 'Result folder',
  fixCommand: 'rounds.openResultFolder',
  async run(context) {
    const check = { id: outputFolderCheck.id, title: outputFolderCheck.title };
    const probe = await context.probeOutputFolder();
    return outcome(check, probe.ok ? 'pass' : 'fail', probe.message);
  },
};

const scriptWhitelistCheck: SetupCheck = {
  id: 'scriptWhitelist',
  title: 'Script whitelist',
  fixCommand: 'workbench.action.openSettings',
  run(context) {
    const check = { id: scriptWhitelistCheck.id, title: scriptWhitelistCheck.title };
    const entries = context.settings.scriptWhitelist;
    if (entries.length === 0) {
      return outcome(
        check,
        'warn',
        'The whitelist is empty, so the runScript tool refuses every command. Add the commands you want agents to be able to run.',
      );
    }
    return outcome(
      check,
      'pass',
      `${entries.length} command(s) allowed: ${entries.map((entry) => entry.command).join(', ')}.`,
    );
  },
};

const rateLimitsCheck: SetupCheck = {
  id: 'rateLimits',
  title: 'Rate limit safety',
  fixCommand: 'workbench.action.openSettings',
  run(context) {
    const check = { id: rateLimitsCheck.id, title: rateLimitsCheck.title };
    const problems: string[] = [];
    const { jitterSeconds, maxExecutionsPerDay, minimumIntervalWarning } = context.settings;

    if (jitterSeconds === 0) {
      problems.push(
        'Jitter is switched off, so scheduled runs start at exactly the same second every time.',
      );
    }
    if (maxExecutionsPerDay > 100) {
      problems.push(`The daily limit of ${maxExecutionsPerDay} runs is high for automated requests.`);
    }

    if (context.minIntervalMinutes) {
      for (const agent of context.agents.filter((candidate) => candidate.enabled)) {
        const interval = context.minIntervalMinutes(agent.schedule.cronExpressions);
        if (interval !== undefined && interval < minimumIntervalWarning) {
          problems.push(
            `The agent "${agent.name}" runs every ${interval} minute(s), more often than the ${minimumIntervalWarning} minute warning threshold.`,
          );
        }
      }
    }

    if (problems.length > 0) {
      return outcome(check, 'warn', problems.join(' '));
    }
    return outcome(
      check,
      'pass',
      `Jitter up to ${jitterSeconds}s, at most ${maxExecutionsPerDay} run(s) per day.`,
    );
  },
};

/** The checks, in the order the user sees them. */
export const SETUP_CHECKS: SetupCheck[] = [
  modelsCheck,
  sourceCheck('jira'),
  sourceCheck('git'),
  outputFolderCheck,
  scriptWhitelistCheck,
  rateLimitsCheck,
];

/** Runs every check. A check that throws becomes a failure rather than taking the rest down. */
export async function runSetupChecks(context: SetupCheckContext): Promise<CheckOutcome[]> {
  const results: CheckOutcome[] = [];
  for (const check of SETUP_CHECKS) {
    try {
      results.push(await check.run(context));
    } catch (error) {
      results.push({
        id: check.id,
        title: check.title,
        status: 'fail',
        message: `The check itself failed: ${String(error)}`,
      });
    }
  }
  return results;
}

/** The worst status in a set of results, which is what the summary line reports. */
export function worstStatus(results: CheckOutcome[]): CheckOutcome['status'] {
  if (results.some((result) => result.status === 'fail')) {
    return 'fail';
  }
  if (results.some((result) => result.status === 'warn')) {
    return 'warn';
  }
  return 'pass';
}
