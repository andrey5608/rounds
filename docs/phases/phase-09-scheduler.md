# Phase 9 — Scheduler and rate-limit safety

**Goal:** unattended runs in the leader window with cron + timezone support, and the full
non-negotiable safety set: jitter, daily caps, frequency warnings, time windows.
Milestone **M3**.

**Depends on:** phases 3 and 8.

## Steps

### 9.1 Cron service (`src/scheduler/cron.ts`) ✅
- `validate(expr)` → ok or an English error with the offending field.
- `nextRun(expr[], after: Date, timezone)` → earliest next occurrence across all
  expressions (an agent may have several), computed with `cron-parser` in the effective
  timezone (`agent.schedule.timezone` → `rounds.timezone` → system). The installed
  `cron-parser` 5.x API is `CronExpressionParser.parse(expression, { tz, currentDate })`.
- `describe(expr)` → human-readable text via `cronstrue` for the tree and the wizard.
- `minIntervalMinutes(expr)` → smallest gap over the next 50 occurrences, used for the
  frequency warning.

### 9.2 Ticker (`src/scheduler/ticker.ts`)
- `setInterval` every 30 s, started only when this window is the leader and
  `rounds.enabled` is true; stopped on leadership loss, on setting change, and on
  deactivation.
- Each tick: load state, compute due agents (`nextRunAt <= now`), and dispatch them
  sequentially (never in parallel — this keeps model usage low and predictable).
- A tick never awaits a full run before scheduling the next tick; in-flight agents are
  tracked in memory plus the state claim so the same agent never overlaps itself.
- Ticks are cheap and silent at `info` level; details go to `debug`.

### 9.3 Jitter ✅
- Before a **scheduled** run, wait `random(0, rounds.jitterSeconds)` seconds (default
  600, clamped to 0–1800). Manual runs never jitter.
- The delay is interruptible (cancellation on shutdown / disable) and is recorded in the
  run record as `jitterSeconds`.
- The jitter happens after the due check but before the daily cap increment, so a
  cancelled jitter does not consume quota.

### 9.4 Daily caps
- Global `rounds.maxExecutionsPerDay` (default 24) plus optional `agent.maxExecutionsPerDay`.
- Counted by **local date** in the effective timezone, through the phase 2 counters.
- When a cap blocks a run: record a `skipped` run with reason `dailyCapReached` and show
  **one** notification per local date (`capNotifiedAt` guard), offering `Open Settings`.
- Manual runs also count against the caps but are allowed to exceed them after an
  explicit confirmation modal that names the cap.

### 9.5 Allowed time window ✅
- Optional per-agent `allowedTimeStart` / `allowedTimeEnd` (`HH:mm`, effective timezone),
  supporting windows that cross midnight: "22:00 to 06:00" is an ordinary way to say overnight, and
  reading it as an empty range would silently stop the agent forever.
- A due run outside the window is skipped (recorded once per occurrence, not spammed) and
  `nextRunAt` advances to the next occurrence.

### 9.6 Frequency warning
- `rounds.minimumIntervalWarning` (default 30 minutes). When an agent's cron fires more
  often than that: warn in the creation/edit wizard (blocking confirmation, not a hard
  error), flag it in `rounds.checkSetup`, and mark the agent in the tree with a warning
  icon and tooltip.

### 9.7 Startup and missed runs ✅
- On leader startup: for each enabled agent, if `nextRunAt` is in the past, apply
  `missedRunPolicy` — `skip` advances `nextRunAt` to the next future occurrence and
  records nothing; `runOnce` runs the agent **once**, however many occurrences were missed.
  Replaying a whole weekend would surprise the user and exhaust the daily limit in one go.
- `runOnStartup: true` runs the agent shortly after leadership is acquired, subject to
  caps, window and jitter.
- A start-up burst guard: at most 3 agents run in the first 5 minutes after activation;
  the rest are deferred to their normal schedule.

### 9.8 Next-run bookkeeping ✅
- After every run (or skip), recompute `nextRunAt`:
  - scheduled run → next occurrence after now;
  - manual run → per `rounds.manualRunNextRunPolicy`: `advance` keeps the existing next
    run, `fromNow` recomputes from the manual run time.
- Recompute all `nextRunAt` values when `rounds.timezone` changes, when an agent's
  schedule is edited, and when an agent is enabled.
- All updates go through the revisioned store.

### 9.9 Master switch
- `rounds.enabled: false` stops the ticker entirely, sets the status bar to a disabled
  state, and leaves manual runs available.

### 9.10 Tests
- Unit with an injected clock: due computation across DST boundaries in a non-UTC zone,
  multi-expression agents, midnight-crossing windows, cap rollover at local midnight,
  jitter bounds, missed-run policies, manual next-run policies, burst guard.
- Integration: a fake clock driven ticker executes an agent exactly once per due time and
  never concurrently.

## Exit criteria

- [ ] A scheduled agent runs unattended in the leader window with jitter applied.
- [ ] Global and per-agent caps block further runs and notify exactly once per day.
- [ ] Agents outside their allowed window are skipped and rescheduled correctly.
- [ ] Sub-30-minute crons produce a warning in the wizard, in setup check and in the tree.
- [ ] Missed runs follow their policy after VS Code was closed.
- [ ] DST transitions do not double-run or skip a run — proven by clock tests.
