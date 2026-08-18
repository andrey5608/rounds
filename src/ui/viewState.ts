import { tokenFor } from '../connectors/factory.js';
import type { ServiceContainer } from '../container.js';
import type { EndpointConfig } from '../state/types.js';
import { SECRET_NAMES } from '../state/secrets.js';
import type { SecretName } from '../state/secrets.js';

import { evaluateReadiness } from '../setup/needsSetup.js';

import type { AgentsViewData } from './agentsView.js';
import type { StatusBarState } from './statusBar.js';

/**
 * Builds the snapshot the tree renders from.
 *
 * Gathered in one place so the tree itself stays a pure function of its input, and so the secret
 * lookups happen once per refresh rather than once per row.
 */
export async function buildViewData(container: ServiceContainer): Promise<AgentsViewData> {
  const state = await container.store.read();
  const storedSecrets: SecretName[] = [];
  for (const name of SECRET_NAMES) {
    if (await container.secrets.has(name)) {
      storedSecrets.push(name);
    }
  }
  const settings = container.settings();
  return {
    state,
    storedSecrets,
    settingsTimeZone: settings.timezone,
    minimumIntervalWarning: settings.minimumIntervalWarning,
    workspaceTrusted: container.workspaceTrusted(),
    running: container.runningAgents,
  };
}

/**
 * What the status bar should say right now.
 *
 * Ordered by what the user most needs to know: something is running, then something is wrong, then
 * when the next thing happens.
 */
export function statusFor(data: AgentsViewData, settingsEnabled: boolean): StatusBarState {
  const running = data.state.agents.find((agent) => data.running.has(agent.id));
  if (running) {
    return { kind: 'running', agentName: running.name };
  }
  if (!settingsEnabled) {
    return { kind: 'disabled' };
  }

  const needsSetup = data.state.agents.some(
    (agent) =>
      !evaluateReadiness({
        agent,
        hasConsent: data.state.setup.consentGrantedAt !== undefined,
        models: data.state.setup.models ?? [],
        endpoints: data.state.endpoints,
        storedSecrets: data.storedSecrets,
        workspaceTrusted: data.workspaceTrusted,
      }).ready,
  );
  if (needsSetup) {
    return { kind: 'needsSetup' };
  }

  const failed = data.state.agents.find(
    (agent) => data.state.history[agent.id]?.[0]?.status === 'failed',
  );
  if (failed) {
    return { kind: 'failed', agentName: failed.name };
  }

  const upcoming = data.state.agents
    .filter((agent) => agent.enabled && agent.nextRunAt)
    .map((agent) => new Date(agent.nextRunAt as string))
    .sort((left, right) => left.getTime() - right.getTime());
  return {
    kind: 'idle',
    agentCount: data.state.agents.length,
    nextRunAt: upcoming[0],
  };
}

/** Refreshes both trees and the status bar from the current state. */
export async function refreshView(container: ServiceContainer): Promise<void> {
  const data = await buildViewData(container);
  container.agentsView.setData(data);
  container.statusBar.update(statusFor(data, container.settings().enabled));

  // Which connections can authenticate is a per-connection question now, so it is asked per
  // connection rather than derived from the two shared keys.
  const withToken: string[] = [];
  for (const endpoint of Object.values(data.state.endpoints)) {
    if (await hasToken(container, endpoint)) {
      withToken.push(endpoint.name);
    }
  }
  container.connectionsView.setData({ state: data.state, withToken });
}

async function hasToken(container: ServiceContainer, endpoint: EndpointConfig): Promise<boolean> {
  return (await tokenFor(container.secrets, endpoint)) !== undefined;
}
