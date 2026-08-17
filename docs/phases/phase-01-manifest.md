# Phase 1 — Manifest and contribution skeleton

**Goal:** every contribution point from `plan.md` declared with the exact identifiers,
all commands registered as stubs, activation free of any model call. Milestone **M1**.

**Depends on:** phase 0.

## Steps

### 1.1 Extension identity ✅
- `icon`: `media/rounds-icon-128.png`. Added later, when the owner supplied brand assets; the activity
  bar glyph replaced the `$(history)` codicon at the same time and `plan.md` was amended to match,
  because a specification that contradicts the shipped manifest gets "corrected" back by the next
  reader.
- `name`: `rounds`
- `displayName`: `Rounds — Scheduled Task Agents`
- `publisher`: `rounds`, supplied by the owner. Until then the manifest carried a `TODO-PUBLISHER`
  placeholder rather than a guess, and the full extension id is now `rounds.rounds`.
- `description`: one English sentence, descriptive, no trademarks in a naming position.
- `categories`: `["Other"]`; `keywords`: `["agents", "schedule", "automation", "cron"]`.
- `galleryBanner` is added in phase 11.

### 1.2 Activation ✅
- `activationEvents`: `onStartupFinished` plus the view activation is implicit from the
  contributed view.
- `activate()` may read state, create the output channel, register commands, create the
  tree provider and try to acquire leadership. It must **not** call
  `vscode.lm.selectChatModels`, must not perform network calls, and must not show modal
  dialogs.
- Keep activation under ~50 ms of synchronous work; defer everything else.

### 1.3 Views ✅
```jsonc
"viewsContainers": {
  "activitybar": [{ "id": "rounds", "title": "Rounds", "icon": "media/rounds-activitybar.svg" }]
},
"views": {
  "rounds": [{ "id": "rounds.agentsView", "name": "Agents" }]
}
```
- `viewsWelcome` for `rounds.agentsView` when there are no agents: two buttons wired to
  `rounds.createAgent` and `rounds.checkSetup`, plus one line of English prose.
- Add a `when` context key `rounds.hasAgents` set from the state store so the welcome
  view disappears once an agent exists.

### 1.4 Commands ✅
Declare all v1 ids with category `Rounds` and titles written **without** the category:

| Command id | Title |
| --- | --- |
| `rounds.createAgent` | Create Agent |
| `rounds.editAgent` | Edit Agent |
| `rounds.duplicateAgent` | Duplicate Agent |
| `rounds.deleteAgent` | Delete Agent |
| `rounds.toggleAgent` | Enable or Disable Agent |
| `rounds.runNow` | Run Now |
| `rounds.openResultFolder` | Open Result Folder |
| `rounds.showHistory` | Show Run History |
| `rounds.checkSetup` | Check Setup |
| `rounds.refreshView` | Refresh |
| `rounds.showOutput` | Show Output |

### 1.5 Menus ✅
- `view/title` for `rounds.agentsView`: `rounds.createAgent` (group `navigation`),
  `rounds.refreshView` (`navigation`), `rounds.checkSetup`, `rounds.showOutput`.
- `view/item/context`: agent items (`contextValue` starting with `rounds.agent`) get
  run now / edit / duplicate / toggle / open result folder / show history / delete.
- Run items get **no** context menu entry. Opening a result file is the item's default
  click command (step 10.3), and the v1 command list has no id for it — inventing one
  would break the "identifiers come from `plan.md`" rule.
- `commandPalette` entries: hide the item-scoped commands that make no sense without a
  selection? No — keep them visible and let them prompt with a QuickPick of agents when
  invoked without an argument (decided in phase 10).

### 1.6 Configuration ✅
Title `Rounds`, all keys under the `rounds.` prefix:

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `rounds.enabled` | boolean | `true` | Master switch for scheduled runs. |
| `rounds.timezone` | string | `""` | IANA name; empty means system timezone. |
| `rounds.jitterSeconds` | number | `600` | Range 0–1800, validated. |
| `rounds.maxExecutionsPerDay` | number | `24` | Global cap across all agents. |
| `rounds.minimumIntervalWarning` | number | `30` | Minutes; warn on more frequent crons. |
| `rounds.manualRunNextRunPolicy` | enum | `advance` | `advance` \| `fromNow`. |
| `rounds.defaultOutputFolder` | string | `""` | Absolute path; empty falls back to global storage. |
| `rounds.scriptWhitelist` | array | `[]` | Entries allowed for the `runScript` tool. |
| `rounds.executionHistoryLimit` | number | `50` | Per-agent history cap. |
| `rounds.promptFileFallback` | enum | `snapshot` | `snapshot` \| `blockWhenResolvable` \| `blockAlways`. |
| `rounds.logLevel` | enum | `info` | `none` \| `error` \| `info` \| `debug`. |

- Every key gets a `markdownDescription` in English; enums get `enumDescriptions`.
- Numeric keys get `minimum`/`maximum` so the settings UI validates them.

### 1.7 Service container and command stubs ✅
- `src/extension.ts` builds a small container object (logger, state store, secrets,
  later: catalog, scheduler, runner, tree provider) and passes it explicitly. No global
  singletons, no service locator.
- The `ServiceContainer` type lives in `src/container.ts` rather than in `extension.ts`,
  so the layers below can import it without importing the entry point back.
- Register all 11 commands as stubs that log and show
  `Not implemented yet` — replaced phase by phase.
- `deactivate()` disposes everything: subscriptions, timers, lock, output channel.

### 1.8 Contribution guard test ✅
- Integration test asserting: every command id in `package.json` is registered at
  runtime, every registered `rounds.*` command is declared in `package.json`, and the
  declared setting keys match the constant list in `src/state/settings.ts`.
- Unit test asserting no forbidden trademark string appears in `displayName`, command
  titles, view titles or setting keys.
- The editor generates its own commands for a contributed view (`rounds.agentsView.open`
  and friends). They live in our namespace but are not ours to declare, so the guard
  filters commands prefixed with a contributed **view id** — not with the view container
  id, which is plain `rounds` and would swallow everything.
- `compile:tests` now wipes `out/` first. Compiling on top of stale output kept running
  tests whose sources had been deleted, which made a green run meaningless.
- `test:integration` now builds the bundle before launching the host. It previously only
  compiled the tests, so the host loaded a stale `dist/extension.js`. Note that
  `getCommands(true)` also returns commands that are merely *declared* in the manifest,
  so that check alone cannot detect a missing registration — the test that executes every
  command is the one that proves it.

## Exit criteria

- [x] Activity bar shows the `Rounds` container with the `Agents` view and its welcome
      content. Verified structurally: the container, the view and the welcome block are
      contributed, a data provider is registered, and the extension activates without
      errors. The pixels themselves still deserve one look with F5.
- [x] All 11 commands appear in the palette as `Rounds: <title>` and run their stub.
      An integration test executes each of them; the palette entry follows from the
      declared category and title, which the unit test checks.
- [x] All 11 settings appear in the settings UI under `Rounds` with English descriptions.
      The unit test compares the declared keys with the code base list and the integration
      test reads their defaults from a live editor.
- [x] Startup produces no consent prompt, no network request, no error notification.
      No source file references `vscode.lm`, `selectChatModels` or `fetch`, and activation
      is asserted to succeed.
- [x] Contribution guard test and trademark test pass.
