# Rounds — implementation plan

Step-by-step plan for building the extension described in [`../plan.md`](../plan.md).
The work is split into 13 phases (0–12). Every phase has its own file under
[`phases/`](./phases/) with numbered steps, concrete file paths and exit criteria.

## How to use this plan

- Phases are ordered by dependency. Do not start a phase before its listed
  prerequisites are done, unless the phase file marks a step as parallelizable.
- A phase is finished only when **all** of its exit criteria are checked. Exit criteria
  are written so they can be verified by a test, a command, or a short manual check.
- Steps inside a phase are meant to be one commit each (or one small PR). Keep the
  build green after every step.
- If reality contradicts a step, fix the step in this document in the same commit.

## Ground rules (repeated from `plan.md`, non-negotiable)

1. TypeScript, standard `yo code` layout, `@types/vscode`, VS Code >= 1.95.
2. Model access only through `vscode.lm` or built-in chat commands. No third-party LLM
   SDK, no direct model HTTP calls, no model API key.
3. Network access only to the user-configured Jira base URL and Git host base URL.
4. Everything in the repository is written in English — UI strings, errors, comments,
   commits, docs.
5. Trademarks (`Copilot`, `GitHub`, `Jira`, `Atlassian`, `VS Code`, `Visual Studio`)
   never appear in the extension name, `displayName`, command titles, view titles or
   setting keys. Prose only, descriptive only.
6. Identifiers from `plan.md` are used verbatim: `rounds.` prefixes, the 11 command ids,
   the 11 setting keys, view ids, state keys, secret keys.
7. `selectChatModels` is never called from `activate()` or from a scheduler tick as the
   first call. Consent is triggered by user-initiated actions only.
8. Vocabulary: "agent", "run", "source", "tool". Never "job", "task", "cron job" in
   user-facing text.

## Architecture map

Source layout from `plan.md`, mapped to the phase that creates it:

| Path | Contents | Phase |
| --- | --- | --- |
| `src/extension.ts` | Activation, service container, command registration | 1 |
| `src/state/` | Agent model, persistence, revisions, secrets, history, counters, logger | 2, 3 |
| `src/setup/` | Setup checks, consent gate, model catalog | 4 |
| `src/connectors/` | `JiraConnector`, `GitConnector`, HTTP client, error types | 5 |
| `src/agents/` | Agent CRUD services, prompt resolution, placeholders, run pipeline | 6, 8 |
| `src/tools/` | Tool registry and the v1 tools | 7 |
| `src/model/` | Language model access, agentic loop, chat handoff | 8 |
| `src/scheduler/` | Cron evaluation, ticker, jitter, caps, time windows | 9 |
| `src/ui/` | TreeView, wizard, quick picks, status bar | 10 |

Dependency direction: `ui` → `agents`/`scheduler` → `model`/`connectors`/`tools` →
`state`. Nothing below `ui` imports from `ui`. `state` imports nothing from the layers
above it. Keep `vscode` API usage behind thin wrappers in `model/` and `state/` so the
pure logic stays unit-testable outside the extension host.

## Phase overview

| # | Phase | Goal | Depends on |
| --- | --- | --- | --- |
| 0 | [Bootstrap](./phases/phase-00-bootstrap.md) | Compiling, lintable, testable, CI-checked empty extension | — |
| 1 | [Manifest](./phases/phase-01-manifest.md) | All contribution points declared, commands stubbed | 0 |
| 2 | [State](./phases/phase-02-state.md) | Agent model, atomic persistence with revisions, secrets, history, logging | 1 |
| 3 | [Multi-window](./phases/phase-03-multi-window.md) | Single-leader election, heartbeat, stale-lock recovery | 2 |
| 4 | [Setup & consent](./phases/phase-04-setup-consent.md) | `rounds.checkSetup`, consent gate, cached model catalog | 2 |
| 5 | [Connectors](./phases/phase-05-connectors.md) | Jira and Git connectors with normalized items and typed errors | 2 |
| 6 | [Prompts](./phases/phase-06-prompts.md) | Inline/file prompts, snapshots, fallback policy, placeholders | 2, 5 |
| 7 | [Tools](./phases/phase-07-tools.md) | Tool registry plus `readFile`, `runScript`, `listFiles` | 2 |
| 8 | [Execution](./phases/phase-08-execution.md) | Run pipeline, agentic loop, chat handoff, result files, history | 4, 5, 6, 7 |
| 9 | [Scheduler](./phases/phase-09-scheduler.md) | Cron ticking, jitter, daily caps, time windows, missed runs | 3, 8 |
| 10 | [UI](./phases/phase-10-ui.md) | TreeView, welcome view, all commands, creation wizard | 8, 9 |
| 11 | [Docs](./phases/phase-11-docs.md) | README, disclaimer, CONTRIBUTING, marketplace metadata | 10 |
| 12 | [Release](./phases/phase-12-release.md) | Test matrix, audits, packaging, release checklist | 11 |

