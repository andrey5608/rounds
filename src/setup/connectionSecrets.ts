import { randomUUID } from 'node:crypto';

import { SECRET_BY_KIND } from '../connectors/factory.js';
import type { RoundsSecrets } from '../state/secrets.js';
import type { RoundsStore, StoreLogger } from '../state/store.js';

/**
 * Gives every connection a token of its own.
 *
 * Until phase 18 there was one key per source kind, which was fine while there was one repository
 * host API. With GitHub, Bitbucket Cloud and self-hosted Bitbucket all supported, two repository
 * connections shared one token and the second one silently authenticated as the first.
 *
 * The migration is deliberately additive: the token is copied to the connection's own key and the
 * shared key is left alone. A token that vanishes because a migration ran in the wrong window is
 * unrecoverable — nobody keeps a copy — so the old key stays as a fallback and is removed by hand
 * later, if ever. Running twice is harmless: a connection that already has a `secretRef` with a
 * stored value is skipped.
 */
export async function migrateConnectionSecrets(
  store: RoundsStore,
  secrets: RoundsSecrets,
  logger?: StoreLogger,
): Promise<number> {
  const state = await store.read();
  const pending = Object.values(state.endpoints).filter((endpoint) => !endpoint.secretRef);
  if (pending.length === 0) {
    return 0;
  }

  const assigned = new Map<string, string>();
  for (const endpoint of pending) {
    const shared = await secrets.get(SECRET_BY_KIND[endpoint.kind]);
    const secretRef = randomUUID();
    if (shared) {
      await secrets.setForConnection(secretRef, shared);
    }
    assigned.set(endpoint.name, secretRef);
  }

  await store.update((draft) => {
    for (const [name, secretRef] of assigned) {
      const endpoint = draft.endpoints[name];
      // Another window may have migrated this one between the read and the write.
      if (endpoint && !endpoint.secretRef) {
        endpoint.secretRef = secretRef;
      }
    }
  });

  logger?.info(
    `${assigned.size} connection(s) now carry their own token; the shared keys are kept as a fallback.`,
  );
  return assigned.size;
}
