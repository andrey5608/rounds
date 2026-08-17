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
| English descriptions | Letters outside ASCII in tracked text | `check-language.mjs` |
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

### 12.5 Packaging ✅
- `vsce package` produces a 114 KB VSIX: `package.json`, the README, the licence, the changelog,
  `dist/extension.js`, and the three brand assets an install needs — the marketplace icon, the
  activity bar glyph and the README image.
- **`vsce package` builds nothing by itself.** The first attempt with a real publisher shipped a 662 KB
  development bundle, because the last thing to touch `dist/` had been a watch build. A
  `vscode:prepublish` script now runs the production build, and `check-bundle` fails on a bundle that
  still references a sourcemap — the one signal that separates the two, since an unminified bundle
  passes every other audit. Verified in both directions.
- **A marketplace README may not embed an SVG**: `vsce` refuses to package one and says so. The README
  therefore shows a PNG rendered from `docs/media/rounds-lockup.svg`, and links the vector source next to
  it. The vector originals stay in the repository and out of the package.
- The first attempt shipped 403 KB, including **1.4 MB of coverage artefacts**, the guard scripts, the
  ESLint config and the development sourcemap. Two things came out of that: `coverage/` was missing
  from `.gitignore` and two artefact files had already been committed (now removed), and
  `.vscodeignore` was written as a short list of guesses rather than a considered one.
- Rather than fix it and hope, the file list is now an **allowlist** checked by
  `scripts/check-package.mjs` (`npm run check:package`), which fails on anything unexpected and on
  anything missing. Verified by deleting one exclusion and watching it fail.
- `npm run package` cleans `dist/` first, so a production build cannot inherit the sourcemap a watch
  build left behind.
- Installing into a clean profile stays on the manual checklist: it needs a real editor and real
  credentials to be worth anything.

### 12.6 Release checklist ✅ (as far as it can be, see below)
Three of these are the owner's to do, and the difference is stated rather than blurred: the first two
because publishing is their decision, the last because it needs a real editor and real credentials.

- [x] `publisher` is `rounds`, the id the owner registered. The extension id is `rounds.rounds`.
- [x] `icon` is `docs/media/rounds-icon-128.png`, from the brand assets the owner supplied. The activity
      bar uses `docs/media/rounds-activitybar.svg` instead of the codicon the plan originally named, and
      `plan.md` was amended rather than left to contradict the manifest.
- [ ] **Owner:** capture the README screenshots for the wizard. They need a real tracker and a
      signed-in provider, so the section is written in prose until then.
- [x] Version is `1.0.0` and the changelog entry is dated. A test asserts the manifest and the
      changelog agree about the version, so they cannot drift apart quietly.
- [x] README carries both warnings: agents run only while the editor is open, and the acceptable use
      disclaimer with links that were fetched and verified.
- [x] Out-of-scope items confirmed absent, in the manifest rather than from memory: a test asserts no
      `chatParticipants`, no `languageModelTools` and no `configurationDefaults` contribution. There
      is no background execution because there is no code outside the extension host, and no config
      sync because nothing writes outside `globalState` and the storage folder.
- [x] Every automated check passes locally, each run on its own: `check`, `lint`, `typecheck`,
      `test:coverage`, `test:integration`, `check:bundle`, `check:package`.
- [ ] **Owner:** tag `v1.0.0` and install the VSIX into a clean profile for the full lifecycle —
      Check Setup, create an agent, Run Now, one scheduled run, the result file, the history, delete.
      The checklist for it is in `docs/manual-checks.md`.

## Exit criteria

- [x] Every audit in 12.2 exists as an automated check and passes: seven guard scripts and the tests
      they cannot replace, all wired into CI.
- [x] The test matrix in 12.1 is complete and green: 435 unit tests and 34 integration tests, with
      coverage gating the build at 80% and standing at 93%.
- [ ] The failure-mode rehearsal is **written, not executed**. Every item needs a real tracker, a real
      repository host and a signed-in model provider; the automated counterpart of each one passes.
- [ ] A VSIX **builds** and its contents are audited down to five files; installing it into a clean
      profile is the owner's step.
- [ ] The release checklist is ticked except for the three items that belong to the owner: the
      publisher id, the icon, and the tag plus clean-profile install.

Phase 12 is therefore complete in everything that does not require credentials or a marketplace
identity, and those gaps are named here rather than quietly ticked. Every open item across all
thirteen phases is collected in [../leftovers.md](../leftovers.md).
