import type { RoundsStore } from './store.js';
import type { PersistedState, RunRecord } from './types.js';

/** Newest first, which is the order the tree view and the history picker show. */
function byStartedAtDescending(left: RunRecord, right: RunRecord): number {
  return right.startedAt.localeCompare(left.startedAt);
}

/**
 * Inserts a run, or replaces the one with the same id.
 *
 * Replacing matters because a run is recorded when it starts and updated when it
 * finishes; the record must not appear twice.
 */
export function upsertRun(state: PersistedState, record: RunRecord, limit: number): void {
  const existing = state.history[record.agentId] ?? [];
  const withoutRecord = existing.filter((candidate) => candidate.id !== record.id);
  withoutRecord.push(record);
  withoutRecord.sort(byStartedAtDescending);
  state.history[record.agentId] = withoutRecord.slice(0, Math.max(1, limit));
}

/** Drops the history of an agent. Result files on disk are deliberately left alone. */
export function removeAgentHistory(state: PersistedState, agentId: string): void {
  delete state.history[agentId];
}

export function recentRuns(state: PersistedState, agentId: string, count: number): RunRecord[] {
  return (state.history[agentId] ?? []).slice(0, count);
}

export function lastRun(state: PersistedState, agentId: string): RunRecord | undefined {
  return state.history[agentId]?.[0];
}

export function lastSuccessfulRun(
  state: PersistedState,
  agentId: string,
): RunRecord | undefined {
  return state.history[agentId]?.find((run) => run.status === 'succeeded');
}

/** Every run of every agent, newest first. Used by the status bar and diagnostics. */
export function allRuns(state: PersistedState): RunRecord[] {
  return Object.values(state.history).flat().sort(byStartedAtDescending);
}

/** Store-backed history operations. The limit is read fresh so a settings change applies. */
export class HistoryService {
  constructor(
    private readonly store: RoundsStore,
    private readonly getLimit: () => number,
  ) {}

  async record(run: RunRecord): Promise<void> {
    const limit = this.getLimit();
    await this.store.update((draft) => {
      upsertRun(draft, run, limit);
    });
  }

  async forgetAgent(agentId: string): Promise<void> {
    await this.store.update((draft) => {
      removeAgentHistory(draft, agentId);
    });
  }

  async recent(agentId: string, count = 10): Promise<RunRecord[]> {
    return recentRuns(await this.store.read(), agentId, count);
  }

  async last(agentId: string): Promise<RunRecord | undefined> {
    return lastRun(await this.store.read(), agentId);
  }

  async lastSuccess(agentId: string): Promise<RunRecord | undefined> {
    return lastSuccessfulRun(await this.store.read(), agentId);
  }
}
