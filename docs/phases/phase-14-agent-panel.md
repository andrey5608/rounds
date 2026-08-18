# Phase 14 — Agent panel

**Goal:** one agent, all of it, on screen next to the editor — schedule, source, prompt,
recent runs — without a modal and without a round trip through the wizard.

**Depends on:** phase 13.

A tree row has one line of description and a tooltip that disappears when the pointer
moves. Everything an agent is worth reviewing before a run — the resolved prompt, what it
fetched last time, where the results went — currently needs three commands and two
documents. This phase adds the one surface that shows it, and stops there.

## Steps

### 14.1 Decide what the panel is not ✅
- It is **read-only in this phase**. A webview form would be a second implementation of
  every validation rule in `src/ui/wizard/steps.ts`, and two implementations of a rule
  means one of them is wrong. [Phase 20](./phase-20-agent-editor.md) makes the panel the
  editor by answering that objection properly — it retires the quick-pick sequence instead
  of adding a form beside it — but that is a bigger change than this phase, and the panel
  is worth having before it.
- It renders from the store on every open and on `store.onDidChange`. No client-side
  state, therefore no `retainContextWhenHidden`: rebuilding costs a template call, while
  a retained hidden webview costs memory in every window forever.
- One panel, reused. A second agent replaces the content and keeps the tab; a panel per
  agent turns the editor into a wall of tabs nobody closes.

### 14.2 Split the content out of the `vscode` layer ✅
- `src/ui/panel/agentPanelContent.ts` — a pure function from a view model to an HTML
  string. No `vscode` import, therefore a unit test, the same split that makes
  `buildViewData` testable in phase 10.
- `src/ui/panel/agentPanel.ts` — the thin part that owns the `WebviewPanel`, subscribes to
  the store, posts updates and disposes cleanly.
- The view model is assembled by the same snapshot builder the tree uses, so the two
  surfaces can never disagree about whether an agent is ready to run.

### 14.3 What it shows ✅
- Header: name, enabled state, execution mode, and — for chat mode — the sentence saying
  the answer is not captured, in the same words as the run tooltip.
- Schedule: the sentence from `describeCron`, the next three runs from `nextRuns`, the
  timezone that produced them, and the allowed window and daily cap when set.
- Source: connection name, base URL, and the query or repository, with the stored cursor
  when there is one.
- Prompt: inline text or file path, the placeholders it uses, and the snapshot state when
  a file prompt has fallen back.
- Model and tools, with the same warning the wizard shows when `runScript` is enabled and
  the whitelist is empty.
- The last ten runs: status, when, items, duration, and a link that opens the result file
  or the run document.
- Actions: Run Now, Edit Agent, Open Result Folder — each one posts a message that the
  extension side turns into the existing command. The panel adds no behaviour of its own.

### 14.4 Rules the webview has to hold to ✅
- `default-src 'none'` in the CSP, a nonce on the one inline script, `localResourceRoots`
  limited to the extension's own media folder. The extension may only talk to the
  configured hosts; a webview that could `fetch` would be a hole in that promise, and the
  CSP is what closes it.
- Colours, fonts and focus rings come from `var(--vscode-*)`. No bundled font, no icon
  file, no colour literal — a panel that ignores the active theme looks broken in half of
  them.
- No inline event handlers: listeners are attached in the nonce'd script.
- Every string is built through the same escaping helper. A prompt body is user content
  and lands in HTML; that is the one place in this extension where an injection is
  possible at all.

### 14.5 Packaging and the guard scripts ✅
The panel's script lives in `media/agentPanel.js` — the first file the extension ships that
is neither bundled by esbuild nor a brand asset — and all three guards have to learn about
it in the same commit:
- `.vscodeignore` needs the negation, and `scripts/check-package.mjs` the allowlist entry;
  it fails on any packaged file it does not recognise, which is what caught a 1.4 MB
  coverage directory once.
- `scripts/check-network.mjs` resolves `src` and proves there is one `fetch` call site
  there. A `fetch` in `media/` would sail past it, so the scan has to include the folder.
- `scripts/check-language.mjs` lists its targets explicitly (`src`, `docs`, `scripts`,
  `.github`, and named files); `media` is not among them and has to be added, or the one
  file in the repository most likely to grow user-facing strings is the one nobody checks.
- Done. `check-network` now walks `src` and `media` and accepts `.js` as well as `.ts`; it
  reports how many files it scanned, so switching the folder off again would be visible.
  ESLint also learned that `media/**` is a browser context — the alternative was turning
  `no-undef` off for the one file that most needs it.

### 14.6 How the panel opens ✅
**Decided:** a contributed command `rounds.showAgent`, titled `Show Agent`, with an inline
`$(open-preview)` icon on the agent row in `view/item/context`.
- The click on an agent keeps expanding its runs. That gesture already means something,
  and a panel that steals it would trade one useful behaviour for another.
- The alternative — an internal command wired to the tree item — would have kept the
  command list untouched, but `view/item/context` only accepts contributed commands, so
  the panel would have had no icon and no palette entry. A surface nobody can find is not
  worth a phase.
- **Specification change.** `rounds.showAgent` is not in the command list `plan.md` fixes.
  Amend `plan.md`, `package.json` (`contributes.commands` and the `view/item/context`
  entry, guarded by the same `viewItem =~ /^rounds\.agent/` clause the other item commands
  use) and the README command table in one commit. `contributions.unit.test.ts` checks the
  manifest against what the code registers, and an integration test checks that every menu
  `when` clause keys on a context value the tree produces — both have to stay green.
- The command takes an agent argument from the tree and falls back to a QuickPick of agents
  when invoked from the palette, which is how every other item-scoped command here behaves.
- Done, in `plan.md`, `package.json` (command plus an `inline@0` menu entry), `COMMAND_IDS`
  and the README.

### 14.7 Tests ✅
- Unit: the content function — the agent name and prompt appear, a chat-mode agent carries
  its limitation sentence, a prompt containing `<script>` comes out escaped, the CSP meta
  tag names a nonce that the script tag actually uses.
- Integration: opening the panel twice reuses one tab; disposing it releases the store
  subscription; a store change repaints; the Run Now message reaches the existing command.
- Done: 13 unit tests for the document and 4 integration tests for the panel's lifetime. The
  message handling is exercised through the panel's own dispatch rather than by simulating a
  click — a webview cannot be clicked from a test, and asserting that the dispatch reaches the
  existing command is the part that could actually break.

## Exit criteria

- [x] Opening an agent shows schedule, source, prompt, model, tools and the last ten runs in
      one panel beside the editor, and a store change repaints it without reopening.
- [x] The panel is read-only: every mutating action goes through an existing `rounds.*` command.
- [x] The CSP forbids every remote origin, the only script carries a nonce, and a prompt with
      HTML in it is escaped — proven by a test, not by inspection.
- [ ] The panel is legible in a light theme, a dark theme and a high-contrast theme. Every colour
      comes from a `var(--vscode-*)` token, which is what makes this likely; confirming it is a
      manual check, listed in [../manual-checks.md](../manual-checks.md).
- [x] `vsce package` includes the media file, and `check-package`, `check-network` and
      `check-language` all cover it.
- [x] `plan.md`, `package.json` and the README list `rounds.showAgent`, the icon appears on the
      agent row, and clicking an agent still expands its runs.
