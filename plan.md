# Rounds - scheduled task agents (VS Code extension)

## Goal
A VS Code extension that lets a user define "agents": recurring tasks that collect
data from Jira and a Git host, run a prompt through an AI model, and store the result.
Results are browsable from a minimal side panel.

Works for any user with VS Code and an active Language Model API provider (e.g. GitHub
Copilot). Installing the extension, granting model consent, and adding credentials
must be the only setup steps.

## Naming and identifiers (use these exactly, do not invent alternatives)

Product name: Rounds
Tagline: scheduled task agents
Marketplace display name: "Rounds — Scheduled Task Agents"
Repository name: rounds

The name refers to making the rounds: agents periodically visit their sources, check
what changed, and report back.

### Manifest
- `name`: "rounds"
- `displayName`: "Rounds — Scheduled Task Agents"
- `publisher`: "rounds" (supplied by the owner on 2026-08-17; until then the manifest carried a
  `TODO-PUBLISHER` placeholder, because guessing a publisher id is not something to do on somebody
  else's behalf)
- Full extension id resolves to `rounds.rounds`

### Trademark rule
Do NOT put "Copilot", "GitHub", "Jira", "Atlassian", "VS Code" or "Visual Studio" in
the extension name, displayName, command titles, view titles, or setting keys. Those
products may only be named in prose (README, descriptions, error messages) and only
descriptively, e.g. "requires a Language Model API provider such as GitHub Copilot".

### Commands
- Command id prefix: `rounds.`
- Command category (shown in the palette): `Rounds`
- Command titles are written WITHOUT the category prefix; VS Code prepends it.
- v1 command ids:
  `rounds.createAgent`, `rounds.editAgent`, `rounds.duplicateAgent`,
  `rounds.deleteAgent`, `rounds.toggleAgent`, `rounds.runNow`,
  `rounds.openResultFolder`, `rounds.showHistory`, `rounds.checkSetup`,
  `rounds.refreshView`, `rounds.showOutput`, `rounds.showAgent`
- `rounds.showAgent` opens one agent on a read-only panel beside the editor. It is an inline
  action on the agent row rather than the row's click, which keeps expanding the runs.

### Settings
- Configuration prefix: `rounds.`
- Keys: `rounds.enabled`, `rounds.timezone`, `rounds.jitterSeconds`,
  `rounds.maxExecutionsPerDay`, `rounds.minimumIntervalWarning`,
  `rounds.manualRunNextRunPolicy`, `rounds.defaultOutputFolder`,
  `rounds.scriptWhitelist`, `rounds.executionHistoryLimit`,
  `rounds.promptFileFallback`, `rounds.logLevel`, `rounds.notifications`
- `rounds.notifications` (`failures` | `all` | `silent`, default `failures`) decides how much
  the extension may interrupt. `silent` stops the toasts only: the log, the status bar and the
  run record are unchanged, and a run the user started by hand always reports its outcome.
- Settings UI title: "Rounds"

### Views
- Activity bar container id: `rounds`, title "Rounds", icon `docs/media/rounds-activitybar.svg`
  (amended 2026-08-17: the owner supplied brand assets; this replaces the original codicon
  `$(history)`)
- TreeView id: `rounds.agentsView`, title "Agents"
- Welcome view (no agents yet) points at `rounds.createAgent` and `rounds.checkSetup`

### Runtime identifiers
- Output channel name: "Rounds"
- Status bar item id: `rounds.status`
- `globalState` keys: `rounds.agents`, `rounds.history`, `rounds.stateRevision`,
  `rounds.dailyCounters`
- `secrets` keys: `rounds.secret.connection.<secretRef>`, one per configured connection.
  `rounds.secret.jiraToken` and `rounds.secret.gitToken` are the pre-phase-18 keys: they are
  migrated from, and stay readable as a fallback, because a token that disappears cannot be
  recovered. One key per source kind stopped being enough once a second repository host API
  was supported — two connections would share one token.
- Leader lock file: `rounds.lock` in the extension's global storage path
- Result files: `<outputFolder>/<agent-name-slug>-<YYYYMMDD-HHmmss>.md`

### Source layout
`src/extension.ts`, `src/scheduler/`, `src/agents/`, `src/connectors/`,
`src/tools/`, `src/model/`, `src/ui/`, `src/state/`, `src/setup/`

### Internal vocabulary (keep consistent in code, UI and docs)
- "agent" — a configured recurring task
- "run" — one execution of an agent
- "source" — Jira or Git connector configuration
- "tool" — a function the model may call
- Avoid "job", "task", "cron job" as user-facing nouns; use "agent" and "run".

## Hard constraints
- TypeScript, standard `yo code` layout, `@types/vscode`, VS Code >= 1.95.
- Model access ONLY through VS Code's own surfaces (`vscode.lm`, or the built-in chat
  commands). No third-party LLM SDK, no direct model HTTP calls, no model API key.
