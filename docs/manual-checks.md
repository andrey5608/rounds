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
