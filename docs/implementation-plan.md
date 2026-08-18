# Rounds — implementation plan

Step-by-step plan for building the extension described in [`../plan.md`](../plan.md).
Phases 0–12 built the extension and are complete. Phases 13–20 are planned work on top of
it: the first group came out of real installations and a comparison against a published
scheduling extension, the last three out of what configuring the extension actually feels
like — connections that can only be added, and a source that is one string. Every phase has its own file under [`phases/`](./phases/) with
numbered steps, concrete file paths and exit criteria.

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
| `src/ui/` | TreeViews, the agent panel and its form, quick picks, status bar | 10, 14, 18, 20 |

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
| 13 | [Interface & notifications](./phases/phase-13-interface-notifications.md) | One notification policy, live schedule preview, runs that state their cost | 10 |
| 14 | [Agent panel](./phases/phase-14-agent-panel.md) | One read-only panel beside the editor showing a whole agent | 13 |
| 15 | [Workspace trust](./phases/phase-15-workspace-trust.md) | `runScript` and readiness respect untrusted workspaces | 7 |
| 16 | [Prompts & chat mode](./phases/phase-16-prompts-chat-mode.md) | Prompt discovery, a real editor for inline prompts, chat opened with the agent's model | 13 |
| 17 | [Chat tools](./phases/phase-17-chat-tools.md) | Read-only `rounds_query`; writing from chat stays out of scope | 13, 15 |
| 18 | [Connections](./phases/phase-18-connections.md) | Connections listed, edited and deleted from a view, each with its own token | 13 |
| 19 | [Structured sources](./phases/phase-19-structured-sources.md) | Project and repository stored and picked separately, schema version 2 | 5, 18 |
| 20 | [Agent editor](./phases/phase-20-agent-editor.md) | The panel becomes the one place an agent is created and changed | 14, 18, 19 |
| 21 | [Workspace tools](./phases/phase-21-workspace-tools.md) | Tools other extensions registered, usable by an agent; prompt-file front matter | 7, 15, 20 |
| 22 | [Sourceless agents](./phases/phase-22-sourceless-agents.md) | A source becomes optional: a prompt on a schedule is an agent too | 19, 20 |

## Milestones

| Milestone | Reached after | Demonstrable result |
| --- | --- | --- |
| **M1 — Skeleton** | Phase 1 | Extension activates, activity bar container and welcome view visible, every command in the palette under `Rounds`, no consent prompt at startup. |
| **M2 — First run** | Phase 8 | An agent defined in state runs on demand end-to-end: source fetched, prompt resolved, model called with tools, result file written, history record stored. |
| **M3 — Unattended** | Phase 9 | The leader window fires a cron-scheduled run with jitter, respects the daily cap and the allowed time window, and recovers a missed run per policy. |
| **M4 — Shippable** | Phase 12 | Full lifecycle from the UI only, docs complete, `vsce package` produces a VSIX that installs cleanly with the publisher placeholder still explicit. |
| **M5 — Everyday** | Phase 16 | A person configures and reviews agents without leaving the view: notifications say something once, a schedule is readable before it fires, an agent fits on one panel, and an untrusted workspace cannot run a command. |
| **M6 — Configurable** | Phase 20 | Connections and agents are both managed from the view: a connection can be corrected without deleting what uses it, each one carries its own token, and an agent points at a project and a repository chosen from the host. |

Phases 4, 5 and 7 have no dependency on each other and can run in parallel once phase 2
lands. Phase 3 can also run in parallel with 4/5/7.

Phases 0–12 are complete. What they did not close is collected in
[leftovers.md](./leftovers.md): three items that need a marketplace identity or a design decision,
the checks that need a real installation, and one feature from the specification that is genuinely
missing — a manual run cannot yet exceed the daily limit on purpose.

Phases 13–17 are ordered by what a person meets first, not by what is cheapest. Phase 15 is
independent of the interface work and can be taken at any point; it is the only one of the five
that closes a risk rather than adding comfort, so it should not drift to the end.

Several of these phases add something `plan.md` does not currently list, and each one starts by
editing it: the setting `rounds.notifications` in phase 13, the command `rounds.showAgent` in
phase 14, a read-only Language Model Tool in phase 17, and in phase 18 a second view, three
connection commands and a per-connection secret key. Phase 19 is the only one that changes stored
data — schema version 2, with a migration. Every one of these was decided deliberately; the phase
files record what was chosen and what was turned down.

Phases 18–20 belong together: connections become editable, a source stops being one string, and
the panel from phase 14 becomes the editor. Taken in that order each one is usable on its own;
taken out of order, phase 20 would build a form for fields phase 19 has not defined yet.

All of phases 13–20 are complete. Phase 20 removed the quick-pick wizard rather than leaving it
beside the form, so `src/ui/wizard/` now holds the rules (`steps.ts`) and the prompt-file discovery
(`promptFiles.ts`) and no flow of its own.

Phase 21 stands on its own and needs none of the interface work: it opens the agentic loop to the
tools other extensions register, which is what makes "research the issue, then write about it"
something an agent can do rather than something the chat can do. Like the others it starts by
editing `plan.md`, which fixes the tool list at three.

Phase 22 removes the assumption underneath all of them: that an agent visits something. A prompt
on a schedule is an agent too, and the two phases meet — an agent with no source has the tools and
nothing else, so phase 21 is what makes phase 22 worth having.

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
| A repository that is merely opened reaches a shell through `runScript` | Local code execution from cloned content | Limited untrusted-workspace support, `rounds.scriptWhitelist` restricted, the tool denies rather than fails | 15 |
| Notifications turn into a stream nobody reads, so the one that matters is missed | Failures go unnoticed | One notifier with dedup keys, coalesced warnings, a setting that silences toasts without silencing the record | 13 |
| The panel becomes a second place where agents are edited | Two validations, two sets of tests, two behaviours | The panel is read-only; every mutation goes through an existing command | 14 |
| Chat-side tools become the way around jitter, caps and windows | The safety features stop being safety features | Read-only first; any write shares the form's validation and the trust gate | 17 |
