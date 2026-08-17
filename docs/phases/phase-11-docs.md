# Phase 11 — Documentation and compliance

**Goal:** the deliverable documentation from `plan.md`: a README covering setup, the
"runs only while VS Code is open" caveat and the acceptable-use disclaimer, plus a
CONTRIBUTING note on registering a new tool or connector.

**Depends on:** phase 10 (the UI must be final before it is documented).

## Steps

### 11.1 README (`README.md`, English only) ✅
Sections, in this order:

1. **What it is** — one paragraph, the "making the rounds" idea, the vocabulary
   (agent, run, source, tool).
2. **Requirements** — VS Code 1.95+, and an active Language Model API provider such as
   GitHub Copilot (named descriptively, in prose only).
3. **Install and set up** — install, run `Rounds: Check Setup`, grant model access, add
   base URLs and tokens, pick an output folder.
4. **Creating your first agent** — the wizard steps in order, plus the placeholder table. Written
   without screenshots: capturing them needs a real tracker, a real repository and a signed-in model
   provider, so they are listed on the release checklist rather than faked.
5. **Execution modes** — `api` (result captured to a file) vs `chat` (handoff for review,
   output not captured).
6. **⚠️ Runs only while VS Code is open** — its own prominent section: the scheduler
   lives in the editor process, one window is the leader, missed runs follow
   `missedRunPolicy`.
7. **⚠️ Acceptable use and rate limits** — automating a model provider can get an account
   rate-limited or restricted; link GitHub's Acceptable Use Policies and the Copilot
   terms; explain `jitterSeconds`, `maxExecutionsPerDay`, `minimumIntervalWarning` and
   allowed time windows as the built-in mitigations; state that the user is responsible
   for the volume they schedule. Both links were fetched and confirmed to be the pages they claim to
   be, rather than written from memory.
8. **Settings reference** — table of all 11 keys with defaults and effects.
9. **Commands reference** — table of all 11 commands.
10. **Where results are stored** — folder resolution order, file naming, front matter.
11. **Data and privacy** — what leaves the machine and where to: the configured Jira/Git
    hosts and the model provider; tokens live in the OS secret storage; nothing else is
    transmitted; no telemetry.
12. **Troubleshooting** — model not available, consent missing, token expired, prompt
    file unreadable, cap reached, nothing runs (window is not the leader / master switch
    off).
13. **Known limitations for v1** — the out-of-scope list from `plan.md`.

### 11.2 CONTRIBUTING (`CONTRIBUTING.md`) ✅
- Project layout and dependency direction (copy the architecture map).
- Development loop: `npm run watch`, F5, running unit vs integration tests.
- **Adding a tool** — the recipe: create `src/tools/<name>.ts` implementing `RoundsTool`,
  write the JSON schema, implement `checkPermission`, register it in `src/tools/index.ts`,
  add hostile-input unit tests, document it in the README tool list.
- **Adding a connector** — implement the connector interface, produce `SourceItem`s, map
  errors to the four typed errors, add a `ping()`, add fixtures, register it in the
  factory and in the wizard's source step.
- **Rules that are enforced mechanically** — English-only check, no LLM SDK dependency,
  trademark rule, `selectChatModels` only behind the consent gate.
- Commit and PR conventions; keep the relevant `docs/phases/` file updated when a step changes.
- Also records the two testing habits this project learned the hard way: run each check separately
  rather than chaining them with `&&`, and never let an assertion compare against a
  re-implementation of the code under test.

### 11.3 Marketplace metadata ✅
- `galleryBanner`, `repository`, `bugs` and `homepage` are set. `description` and `keywords` name no
  product, per the trademark rule.
- **No `icon` is shipped.** Drawing a logo is the owner's decision, and a placeholder graphic would
  be worse than the marketplace default: it looks like a finished choice nobody made. It sits on the
  release checklist next to the publisher, which is the same kind of gap.
- `publisher` stays `TODO-PUBLISHER`; the release checklist in phase 12 requires replacing it.

### 11.4 CHANGELOG ✅
- Fill `## [1.0.0]` with the feature set grouped as Added / Known limitations.

### 11.5 Documentation review pass
- Re-read every user-facing string in the source (`package.json`, notifications, errors,
  tooltips) against: English-only, trademark rule, agent/run/source/tool vocabulary,
  no "job"/"task"/"cron job" as nouns.
- Fix violations in the same pass; the language check script from phase 0 runs in CI.

## Exit criteria

- [ ] README covers all 13 sections above, including both warning sections.
- [ ] CONTRIBUTING contains working, followed-once recipes for a new tool and a new
      connector.
- [ ] Every user-facing string passes the vocabulary and trademark review.
- [ ] CHANGELOG has a 1.0.0 entry.
- [ ] The language check and dependency check pass in CI.
