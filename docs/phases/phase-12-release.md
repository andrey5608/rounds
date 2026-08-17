# Phase 12 — Hardening, testing and release

**Goal:** prove the constraints hold, close the test matrix, package a VSIX and run a
release checklist. Milestone **M4**.

**Depends on:** phase 11.

## Steps

### 12.1 Test matrix completion
| Layer | Scope | Runner |
| --- | --- | --- |
| Unit | state, cron, jitter, caps, placeholders, prompt fallback, tools, agentic loop, result writer | Mocha, no extension host |
| Integration | activation, commands, tree, wizard steps, setup checks, result file on disk | `@vscode/test-electron` |
| Multi-window | leader election, take-over, run claims | two hosts, shared global storage |
| Soak | 24 h with a 15-minute cron and fakes: no leaks, no duplicate runs, history capped | manual/nightly |

- Coverage target: 80% lines on `src/state`, `src/scheduler`, `src/agents`, `src/tools`.

### 12.2 Constraint audits (each one a script or a test, not a manual promise)
- **No LLM SDK** — dependency check from step 0.5, plus a bundle grep for known SDK
  identifiers.
- **No model HTTP calls** — grep the bundle for model provider hostnames; assert all
  outbound calls go through `src/connectors/http.ts` (single `fetch` call site test).
- **Host allowlist** — integration test attempting a foreign host, expecting a rejection.
- **Consent gate** — AST test: exactly one `selectChatModels` call site.
- **English-only** — CI language check.
- **Trademarks** — test over `package.json` contribution titles and setting keys.
- **Secret hygiene** — test that a dump of `globalState`, of the state file and of the
  output channel contains no token value.

### 12.3 Performance and resource checks
- Activation time measured with the built-in extension host profiler; target < 100 ms.
- Ticker cost: one state read per 30 s tick; assert no per-tick file rewrite.
- Tree refresh throttling verified (no refresh storm when many runs finish).
- Memory: soak run shows no unbounded growth in history or in-memory caches.

### 12.4 Failure-mode rehearsal (manual checklist in `docs/manual-checks.md`)
- Revoke the Jira token mid-schedule → failed run with an actionable message.
- Delete the prompt file → behaviour matches each of the three fallback policies.
- Remove the configured model from the provider → run fails with the valid-id list.
- Disconnect the network → typed `NetworkError`, retry then failure, no crash.
- Fill the disk / make the output folder read-only → failed run, clear message.
- Close VS Code over a due time → missed-run policy applies at next startup.

### 12.5 Packaging
- `npx @vscode/vsce package` produces a VSIX; inspect its contents for stray files
  (`.vscodeignore` must exclude `docs/`? — keep `README.md`, `CHANGELOG.md`, `LICENSE`,
  `dist/`; exclude `src/`, tests, fixtures, `plan.md`).
- Install the VSIX into a clean profile and re-run the first-run experience end to end.
- Verify the extension size and that `dist/extension.js` is the only bundled entry.

### 12.6 Release checklist
- [ ] `publisher` replaced with the real one (removing `TODO-PUBLISHER`).
- [ ] Version set to `1.0.0`, CHANGELOG entry dated.
- [ ] README warnings present: "runs only while VS Code is open" and the acceptable-use
      disclaimer with links.
- [ ] All CI checks green on the release commit; tag `v1.0.0`.
- [ ] Out-of-scope items confirmed absent: no chat participant, no Language Model Tools
      contribution, no background execution outside VS Code, no config sync.
- [ ] A clean-profile install performs a full lifecycle: setup → create agent → manual run
      → scheduled run → result file → history.

## Exit criteria

- [ ] Every audit in 12.2 exists as an automated check and passes.
- [ ] The test matrix in 12.1 is complete and green.
- [ ] The failure-mode rehearsal is executed and recorded.
- [ ] A VSIX installs into a clean profile and completes the full lifecycle.
- [ ] The release checklist is fully ticked.