## Milestones

| Milestone | Reached after | Demonstrable result |
| --- | --- | --- |
| **M1 — Skeleton** | Phase 1 | Extension activates, activity bar container and welcome view visible, every command in the palette under `Rounds`, no consent prompt at startup. |
| **M2 — First run** | Phase 8 | An agent defined in state runs on demand end-to-end: source fetched, prompt resolved, model called with tools, result file written, history record stored. |
| **M3 — Unattended** | Phase 9 | The leader window fires a cron-scheduled run with jitter, respects the daily cap and the allowed time window, and recovers a missed run per policy. |
| **M4 — Shippable** | Phase 12 | Full lifecycle from the UI only, docs complete, `vsce package` produces a VSIX that installs cleanly with the publisher placeholder still explicit. |

Phases 4, 5 and 7 have no dependency on each other and can run in parallel once phase 2
lands. Phase 3 can also run in parallel with 4/5/7.

## Cross-cutting conventions

- **Errors:** every failure path produces a typed error with a stable `code`, a
  user-facing English message, and an optional `fix` action id. Runs never throw out of
  the pipeline; they record a failed run with a reason.
- **Time:** all stored timestamps are ISO-8601 UTC. Local dates (daily counters, result
  file names, allowed time windows) are computed in the agent's effective timezone
  (`agent.schedule.timezone` falling back to `rounds.timezone` falling back to system).
- **Clock:** all scheduling logic takes a `Clock` interface so tests can inject time.
- **State writes:** always read-modify-write through the store with a revision check.
  On conflict, reload and retry (bounded), never overwrite.
- **Logging:** one output channel named `Rounds`; every log line goes through the logger
  so redaction of tokens and credentials is centralized.
- **Testing:** pure logic in unit tests (no extension host); anything touching `vscode`
  in integration tests under `@vscode/test-electron`. Each phase adds its own tests; a
  phase is not done without them.
- **Strings:** all user-facing text lives next to the code that uses it, in English, and
  is reviewed against the trademark rule before a phase closes.

## Traceability to `plan.md`

| `plan.md` section | Covered by |
| --- | --- |
| Naming and identifiers, Manifest, Commands, Settings, Views | Phase 1 |
| Runtime identifiers (`globalState`, `secrets`, output channel, status bar) | Phase 2 |
| Leader lock file, Multi-window safety | Phase 3 |
| Consent handling, Setup check | Phase 4 |
| Connectors | Phase 5 |
| Agent model → `promptSource`, placeholders, `promptFileFallback` | Phase 6 |
| Model invocation and tools → v1 tools | Phase 7 |
| Two execution modes, Model invocation loop, Result handling | Phase 8 |
| Scheduler, Abuse / rate-limit safety | Phase 9 |
| UI | Phase 10 |
| Deliverables → README, CONTRIBUTING | Phase 11 |
| Hard constraints, Out of scope for v1 | Phase 12 audits |

## Risk register

| Risk | Impact | Mitigation | Phase |
| --- | --- | --- | --- |
| Automated model calls trigger provider rate limiting or account restrictions | Users get blocked; extension gets a bad reputation | Jitter, daily caps, sub-30-minute cron warnings, time windows, prominent AUP disclaimer | 9, 11 |
| Two windows run the same agent twice, or overwrite each other's state | Duplicate model calls, lost history | Leader lock with heartbeat, per-agent run claim, revision-checked atomic writes | 3 |
| Consent prompt fired from a background tick | `selectChatModels` fails or annoys the user | Consent gate: model catalog resolved only from user-initiated actions, cached afterwards | 4 |
| Stored `modelId` disappears after a provider update | Silent behaviour change | Fail the run explicitly with the list of valid ids; never substitute | 8 |
| `runScript` used to execute arbitrary commands | Local code execution from model output | Strict whitelist, no shell, cwd confined to the workspace, timeouts, audit log | 7 |
| Prompt file deleted or unreadable at run time | Ambiguous behaviour | Explicit `promptFileFallback` policy with snapshot and hash recorded per run | 6 |
| Self-hosted Jira/Git deployments differ from cloud | Connector breakage | Connectors behind interfaces, base URL configurable, typed config errors, fixture tests for both shapes | 5 |
| Large diffs blow up the prompt | Failed or expensive runs | Size caps with explicit truncation markers | 6 |
