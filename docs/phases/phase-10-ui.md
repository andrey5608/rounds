# Phase 10 — User interface

**Goal:** the whole agent lifecycle is usable from the side panel and the palette, with
no JSON editing. Minimal and functional; no custom styling in v1.

**Depends on:** phases 8 and 9.

## Steps

### 10.1 Tree data provider (`src/ui/agentsView.ts`) ✅
- Root level: agents, sorted by name.
  - `label`: agent name.
  - `description`: human-readable schedule + next run (`Every day at 09:00 · next in 3 h`).
  - `iconPath`: `$(play-circle)` enabled, `$(circle-slash)` disabled, `$(warning)`
    needs setup or frequency warning, `$(sync~spin)` running, `$(error)` last run failed.
  - `tooltip`: Markdown with mode, source summary, model, last run, next run, caps.
  - `contextValue`: `rounds.agent.enabled` / `rounds.agent.disabled` /
    `rounds.agent.needsSetup` — used by the `when` clauses from phase 1.
- Child level: the recent runs of that agent (limit ~10) with a status icon and a
  localized-format timestamp; `contextValue` `rounds.run`.
- Chat-mode runs show `$(comment-discussion)` and a tooltip explaining that the output
  was not captured.

### 10.2 Refresh strategy ✅
- Refresh on: `store.onDidChange`, run start/finish events, configuration change,
  leadership change.
- A single 60 s timer updates the relative "next run" text; never a per-second timer, since the
  text changes by the minute and a repaint costs more than it is worth.
- The tree renders from a snapshot built once per refresh (`buildViewData`), so secret lookups and
  readiness evaluation happen once rather than once per row, and the presentation logic is a pure
  function of its input.
- `rounds.refreshView` forces a full refresh and re-evaluates `needsSetup` from cache
  (it does not trigger consent or network pings).

### 10.3 Item activation ✅
- Clicking a run with a result file opens that file in the editor.
- Clicking a `handedOff` or file-less run opens a read-only detail view built as a
  Markdown virtual document (`TextDocumentContentProvider`, scheme `rounds`), showing the
  record fields and the error.
- Both go through the editor's built-in `vscode.open` command with the right URI. Giving the item
  its own `rounds.*` command would have meant inventing an identifier the specification does not
  list, and the v1 command list has none for opening a result.
- Clicking an agent expands it; the wizard is reached through `Edit Agent`.

### 10.4 Welcome view and empty states ✅
- No agents → welcome view from phase 1 (`Create Agent`, `Check Setup`).
- Agents exist but none has runs → a child node `No runs yet` with a `Run Now` hint.

### 10.5 Creation wizard (`src/ui/wizard/`) ✅
Multi-step QuickPick/InputBox flow with working back navigation (`QuickInput` buttons)
and per-step validation:

1. **Name** — non-empty, unique.
2. **Execution mode** — `api` (default, result captured) vs `chat` (handoff, no capture,
   with the limitation spelled out).
3. **Source kind** — Jira or Git.
4. **Source config** — base URL (validated https), then JQL + max results, or repo +
   PR mode.
5. **Credentials** — password InputBox writing into `context.secrets`; offers to reuse an
   already stored token.
6. **Prompt** — inline (multi-line via a scratch editor document) or a file picker;
   placeholder validation runs here (phase 6) and errors block the step.
7. **Model** — QuickPick populated by a live `selectChatModels` call through the consent
   gate at this exact moment (user-initiated, so consent is legitimate here). Never
   hardcode model names. Empty list → explain the model provider requirement.
8. **Tools** — multi-select QuickPick from `registry.list()`; `runScript` shows a warning
   when the whitelist is empty.
9. **Schedule** — cron input with live `describe()` preview and validation; frequency
   warning per step 9.6; `runOnStartup` and `missedRunPolicy` picks; optional allowed
   time window.
10. **Output folder** — default or folder picker; writability probe.
11. **Summary** — read-only confirmation listing everything, then save.

- Creation is linear, editing is a field list: those are different jobs. Setting an agent up means
  answering every question once; changing one means finding that question again.
- All the validation lives in `src/ui/wizard/steps.ts`, apart from the quick picks — that is the
  part worth testing, since driving a quick pick from a test proves little and breaks whenever a
  label changes.
- The schedule step shows the frequency warning as a modal confirmation, so a sub-threshold schedule
  needs a deliberate "use it anyway".
- Changing the prompt file or the repository drops the stored snapshot and cursor of the previous
  one: keeping them would mean falling back to the wrong prompt, or skipping items the new source
  never showed.

### 10.6 Remaining commands ✅
- `rounds.editAgent` — step list of the wizard fields for an existing agent.
- `rounds.duplicateAgent` — deep copy with a new id, name `<name> (copy)`, `enabled:
  false`, cleared `lastRunAt`/`nextRunAt`/cursor.
- `rounds.deleteAgent` — modal confirmation naming the agent, stating that result files
  are kept and history is removed. Tokens are **never** deleted with an agent: they are shared per
  source kind, so removing one agent would take the credentials of the others with it.
- `rounds.toggleAgent` — flips `enabled` and recomputes `nextRunAt`.
- `rounds.openResultFolder` — reveals the resolved output folder in the OS file manager.
- `rounds.showHistory` — QuickPick of the agent's runs (status icon, timestamp, summary);
  selecting one opens the result file or the detail document.
- `rounds.showOutput` — reveals the `Rounds` output channel.
- Every item-scoped command invoked from the palette without an argument first shows a
  QuickPick of agents.

### 10.7 Status bar (finalizing step 2.9)
- States: `Rounds: off` (master switch), `Rounds: setup needed`, `Rounds: next 14:30`,
  `Rounds: running <agent>`, `Rounds: last run failed`.
- Tooltip adds leader/follower information; click opens the output channel.

### 10.8 Notifications policy
- Success: no notification by default (status bar only) — automation must stay quiet.
- Failure: one notification with `Show Output` / `Open History`, deduplicated per agent
  per day.
- Cap reached, consent missing, prompt file unreadable: one actionable notification each,
  deduplicated the same way.

### 10.9 Tests
- Integration: tree structure for agents with and without runs; context values match the
  menu `when` clauses; clicking a run opens the right document.
- Unit: wizard step validation logic (pure functions separated from the QuickPick calls),
  duplicate naming, delete confirmation text, draft round-trip, cursor and snapshot invalidation.
- The tree tests are integration tests because `TreeItem` and `MarkdownString` only exist in the
  host. One of them reads the menu `when` clauses out of the manifest and checks that every one of
  them keys on a context value the tree actually produces — the two halves of that contract are
  otherwise easy to drift apart.

## Exit criteria

- [x] An agent can be created, edited, duplicated, enabled or disabled, run and deleted entirely
      from the UI; every one of the eleven commands has a real implementation.
- [x] The model quick pick is populated by a live resolve through the consent gate and contains no
      hardcoded names.
- [x] The tree shows enabled state, human-readable schedule, next run and recent runs with status
      icons, and its context values are checked against the manifest menus.
- [x] Chat-mode limitations appear in the run tooltip, in the detail document and in the run summary
      stored in the history.
- [x] Scheduled successes are silent; failures notify once per agent per day with an action, and a
      manual run always reports its outcome because the user asked for it.
- [ ] Not done in this phase: the confirmation that lets a manual run exceed the daily limit
      deliberately. It is listed in step 9.4 and tracked in [../leftovers.md](../leftovers.md).
