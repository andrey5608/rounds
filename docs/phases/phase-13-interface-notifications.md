# Phase 13 — Interface refinements and notification policy

**Goal:** the view answers "what is about to happen" and "what just happened" without
opening anything, and notifications are one policy in one place instead of three call
sites that each decided for themselves.

**Depends on:** phase 10.

Phases 0–12 built the lifecycle. This one is about the part a person meets every day and
that a real installation showed to be thin: a schedule is entered blind, a run row says
what happened but not what it cost, and every notification decides its own dedup rule
inline in `src/extension.ts`.

## Steps

### 13.1 One owner for notifications (`src/ui/notifications.ts`) ✅
- Today the policy lives in three lambdas passed to the `Ticker` in `src/extension.ts`:
  failures dedupe through a `Map` held in that closure, the cap warning dedupes through
  `counters.capNotifiedAt`, and the frequency warning does not dedupe at all.
- Introduce a `Notifier` that owns the decision: what deserves a notification, which key
  it dedupes on, how long that key holds, and which actions the message offers.
  `src/extension.ts` keeps only the wiring.
- Take a `MessageHost` port (`showInformation`, `showWarning`, `showError`, each
  returning the chosen action) so the policy is unit-testable without the extension host.
  The `vscode` implementation is a five-line adapter, like `vscodeFileFinder` in phase 7.
- Dedup state stays in memory except where it already lives in the state file: the daily
  cap keeps `counters.capNotifiedAt`, because "once per day" has to survive a reload.
- Done: `Notifier` owns the rules, `src/ui/vscodeMessageHost.ts` is the adapter, and the
  container carries the notifier so later steps route through it. Coalescing changed the
  `Ticker` callback shape — `onFrequencyWarning` now receives the whole set at the end of
  `catchUp()` rather than one call per agent, which is what made one message possible.
  The mode is fixed at `failures` until step 13.3 introduces the setting, so this step
  changes behaviour in exactly one way: repeated warnings stop repeating.

### 13.2 The policy itself, written down ✅
| Event | Notified | Dedup key | Actions |
| --- | --- | --- | --- |
| Scheduled run succeeded | never | — | — |
| Scheduled run failed | yes | agent + local date | Show Output · Show Run History |
| Manual run finished | always, success included | none — the user asked | Open Result |
| Daily cap reached | once | local date | Open Settings |
| Schedule under the warning threshold | once per window, **coalesced** | agent set | Edit Agent |
| Model consent missing at run time | once per window | — | Check Setup |
| Prompt file unreadable | once per agent per local date | agent + date | Edit Agent |
- Coalescing is the new part: `catchUp()` calls `warnAboutFrequency` for every agent, so
  four fast agents produce four warnings on every window start. One message naming the
  agents is one interruption instead of four.
- Done. Two of these rows are reached through the failure path rather than through their own
  call site: `runFailed` reads the run's error code and sends `model.noConsent` and
  `model.unavailable` to the consent message, and anything `prompt.*` to the unreadable-prompt
  message. A failure whose fix is in Check Setup must not arrive as "show the output".
- The manual run goes through `notifier.requested`, the one path the mode never silences.

### 13.3 The `rounds.notifications` setting ✅
**Decided:** three values rather than a switch, because turning notifications off and
turning them up are both real requests and a boolean answers only one of them.
- Values: `failures` (default), `all`, `silent`. `silent` still writes the log line, the
  status bar state and the run record — it silences the toast, not the information.
- `all` adds the successful scheduled run to the table in 13.2 and nothing else; it exists
  for the first week after an agent is set up, when the question is whether it ran at all.
- `silent` covers every row of that table except a manual run: somebody who pressed
  Run Now is waiting for an answer, and swallowing it would be a bug, not a preference.
- **Specification change.** `rounds.notifications` is not in the setting list `plan.md`
  fixes, so that list grows by this one key. Amend `plan.md`, `package.json`,
  `SETTING_KEYS` in `src/state/settings.ts` and the README settings table in the same
  commit; `contributions.unit.test.ts` compares the manifest against `SETTING_KEYS`, so a
  half-done change fails the build rather than shipping.
- Why `rounds.notifications` earns its place: an unattended tool that cannot be told to be
  quiet gets uninstalled instead of configured, and `all` is what somebody wants for the
  first week after setting an agent up.