- Network calls limited to the user-configured Jira base URL and Git host base URL.
- ALL user-facing text, command titles, error messages, code comments, README and docs
  MUST be in English. No other language anywhere in the repo.
- Agents run only while VS Code is open. Document this clearly.

## Two execution modes (per agent)
1. `api` — `vscode.lm.selectChatModels` + `sendRequest`, with a full tool-calling loop.
   Result is captured programmatically and written to a file.
2. `chat` — hand off to the built-in chat via
   `vscode.commands.executeCommand('workbench.action.chat.open', { query, mode, isPartialQuery })`.
   Use `isPartialQuery: true` for a review-before-send workflow. In this mode the
   extension cannot capture the model output; it records only that the handoff happened.
Default to `api`. Make the mode a per-agent field.

## Consent handling (important)
`selectChatModels` requires user consent and must be called from a user-initiated
action. Therefore:
- NEVER call it during `activate()` or from a scheduler tick as the first ever call.
- The setup command is what triggers consent. Until consent is confirmed, agents stay
  in a `needsSetup` state and the panel shows a "Grant model access" action.
- Cache the resolved model list; refresh it from user-initiated actions only.

## Abuse / rate-limit safety (non-negotiable, ship in v1)
Automating Copilot can get an account rate-limited or restricted under GitHub's
Acceptable Use Policies. Implement:
- `jitterSeconds` (default 600, range 0–1800): random delay before each run.
- `maxExecutionsPerDay` global cap (default 24) and an optional per-agent cap.
  Count by local date. Notify once per day when the cap is hit.
- Warn when a cron expression fires more often than every 30 minutes.
- Optional per-agent allowed time window (`allowedTimeStart` / `allowedTimeEnd`).
- A prominent disclaimer in the README linking GitHub's AUP and Copilot terms.

## Multi-window safety (important)
Global state means every open VS Code window runs its own scheduler. Prevent duplicate
runs and lost writes:
- Single-leader election via an atomic lock file with heartbeat and stale-lock recovery
  (`proper-lockfile` or equivalent). Only the leader window ticks the scheduler.
- Persist state through same-directory temp files replaced atomically, with a revision
  number. A stale window that loses a write must reload and retry, never overwrite.
- Manual "Run now" works from any window regardless of leadership.

## Agent model
Stored in `ExtensionContext.globalState` (global, not workspace). Fields:
- `id`, `name`, `enabled`, `executionMode` (`api` | `chat`)
- `schedule`: cron expression(s), `timezone`, `runOnStartup`,
  `missedRunPolicy` (`skip` | `runOnce`) for when VS Code was closed at the due time
- `source`: `jira` (base URL ref, JQL, max results) or
  `git` (base URL ref, repo, mode `newPullRequests` | `updatedPullRequests`, since-cursor)
- `promptSource`: `inline` | `file`. For `file`, store the path AND a snapshot of the
  content. Re-sync the snapshot on startup and when the file changes. Add
  `promptFileFallback`: `snapshot` | `blockWhenResolvable` | `blockAlways` for when the
  file is unreadable at run time.
- Placeholders: `{{issueKey}}`, `{{summary}}`, `{{diff}}`, `{{items}}`, `{{date}}`,
  `{{datetime}}`, `{{workspace}}`
