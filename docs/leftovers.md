# Leftovers

Everything the build plan did not close, in one place, with the reason. Phases 0–12 are otherwise
complete: the per-step detail stays in [`phases/`](./phases/), and this page exists so nobody has to
reconstruct the gaps by reading thirteen documents.

Kept honest on purpose. An item here is either genuinely undone or genuinely somebody else's to do,
and the two are not blurred together.

## 1. Blocked on the owner

None of these can be produced from inside the repository: they need a marketplace identity, a design
decision, or a working installation.

| Item | Where it stands | How to close it |
| --- | --- | --- |
| README screenshots | The "Creating your first agent" section is written in prose | Capture the wizard against a real tracker and a signed-in provider |
| Tag `v1.0.0` | Version and changelog say 1.0.0; no tag exists. Nothing blocks it any more | Tag the release commit, then `vsce publish` |

Closed since this list was written: the icon and the activity bar glyph, from the brand assets in
[`docs/media/`](../media), and the publisher id, which is now `rounds`. What remains is the screenshots and
the release act itself.

## 2. Needs a real environment

These are written and unexecuted. Every one has an automated counterpart that covers the *logic*;
what a person verifies by hand is the part a test cannot judge — that the window, the tooltip or the
message is the right one.

| Item | Checklist | Automated counterpart |
| --- | --- | --- |
| Contribution surface: activity bar, palette, settings UI | [manual-checks.md](./manual-checks.md#phase-1--contribution-surface) | `contributions.integration.test.ts` |
| State survives a reload; a corrupt state file is quarantined | [manual-checks.md](./manual-checks.md#phase-2--state) | `fileStore.unit.test.ts`, `state.integration.test.ts` |
| Two windows: who schedules, handover, handover after a kill | [manual-checks.md](./manual-checks.md#phase-3--multi-window-safety) | `leadership.integration.test.ts` (cross-process), `runClaims.unit.test.ts` |
| Failure-mode rehearsal: revoked token, deleted prompt file, vanished model, no network, read-only folder, full disk, closed editor, daily limit, chat handoff | [manual-checks.md](./manual-checks.md#phase-12--failure-mode-rehearsal) | one per row, listed in that table |
| 24 hour soak | [manual-checks.md](./manual-checks.md#soak) | `performance.unit.test.ts` covers the idle cost and the bounds |
| Clean-profile install and full lifecycle | [manual-checks.md](./manual-checks.md#packaging) | `check:package` audits what the VSIX contains |

## 3. Missing functionality

One thing the specification asks for is not implemented.

**A manual run cannot deliberately exceed the daily limit.** `plan.md` step 9.4 says a manual run may
exceed the cap "after an explicit confirmation modal that names the cap". Today a manual run past the
limit is skipped with the same explanation as a scheduled one. Recorded in
[phase 9](./phases/phase-09-scheduler.md) and [phase 10](./phases/phase-10-ui.md), and listed under
known limitations in the [changelog](../CHANGELOG.md).

To close it: in `runNowCommand`, ask `counters.canRun` before dispatching, and on a refusal show a
modal naming the limit; when the user insists, run with a flag the runner passes through its cap
check. The counter must still be incremented, so the day's total stays truthful.

## 4. Fixed after release testing

Kept here because the next person deserves to know it was wrong once:

- **Check Setup reported no model access with a working provider installed, and granting it appeared
  to do nothing.** Two causes, both mine. `selectChatModels()` was asked once, so a provider that had
  not finished starting answered with an empty list; and the request named no vendor, so the editor
  had no provider to raise its consent dialog for and silently returned nothing. It now waits for the
  model-change event, and falls back to naming the vendor when a bare request comes back empty. See
  [phase 4](./phases/phase-04-setup-consent.md).
- **Diagnosing that took three rounds of guessing, because the evidence was not being kept.** There is
  now an always-on extended log at `logs/rounds-<date>.log` in the extension's storage folder, holding
  every line regardless of `rounds.logLevel`, plus an environment header: editor and extension version,
  whether the language model API is present, and which installed extensions look like providers and
  whether they activated. See [phase 2](./phases/phase-02-state.md).

## 5. Worth adding, not required

- **A dedicated daylight-saving transition test.** Time zone handling is proven across zones on the
  same instant, and every next run is recomputed when the zone setting changes, but no test pins a
  real DST date. Noted in [phase 9](./phases/phase-09-scheduler.md). Pick a transition date in a zone
  that observes it, and assert the next run neither doubles nor disappears.

## 6. Not leftovers: out of scope for v1

Listed so nobody files them as gaps. These are decisions from [`plan.md`](../plan.md), and a test
asserts the first two are absent from the manifest rather than merely unmentioned:

- No chat participant integration and no Language Model Tools contribution.
- No execution while the editor is closed — the scheduler lives in the editor process.
- No sharing of agent configuration between machines or people.
- No model parameters beyond what the editor's language model API accepts.