- Done, in `plan.md`, `package.json`, `SETTING_KEYS` and the README table. `NotificationMode`
  itself lives in `src/state/settings.ts` rather than next to the policy: it is configuration,
  and `state` is the layer `ui` reads from, never the other way round.

### 13.4 Live schedule preview in the wizard ✅
- `validateScheduleInput` only reports errors, so a valid cron expression produces no
  feedback at all until the agent runs.
- Return `vscode.InputBoxValidationMessage` with `severity: Information` for a valid
  expression: the sentence from `describeCron`, then the next three fire times in the
  agent's effective timezone. The same box then carries both the error and the
  confirmation.
- Add `nextRuns(expressions, count, from, timeZone)` to `src/scheduler/cron.ts`, next to
  `nextRunAt`. Pure, so it is a unit test; it also has to merge several expressions and
  drop duplicates, which is exactly the part worth pinning.
- Done. The decision is `describeScheduleInput` in `steps.ts`, which returns either an error or
  a preview; the wizard maps that onto `InputBoxValidationSeverity`, so the rule stays testable
  without the extension host. The enum member is `Info`, not `Information`.
- This also closed the daylight-saving test that [../leftovers.md](../leftovers.md) had been
  carrying: `nextRuns` needs it, so a 09:00 Berlin schedule is now pinned across the October
  transition — the wall clock holds at 09:00 and the instant behind it moves by an hour.

### 13.5 The tooltip stops hiding the schedule ✅
- Replace the single `- Next run:` line in `src/ui/agentsView.ts` with the next three,
  reusing `nextRuns` from 13.4. "Every 30 minutes" tells you the rate; three timestamps
  tell you whether the timezone is what you thought it was.
- Done, through `effectiveTimeZone` so the preview uses the same zone the scheduler will.

### 13.6 Run rows say what the run cost ✅
- `RunRecord` already carries `startedAt`, `finishedAt` and `sourceItemCount`, so nothing
  is added to the state: the row description becomes `12 items · 8.4 s — <summary>`, and
  a failed row leads with its error code.
- Duration formatting is a pure helper next to `describeRelative`, tested at the boundaries
  that matter (sub-second, minutes, a run that never finished).
- Done as `describeDuration` and `describeRun`. Both are pure but live in `agentsView.ts`,
  which imports `vscode`, so their tests are integration tests next to `describeAgent` —
  the unit-test guard would otherwise refuse the file, and moving two formatters into their
  own module to dodge that is a worse trade than the test living one directory over.
- A run with no `finishedAt` reports no duration at all rather than `0 s`: that record belongs
  to a window that went away mid-run, and inventing a number for it would be a lie repeated on
  every repaint.

### 13.7 The status bar leads somewhere useful ✅
- The item currently runs `rounds.showOutput`. The output channel is the right target
  while something is failing and the wrong one the rest of the time.
- Click opens the Agents view (`workbench.view.extension.rounds`); the tooltip keeps
  naming the output channel for the failure states, where it is what a person wants.
- Done. The item exposes its command so a test can hold the contract to it rather than the
  destination being decided in a constructor nobody reads.

### 13.8 Tests ✅
- Unit: the notifier's decisions and dedup keys against a fake `MessageHost` — including
  the coalesced frequency warning and `silent` still logging; `nextRuns` across a DST
  transition and with several expressions; the duration formatter.
- Integration: the tooltip contains three future timestamps; a run row shows its item
  count; the status bar command id is the view, not the channel.
- Done: 21 unit tests for the notifier, the preview and `nextRuns` (daylight saving included),
  and 5 integration tests for the tooltip, the run rows and the status bar target.

## Exit criteria

- [x] Every notification in the extension is raised by `Notifier`, and `src/extension.ts`
      contains no dedup logic of its own.
- [x] Four agents with sub-threshold schedules produce one warning on window start, not four.
- [x] `rounds.notifications: silent` produces no toast for a failed scheduled run, while the
      log line, the status bar state and the run record are unchanged.
- [x] A valid cron expression shows its meaning and its next three fire times inside the input
      box, in the agent's timezone.
- [x] A run row states items and duration; a failed row states its error code.
- [x] `plan.md`, `package.json`, `SETTING_KEYS` and the README all list `rounds.notifications`,
      and `contributions.unit.test.ts` passes.
