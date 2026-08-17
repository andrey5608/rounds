# Phase 12 — Hardening, testing and release

**Goal:** prove the constraints hold, close the test matrix, package a VSIX and run a
release checklist. Milestone **M4**.

**Depends on:** phase 11.

## Steps

### 12.1 Test matrix completion ✅
| Layer | Scope | Runner |
| --- | --- | --- |
| Unit | state, cron, jitter, caps, placeholders, prompt fallback, tools, agentic loop, result writer | Mocha, no extension host |
| Integration | activation, commands, tree, wizard steps, setup checks, result file on disk | `@vscode/test-electron` |
| Multi-window | leader election, take-over, run claims | two hosts, shared global storage |
| Soak | 24 h with a 15-minute cron and fakes: no leaks, no duplicate runs, history capped | manual/nightly |

- Coverage target: 80% lines on `src/state`, `src/scheduler`, `src/agents`, `src/tools`.

### 12.2 Constraint audits (each one a script or a test, not a manual promise) ✅
| Constraint | How it is checked | Where |
| --- | --- | --- |
| No language model SDK | Declared dependencies, and the shipped bundle searched for SDK paths | `check-dependencies.mjs`, `check-bundle.mjs` |
| No direct model HTTP call | The bundle searched for provider endpoints and for anything shaped like a model API key | `check-bundle.mjs` |
| Requests only to configured hosts | `fetch` called from one file only, and no other network client anywhere | `check-network.mjs` |
| Host allowlist honoured | A path leaving the host is refused, and redirects are never followed | `http.unit.test.ts` |
| Consent gate | `selectChatModels` called in one file; user action tokens confined to the UI layer | `check-consent-gate.mjs` |
| English only | Letters outside ASCII in tracked text | `check-language.mjs` |
| Trademarks | No product name in the extension name, command titles, view titles or setting keys | `contributions.unit.test.ts` |
| Secret hygiene | A stored token appears in neither the state file, global state, the log, nor a header | `secretHygiene.unit.test.ts` |
| Editor API external | The bundle requires `vscode` rather than containing it | `check-bundle.mjs` |
| Bundle size | A tripwire, not a budget: an order-of-magnitude jump means a dependency came along | `check-bundle.mjs` |

`npm run check` runs the five source-level guards; `npm run check:bundle` builds and audits what
actually ships, and CI runs both. The two new guards were verified to fail on a deliberate second
`fetch` call site and on a second network client.

The secret hygiene audit is deliberately a test rather than a design argument: every place it looks
at — the state file, global state, the output channel — is something a user might paste into an issue
report.

### 12.3 Performance and resource checks ✅
- Activation time measured with the built-in extension host profiler; target < 100 ms.
- Ticker cost: one state read per 30 s tick; assert no per-tick file rewrite.
- Tree refresh throttling verified (no refresh storm when many runs finish).
- Memory: soak run shows no unbounded growth in history or in-memory caches.

### 12.4 Failure-mode rehearsal (manual checklist in `docs/manual-checks.md`) ✅
The list lives in `docs/manual-checks.md`, where each failure is paired with the automated test that
already covers its logic. That pairing is the point: what a person is verifying by hand is that the
message reaching the user is the right one, not that the branch is taken — a test can prove the
branch, and cannot judge the wording.

Covered: a revoked token mid-schedule, a deleted prompt file under each fallback policy, a model that
disappeared from the provider, a disconnected network, a read-only result folder, a full disk, an
editor closed over a due time, the daily limit, and a chat handoff.

Not executed here: all of it needs a real tracker, a real repository host and a signed-in provider.
The checklist is written; running it is a release step, and pretending otherwise would be the one
thing this document must not do.

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