- `modelId`, `tools` (enabled tool names), `outputFolder`
Secrets (Jira token, Git token) go in `context.secrets` only — never in globalState,
settings, or the agent config.

## Scheduler
- Interval tick (~30s) in the leader window; cron evaluation with timezone support.
- Track `lastRunAt` / `nextRunAt`; never overlap runs of the same agent.
- Each agent validates its own dependencies (consent, model available, secret present,
  source reachable) before running; on failure record a failed run with a clear reason
  instead of throwing.
- Per-agent "Run now", with a configurable next-run policy afterwards
  (`advance` from the existing next run, or `fromNow`).

## Connectors
- `JiraConnector`: REST search by JQL → normalized issues (key, summary, status,
  description, comments, links). Base URL configurable (cloud and self-hosted).
- `GitConnector`: list pull requests, fetch diffs. Base URL configurable for
  self-hosted. Keep the interface provider-agnostic.
- Both behind interfaces, with distinct error types for auth, network, and bad config.

## Model invocation and tools (`api` mode)
- Resolve the model by stored `modelId`. If that exact model is gone, FAIL the run with
  an explicit error telling the user to re-select. NEVER silently substitute.
- When a model id is invalid, reject with the list of valid ids rather than falling back.
- Proper agentic loop: declare tools via `LanguageModelChatTool`, handle
  `LanguageModelToolCallPart`, execute, feed back a `LanguageModelToolResultPart`,
  repeat until a final text answer. Cap iterations (10) and surface the cap as a
  failure reason.
- v1 tools, each with a JSON schema and a permission check:
  - `readFile(path)` — inside the workspace only
  - `runScript(command, args, cwd)` — user-configured whitelist; nothing unlisted runs
  - `listFiles(globPattern)`
  Adding a tool must mean registering one object in a tool registry.
- Handle `LanguageModelError` cases (no consent, quota, model unavailable) distinctly
  and actionably.

## Result handling
- Each run writes `<agentName>-<timestamp>.md` into the agent's output folder, with
  front matter (agent, model, mode, started/finished, status, source items, tool calls)
  followed by the model output.
- Run history per agent, newest first, capped at a configurable limit (default 50):
  timestamp, status, one-line summary, tool calls, result file path, error message,
  prompt source and resolution info.
- A dedicated Output Channel with a `logLevel` setting (none/error/info/debug).

## UI
Minimal and functional; no custom styling work in v1.
- TreeView in the activity bar: agents (enabled state, human-readable schedule, next
  run time) → recent runs (status icon, timestamp).
- Clicking a run opens its result file.
- Commands: create / edit / duplicate / delete agent, enable / disable, run now,
  open result folder, show execution history, check setup.
- Creation via QuickPick / InputBox steps, including a QuickPick of models fetched
  live at that moment. Never hardcode model names.

## Setup check
`Check setup` command, also offered on first activation. Verifies:
1. Language Model API consent granted and model list non-empty
2. Jira base URL set, token in secret storage, live ping
3. Git base URL set, token in secret storage, live ping
4. Output folder exists and is writable
5. Script whitelist configured (warning only)
6. Rate-limit settings sane (warn on sub-30-minute crons)
Each item shows pass/fail with a Fix action opening the relevant input.

## Out of scope for v1
- Chat participant integration, and Language Model Tools that **manage** agents from chat:
  creating, editing, deleting or enabling an agent from a conversation stays out of scope. A
  write tool would have to reimplement every guard the wizard applies — the frequency warning,
  the daily cap, the allowed window, model validity — or become the way around them.
- In scope since phase 17: one **read-only** tool, `rounds_query`, which answers questions about
  agents, runs and schedules. It takes no store and therefore cannot write.
- Running when VS Code is closed
- Team sync of agent configs
- Model parameters beyond what `vscode.lm` accepts

## Deliverables
Extension source, `package.json` contribution points, README in English covering setup,
the "runs only while VS Code is open" caveat and the GitHub AUP disclaimer, plus a
CONTRIBUTING note on registering a new tool or connector.

