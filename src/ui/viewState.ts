import type { ServiceContainer } from '../container.js';
import { SECRET_NAMES } from '../state/secrets.js';
import type { SecretName } from '../state/secrets.js';

import type { AgentsViewData } from './agentsView.js';

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
    running: container.runningAgents,
  };
}

/** Refreshes the tree from the current state. Cheap enough to call on any change. */
export async function refreshView(container: ServiceContainer): Promise<void> {
  container.agentsView.setData(await buildViewData(container));
}
