/**
 * Domain types shared by every layer.
 *
 * Nothing in this file may hold a secret. Tokens live in the editor's secret storage and
 * are looked up by the connector factory when a run needs them; they are never part of an
 * agent, a run record or anything else that gets persisted here.
 */

/** How a run reaches the model. */
export type ExecutionMode = 'api' | 'chat';

/** What happens to a run that came due while no window was open. */
export type MissedRunPolicy = 'skip' | 'runOnce';

/** What an agent does when its prompt file cannot be read at run time. */
export type PromptFileFallback = 'snapshot' | 'blockWhenResolvable' | 'blockAlways';

/**
 * Outcome of a single run.
 *
 * `running` is written when a run starts and replaced when it finishes; a `running` record
 * whose claim is dead means the window disappeared mid-run and becomes `interrupted`.
 */
export type RunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'handedOff'
  | 'interrupted';

/** What caused a run to start. */
export type RunTrigger = 'schedule' | 'manual' | 'startup' | 'missedRun';

/** Where the prompt text comes from. */
export type PromptSourceKind = 'inline' | 'file';

/** Which source an agent visits. */
export type SourceKind = 'jira' | 'git';

/** How a repository host lists pull requests for an agent. */
export type GitSourceMode = 'newPullRequests' | 'updatedPullRequests';

export interface AgentSchedule {
  /** One or more cron expressions; the earliest upcoming occurrence wins. */
  cronExpressions: string[];
  /** IANA time zone name. Falls back to the `rounds.timezone` setting, then the system. */
  timezone?: string;
  /** Run shortly after the leader window starts up. */
  runOnStartup: boolean;
  missedRunPolicy: MissedRunPolicy;
}

export interface JiraSource {
  kind: 'jira';
  /** Name of the configured endpoint that carries the base URL and auth scheme. */
  baseUrlRef: string;
  jql: string;
  maxResults: number;
}

export interface GitSource {
  kind: 'git';
  baseUrlRef: string;
  repo: string;
  mode: GitSourceMode;
  /** ISO timestamp of the newest item already processed. Advances only after success. */
  sinceCursor?: string;
}

export type AgentSource = JiraSource | GitSource;

export interface PromptSnapshot {
  content: string;
  /** sha256 of the content, used to detect changes without storing the file twice. */
  hash: string;
  capturedAt: string;
}

export interface PromptConfig {
  source: PromptSourceKind;
  inlineText?: string;
  filePath?: string;
  snapshot?: PromptSnapshot;
  /** Overrides the `rounds.promptFileFallback` setting for this agent. */
  fallback?: PromptFileFallback;
}

