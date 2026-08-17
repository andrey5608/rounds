# Phase 2 — State, secrets and logging

**Goal:** the persistence layer every other phase builds on: agent model, revisioned
atomic writes, secret storage, run history, daily counters, output channel, status bar.

**Depends on:** phase 1.

## Steps

### 2.1 Domain types (`src/state/types.ts`) ✅
```ts
type ExecutionMode = 'api' | 'chat';
type MissedRunPolicy = 'skip' | 'runOnce';
type PromptFileFallback = 'snapshot' | 'blockWhenResolvable' | 'blockAlways';
type RunStatus = 'succeeded' | 'failed' | 'skipped' | 'handedOff';
type RunTrigger = 'schedule' | 'manual' | 'startup' | 'missedRun';

interface Agent {
  id: string;                 // uuid
  name: string;
  enabled: boolean;
  executionMode: ExecutionMode;
  schedule: AgentSchedule;
  source: AgentSource;        // JiraSource | GitSource
  prompt: PromptConfig;
  modelId: string;
  tools: string[];
  outputFolder?: string;
  maxExecutionsPerDay?: number;
  allowedTimeStart?: string;  // 'HH:mm'
  allowedTimeEnd?: string;    // 'HH:mm'
  lastRunAt?: string;         // ISO UTC
  nextRunAt?: string;         // ISO UTC
  createdAt: string;
  updatedAt: string;
}
```
- `AgentSchedule`: `cronExpressions: string[]`, `timezone?`, `runOnStartup: boolean`,
  `missedRunPolicy`.
- `AgentSource`: discriminated union on `kind: 'jira' | 'git'`.
  - Jira: `baseUrlRef`, `jql`, `maxResults`.
  - Git: `baseUrlRef`, `repo`, `mode: 'newPullRequests' | 'updatedPullRequests'`,
    `sinceCursor?`.
- `PromptConfig`: `source: 'inline' | 'file'`, `inlineText?`, `filePath?`,
  `snapshot?: { content: string; hash: string; capturedAt: string }`, `fallback?`.
- `RunRecord`: `id`, `agentId`, `startedAt`, `finishedAt`, `status`, `trigger`,
  `summary`, `modelId`, `executionMode`, `toolCalls: ToolCallRecord[]`,
  `sourceItemCount`, `resultFilePath?`, `error?: { code: string; message: string }`,
  `promptResolution: { source; path?; usedSnapshot: boolean; hash?: string }`.
- Secrets never appear in any of these types. Add a comment saying so.

### 2.2 Schema versioning and validation ✅
- Persisted envelope: `{ schemaVersion: number; revision: number; agents: Agent[] }`.
- Hand-written type guards in `src/state/validate.ts` (no new dependency). Unknown or
  malformed entries are dropped into a `quarantine` array and logged, never thrown away
  silently and never crashing activation.
- `migrate(envelope)` chain keyed by `schemaVersion`; v1 starts at `1` with an identity
  migration so the mechanism exists from day one.

### 2.3 Store with revision checks (`src/state/store.ts`) ✅
- Keys exactly as specified: `rounds.agents`, `rounds.history`, `rounds.stateRevision`,
  `rounds.dailyCounters` in `context.globalState`.
- API: `read()`, `update(mutator, { expectedRevision })`, `onDidChange` event.
- `update` reloads, applies the mutator, bumps `revision`, writes. If the observed
  revision changed since the read, it reloads and re-applies the mutator (max 5
  attempts, then a typed `StateConflictError`). Mutators must be pure and idempotent.

### 2.4 Atomic file mirror (`src/state/fileStore.ts`) ✅
- `globalState` alone gives no cross-window write ordering, so mirror the envelope to
  `<globalStorageUri>/state.json`.
- Write path: serialize → write `state.json.tmp-<pid>-<n>` in the **same directory** →
  `fs.rename` over `state.json` (atomic on the same filesystem) → update `globalState`.
- Read path: prefer the file; fall back to `globalState` when the file is missing or
  corrupt (and log a warning). Corrupt file is renamed to `state.json.bad-<timestamp>`.
- Non-leader windows detect external changes by polling the file `mtime` + `revision`
  every ~5 s (cheap) and firing `onDidChange`.

### 2.5 Secret storage (`src/state/secrets.ts`) ✅
- Thin wrapper over `context.secrets` with only two keys: `rounds.secret.jiraToken`,
  `rounds.secret.gitToken`.
- `get`, `set`, `delete`, `has`, and `onDidChange` re-exposed.
- Guard test: no secret key string appears anywhere in `store.ts`/`fileStore.ts`.

### 2.6 Run history (`src/state/history.ts`) ✅
- Stored under `rounds.history` as `Record<agentId, RunRecord[]>`, newest first.
- `append(record)` trims to `rounds.executionHistoryLimit`; deleting an agent deletes
  its history; result files are **not** deleted (say so in the delete confirmation).
- Query helpers: `recent(agentId, n)`, `lastRun(agentId)`, `lastSuccess(agentId)`.

### 2.7 Daily counters (`src/state/counters.ts`) ✅
- Shape: `{ localDate: 'YYYY-MM-DD', global: number, perAgent: Record<string, number>,
  capNotifiedAt?: string }`.
- `localDate` computed in the effective timezone. On a date change the counters reset.
- API: `canRun(agent, settings)` → `{ allowed: boolean; reason?: 'globalCap' |
  'agentCap' }`, `increment(agentId)`, `markCapNotified()`.

### 2.8 Logger and output channel (`src/state/logger.ts`)
- One channel named `Rounds` (created with `createOutputChannel('Rounds', { log: true })`
  if the log-output API is used, otherwise plain).
- Levels `none | error | info | debug` from `rounds.logLevel`, re-read on config change.
- Central redaction: token values from the secret store, `Authorization` headers, and
  `user:pass@` in URLs are replaced with `***` before writing.
- Scoped child loggers: `logger.scope('run:<runId>')`.

### 2.9 Status bar (`src/ui/statusBar.ts`, wired now, refined in phase 10)
- Item with id `rounds.status`, alignment right, command `rounds.showOutput`.
- Text reflects: disabled / needs setup / next run time / running / last run failed.

### 2.10 Tests
- Unit: revision conflict retry, mutator re-application, envelope migration, malformed
  entry quarantine, history cap, counter rollover across midnight in a non-UTC timezone,
  redaction of tokens in log lines.
- Integration: write from one store instance, read from a second one pointed at the same
  storage path; simulate a stale writer and assert it reloads instead of overwriting.

## Exit criteria

- [ ] Agents, history, counters and revision survive a window reload.
- [ ] A simulated concurrent write is detected and retried, with no lost update.
- [ ] A corrupt `state.json` is quarantined and the extension still activates.
- [ ] Tokens never appear in the output channel or in `globalState` dumps.
- [ ] All phase-2 unit and integration tests pass.
