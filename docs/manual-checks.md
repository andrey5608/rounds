# Manual checks

Things automated tests cannot prove on their own. Run the relevant section before
finishing the phase it belongs to, and note the date and result in your pull request.

## Phase 1 — Contribution surface

- [ ] Press F5. The activity bar shows a **Rounds** container with an **Agents** view whose
      welcome content offers *Create Agent* and *Check Setup*.
- [ ] The command palette lists all eleven commands as `Rounds: <title>`.
- [ ] The settings UI shows a **Rounds** section with eleven settings and English
      descriptions.
- [ ] Nothing prompts for language model consent and no error notification appears.

## Phase 2 — State

- [ ] Reload the window. The output channel reports the agent count and the state
      revision, and the revision is unchanged by a plain reload.
- [ ] Corrupt `state.json` in the global storage folder by hand, then reload. The
      extension still activates, the file is renamed to `state.json.bad-<timestamp>`, and
      the output channel explains what happened.

## Phase 3 — Multi-window safety

- [ ] Open two windows on any folder. The status bar tooltip says *This window schedules
      runs* in exactly one of them, and *Another window schedules runs* in the other.
- [ ] Close the window that schedules runs. Within about 15 seconds the other window's
      tooltip changes to *This window schedules runs*.
- [ ] Kill the scheduling window's process (Activity Monitor or `kill -9`) instead of
      closing it. The other window takes over within about 45 seconds.
- [ ] With an agent configured, start it manually in the follower window while the leader
      is idle. The run happens once, and the leader does not start a second one.

## Phase 12 — Failure-mode rehearsal

These need a real tracker, a real repository host and a signed-in model provider, so they are checked
by hand before a release. Each one has an automated counterpart that covers the logic with a fake;
what a human is verifying here is that the message reaching the user is the right one.

| Failure | What should happen | Covered automatically by |
| --- | --- | --- |
| Revoke the tracker token mid-schedule | The run fails with "the host … rejected the stored token" and a Check Setup hint; the agent keeps its schedule | `http.unit.test.ts`, `runner.unit.test.ts` |
| Delete the prompt file | Behaviour follows `rounds.promptFileFallback`: snapshot, or a failure naming the file | `promptResolver.unit.test.ts` (all three policies) |
| Remove the configured model from the provider | The run fails listing the models that do exist; nothing is substituted | `modelCatalog.unit.test.ts`, `runner.unit.test.ts` |
| Disconnect the network | A typed network failure after the retries, no crash, the next run tries again | `http.unit.test.ts` |
| Make the result folder read-only | The run is still recorded, with no result path, and the log says why | `runner.unit.test.ts` (injected write failure) |
| Fill the disk | Same as above; the state write fails loudly rather than silently losing an agent | `fileStore.unit.test.ts` (corrupt and unreadable state) |
| Close the editor over a due time | The missed-run policy applies at the next start: skip, or exactly one catch-up run | `ticker.unit.test.ts` |
| Reach the daily limit | One notification, an explanation in the skipped run, and no further runs that day | `counters.unit.test.ts`, `ticker.unit.test.ts` |
| Hand off to chat | The chat input is filled, nothing is sent, and the run says the answer was not captured | `runner.unit.test.ts` |

### Soak

- [ ] Leave one window open for 24 hours with an agent on a 15 minute schedule and fake credentials.
      Afterwards: the history holds no more than the configured limit, the output channel shows one
      run per schedule with no duplicates, and the editor's process memory has not grown noticeably.

### Packaging

- [ ] Install the built VSIX into a clean profile, then run through: Check Setup, create an agent,
      Run Now, wait for one scheduled run, open the result file, show the history, delete the agent.

## Phase 14 — Agent panel

Every colour in the panel comes from a `var(--vscode-*)` token, so it should follow the active
theme. What a test cannot judge is whether it is *legible*, which is the point of looking.

1. Open an agent with **Rounds: Show Agent**, or the icon on its row.
2. Switch between a light theme, a dark theme and a high-contrast theme (`Preferences: Color Theme`).
3. In each one, check that the headings, the muted text, the prompt block and the warning lines are
   all readable, and that the buttons look like buttons.
4. Tab through the panel: the run links and the three buttons must show a visible focus ring.
