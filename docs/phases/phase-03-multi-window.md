# Phase 3 — Multi-window safety

**Goal:** exactly one window ticks the scheduler at a time, leadership survives crashes,
and a manual run works from any window without ever double-running an agent.

**Depends on:** phase 2. Can run in parallel with phases 4, 5, 7.

## Steps

### 3.1 Leader lock (`src/scheduler/leaderLock.ts`) ✅
- Lock file `rounds.lock` in `context.globalStorageUri` (the path from `plan.md`).
- Use `proper-lockfile` with: `stale: 30_000`, `update: 10_000` (heartbeat),
  `retries: 0` on the acquire attempt, and an `onCompromised` handler.
- Expose `acquire(): Promise<boolean>`, `release()`, `isHeld`, `onLost` event.

### 3.2 Leadership manager (`src/scheduler/leadership.ts`) ✅
- On activation, attempt acquisition **without blocking activation** (fire and forget).
- If not acquired, retry every 15 s (with a small random offset so windows do not
  stampede). If lost (`onCompromised`), stop the ticker immediately and go back to
  retrying.
- On `deactivate()`, release the lock so another window can take over instantly.
- Publish a context key `rounds.isLeader` for debugging and for the status bar tooltip.

### 3.3 Leader-only scheduling ✅
- Only the leader creates the interval ticker (phase 9). Followers keep their UI live by
  reacting to `store.onDidChange` (the `mtime`/revision poll from step 2.4).
- Any state write from a follower still goes through the revisioned store, so followers
  are never read-only, only tick-free.

### 3.4 Per-agent run claim ✅
- A manual run may start in a follower window while the leader is about to run the same
  agent on schedule. Prevent overlap with a **claim** in state, not only in memory:
  `runClaims: Record<agentId, { windowId: string; startedAt: string; heartbeatAt: string }>`.
- `tryClaim(agentId)` writes the claim through the revisioned store; it fails if a live
  claim exists. A claim with `heartbeatAt` older than 3 minutes is considered dead and
  can be taken over (log it as a recovered claim).
- The runner refreshes `heartbeatAt` every 30 s while a run is in flight and clears the
  claim in a `finally` block.
- `windowId` is a per-activation uuid stored in memory only.
- Claims are carried by the **state file only**, not by global state: `plan.md` fixes the
  four global state keys and a claim is not one of them. The file is also the channel that
  actually orders concurrent writes. A window reduced to the global-state fallback sees no
  claims, which is safe — the worst case is one duplicate run in a setup whose storage
  directory is already broken.
- Adding `runClaims` to the envelope needs no migration: a missing field normalizes to an
  empty object, which is exactly the correct starting value.

### 3.5 Crash and stale-state recovery ✅
- On activation, scan `runClaims` for entries owned by this `windowId` (impossible after
  a restart → leftovers from a crash) or with a dead heartbeat, and clear them, recording
  an `interrupted` run in history when a matching in-flight run record exists.

### 3.6 Tests and manual checklist ✅
- Unit: claim take-over rules with an injected clock; lost-leadership stops the ticker.
- Integration: a second **process** competes for the same lock directory, then is killed
  with `SIGKILL`, and this window takes the lock over. Two full extension hosts would prove
  the same thing far more slowly, and the interesting part is process death, not the host.
- Manual checklist file `docs/manual-checks.md` entry: open two windows, run an agent
  manually in the follower, confirm the leader does not run it concurrently.

## Exit criteria

- [x] With two windows open, exactly one holds `rounds.lock`. Covered by unit tests over a
      shared directory and by a cross-process integration test. "Only that one ticks" is
      structural for now: the ticker itself arrives in phase 9 and is gated on
      `leadership.isLeader`.
- [x] Killing the leader process transfers leadership without manual action. The
      cross-process test kills the holder with `SIGKILL` and takes the lock over; with the
      shipped 30 second staleness window that lands inside the 45 second budget.
- [x] A manual run from a follower blocks a concurrent scheduled run of the same agent.
      Enforced by the claim: the second window is refused and told which window holds it.
      The end-to-end version is exercised once the runner exists in phase 8, and stays on
      the manual checklist.
- [x] Stale claims left by a crash are cleared at the next activation, and the run they
      belonged to becomes `interrupted` instead of sitting in the history as running.
- [x] No state write from any window overwrites a newer revision (phase 2 guarantee, kept
      by routing every claim change through the same revisioned store).