export interface Agent {
  id: string;
  name: string;
  enabled: boolean;
  executionMode: ExecutionMode;
  schedule: AgentSchedule;
  source: AgentSource;
  prompt: PromptConfig;
  /** Exact model identifier. A run fails rather than substituting a different model. */
  modelId: string;
  /** Names of the tools this agent may call. */
  tools: string[];
  outputFolder?: string;
  /** Optional stricter cap than the global `rounds.maxExecutionsPerDay`. */
  maxExecutionsPerDay?: number;
  /** Local time window, `HH:mm`. Both ends must be set for the window to apply. */
  allowedTimeStart?: string;
  allowedTimeEnd?: string;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCallRecord {
  name: string;
  /** Redacted, length-capped rendering of the arguments. */
  inputSummary: string;
  allowed: boolean;
  durationMs: number;
  outputBytes: number;
  truncated: boolean;
  error?: string;
}

export interface PromptResolutionRecord {
  source: PromptSourceKind;
  path?: string;
  usedSnapshot: boolean;
  hash?: string;
}

export interface RunError {
  code: string;
  message: string;
}

export interface RunRecord {
  id: string;
  agentId: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  trigger: RunTrigger;
  /** One line describing the outcome: first line of the output, or the error message. */
  summary: string;
  modelId: string;
  executionMode: ExecutionMode;
  toolCalls: ToolCallRecord[];
  sourceItemCount: number;
  resultFilePath?: string;
  error?: RunError;
  promptResolution: PromptResolutionRecord;
  /** Random delay applied before a scheduled run, in seconds. */
  jitterSeconds?: number;
}

export interface DailyCounters {
  /** Local date in the effective time zone, `YYYY-MM-DD`. */
  localDate: string;
  global: number;
  perAgent: Record<string, number>;
  /** Set when the user has already been told the cap was reached on this date. */
  capNotifiedAt?: string;
}

/**
 * A window's claim on an agent while a run is in flight.
 *
 * Claims live in the shared state rather than in memory because the window that runs an
 * agent manually is not necessarily the window that schedules it.
 */
export interface RunClaim {
  windowId: string;
  runId: string;
  startedAt: string;
  /** Refreshed while the run is in flight; a stale value means the window died. */
  heartbeatAt: string;
}

/** How an endpoint authenticates. Cloud trackers usually want basic, self-hosted bearer. */
export type AuthScheme = 'basic' | 'bearer';

/**
 * Which API a repository host speaks.
 *
 * Not a cosmetic label: these are different APIs with different paths, payloads and pagination, so
 * the connector is chosen by this value. Inferred from the host when it is recognisable, stored so a
 * self-hosted installation can say what it is.
 *
 * `bitbucketCloud` is the hosted service; `bitbucketServer` is the self-hosted product, which shares the
 * name and almost nothing else — a different REST version, different paths, epoch timestamps and a
 * project key where the hosted service has a workspace.
 */
export type GitProvider = 'github' | 'bitbucketCloud' | 'bitbucketServer';

/**
 * A configured base URL an agent can point at.
 *
 * Agents reference an endpoint by name so several agents can share one host without
 * repeating its URL. The token itself never lives here: it stays in secret storage, one per
 * source kind, which is the pair of keys plan.md defines.
 */
export interface EndpointConfig {
  name: string;
  kind: SourceKind;
  baseUrl: string;
  authScheme: AuthScheme;
  /** Needed by basic authentication, where the token is the password. */
  username?: string;
  /** Repository hosts only. Absent means it is inferred from the base URL. */
  provider?: GitProvider;
  /**
   * Which secret this connection authenticates with. The key itself is built in `state/secrets.ts`,
   * which is the only module that knows what storage keys look like.
   *
   * An opaque id generated once, not the name: names are user-facing and change, and a rename
   * that has to move a secret is a rename that can half-fail. Absent means the connection
   * predates per-connection tokens and still reads the shared one for its kind.
   */
  secretRef?: string;
  /** Result of the last reachability check, so a row can say whether the host answered. */
  lastCheck?: { ok: boolean; message: string; at: string };
}

/** A model as the editor reported it. Ids and labels only; no credentials involved. */
export interface CachedModel {
  id: string;
  name: string;
  vendor: string;
  family: string;
}

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckOutcome {
  id: string;
  title: string;
  status: CheckStatus;
  message: string;
}

/**
 * What setup has established so far.
 *
 * Cached here so the tree, the wizard and agent validation can work without triggering a
 * consent prompt: resolving models is only allowed from a user-initiated action.
 */
export interface SetupState {
  /** Set the first time the user granted access to the language model API. */
  consentGrantedAt?: string;
  models?: CachedModel[];
  modelsFetchedAt?: string;
  firstRunNoticeShownAt?: string;
  lastCheckAt?: string;
  lastCheckResults?: CheckOutcome[];
}

/** History is kept per agent, newest first. */
export type RunHistory = Record<string, RunRecord[]>;

/** Everything this extension persists, in one envelope. */
export interface PersistedState {
  schemaVersion: number;
  /** Incremented on every write. A window that lost a race reloads instead of overwriting. */
  revision: number;
  agents: Agent[];
  history: RunHistory;
  counters: DailyCounters;
  /** Keyed by agent id. Absent means no window is running that agent. */
  runClaims: Record<string, RunClaim>;
  setup: SetupState;
  /** Configured base URLs, keyed by the name agents reference. */
  endpoints: Record<string, EndpointConfig>;
}
