# Phase 4 — Setup, consent and model catalog

**Goal:** consent is requested only from user-initiated actions, the model list is
fetched live and cached, and `rounds.checkSetup` diagnoses every prerequisite with a Fix
action.

**Depends on:** phase 2. Parallel with phases 3, 5, 7.

## Steps

### 4.1 Consent gate (`src/setup/consentGate.ts`) ✅
- Single choke point: `requestModels(reason: UserAction)` — the only place in the code
  base allowed to call `vscode.lm.selectChatModels`.
- It accepts a `UserAction` token that can only be created by command handlers and
  wizard steps. Scheduler code cannot construct one; a lint rule or a private-symbol
  brand enforces it.
- `scripts/check-consent-gate.mjs` (part of `npm run check`) asserts two things:
  `selectChatModels` appears in exactly one file, `src/model/vscodeGateway.ts`, and
  `userAction(` is only called from `src/setup/`, `src/ui/` or the entry point — never from
  the scheduler, runner or connectors. Both rules were verified to fail on a deliberate
  violation.

### 4.2 Model catalog (`src/setup/modelCatalog.ts`)
- `list(action)` → `{ models: ModelInfo[]; fetchedAt: string }`, cached in memory and
  mirrored into state (ids and labels only) so the tree and validation work without a
  new consent-triggering call.
- `resolve(modelId, action)` → the exact model or `ModelNotFoundError` carrying the list
  of currently valid ids. **Never** substitutes another model.
- `hasConsent()` → derived from whether a previous successful `list` happened; persisted
  as `consentGrantedAt`.

### 4.3 Language model error mapping (`src/model/errors.ts`)
Map `LanguageModelError` and provider errors to typed, actionable results:

| Condition | Code | User-facing action |
| --- | --- | --- |
| Consent missing / `NoPermissions` | `model.noConsent` | Run `Check Setup` to grant model access |
| Quota or rate limit | `model.quotaExceeded` | Explain the daily cap settings, suggest lowering frequency |
| Model unavailable / `NotFound` | `model.unavailable` | Re-select the model for this agent (lists valid ids) |
| Request blocked | `model.blocked` | Show the provider message verbatim |
| Anything else | `model.unknown` | Include the original message, point at the output channel |

### 4.4 Setup checks registry (`src/setup/checks.ts`)
Each check is an object `{ id, title, run(): Promise<CheckResult>, fix?: Command }`,
where `CheckResult` is `pass | warn | fail` plus an English message.

1. `models` — consent granted and the model list is non-empty.
2. `jira` — base URL configured, token present in secret storage, live ping succeeds.
3. `git` — base URL configured, token present in secret storage, live ping succeeds.
4. `outputFolder` — resolved folder exists (create on demand) and is writable
   (write + delete a probe file).
5. `scriptWhitelist` — non-empty; `warn` only, with an explanation that `runScript` is
   inert until entries exist.
6. `rateLimits` — `jitterSeconds` in range, `maxExecutionsPerDay` sane, and no enabled
   agent has a cron firing more often than `rounds.minimumIntervalWarning`; `warn`.

Ordering is fixed; checks 2 and 3 are skipped with a `warn` when no agent uses that
source yet.

### 4.5 `rounds.checkSetup` command (`src/setup/checkSetupCommand.ts`)
- Runs all checks with progress notification, then shows a QuickPick listing each check
  with a `$(pass)/$(warning)/$(error)` icon and its message.
- Selecting an item invokes its Fix action: grant model access (calls `requestModels`
  with a user action), enter base URL (InputBox, validated as https URL), enter token
  (password InputBox → secret store), pick output folder, edit whitelist (opens settings
  filtered to `rounds.scriptWhitelist`).
- Results are cached in state so the tree can render a `needsSetup` badge without re-running
  network pings.

### 4.6 First-activation nudge
- On first activation ever, show a non-modal information message: what the extension
  does in one sentence + a `Check Setup` button + `Don't show again`.
- Never auto-run consent. Record `firstRunNoticeShownAt` in state.

### 4.7 `needsSetup` agent state
- Derive per agent: missing consent, unknown `modelId`, missing secret for its source, or
  unwritable output folder.
- Agents in `needsSetup` are never executed by the scheduler; a scheduled attempt records
  a `skipped` run with reason `needsSetup` (at most once per day per agent to avoid
  history spam).

### 4.8 Tests
- Unit: check registry results for every combination of missing prerequisites; error
  mapping table; `needsSetup` derivation.
- Integration: `rounds.checkSetup` runs end-to-end against a stubbed connector and a
  stubbed `vscode.lm` wrapper; asserts no `selectChatModels` call happens on activation.

## Exit criteria

- [ ] A fresh profile shows no consent prompt until the user runs `Check Setup` or the
      creation wizard.
- [ ] `selectChatModels` is referenced in exactly one source file, guarded by the gate.
- [ ] Every setup check reports pass/warn/fail with a working Fix action.
- [ ] An agent with an unknown `modelId` is reported as `needsSetup` and is not run.
- [ ] Model resolution never falls back to a different model.
