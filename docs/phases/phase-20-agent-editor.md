# Phase 20 — Agents created and edited in the panel

**Goal:** one surface for an agent — read it, change it, create it, delete it — instead of a
panel that only shows and a question sequence that only asks.

**Depends on:** phases 14, 18 and 19.

Phase 14 deliberately kept the panel read-only, on the grounds that a second editor means a
second set of validation rules. That objection is answered here rather than ignored: the
panel becomes the only editor, and the question sequence in `src/ui/wizard/agentWizard.ts`
is retired. What survives is `src/ui/wizard/steps.ts` — the pure validators and the draft
conversion — which stops being the wizard's private code and becomes the rules both the
form and the tests speak through.

## Steps

### 20.1 One form, two entry points
- `rounds.showAgent` (phase 14) opens an agent in the panel. `rounds.editAgent` opens the
  same panel with the first field focused. `rounds.createAgent` opens it with an empty
  draft. No new command ids: viewing and editing an agent are not different enough to be
  different surfaces.
- Save is disabled until something changes, so opening an agent to look at it cannot end in
  a write.
- Leaving with unsaved changes asks once. A form that discards work silently is worse than
  a form that interrupts.

### 20.2 The fields
- Identity: name (unique, validated by the existing rule), enabled, execution mode with the
  chat-mode consequence spelled out next to it rather than in a tooltip.
- Source: connection (a dropdown of what phase 18 manages, filtered by kind), then the
  project and repository pickers from phase 19, or the tracker's project and query.
- Prompt: inline text in a real multi-line field, or a file with the discovery picker from
  phase 16; the placeholder list beside it, and placeholder validation on the value.
- Model and tools, with the empty-whitelist warning that `runScript` already triggers.
- Schedule: the expression, the sentence from `describeCron` and the next three runs from
  phase 13, live while typing.
- Advanced, collapsed: timezone, startup behaviour, daily cap, allowed window, output
  folder. Collapsed because phase 10 learned that asking these questions up front is what
  made creation feel like an interrogation.

### 20.3 Where the rules live
- The webview holds the draft and renders errors. It decides nothing: every keystroke that
  matters is validated by the extension side calling the same functions in `steps.ts` that
  the unit tests call.
- The frequency warning stays a modal confirmation on save, not an inline note. It is the
  one rule that asks somebody to accept a consequence, and an inline note is dismissible by
  not reading it.
- Saving goes through `draftToAgent` and one revisioned store update; a conflict reloads,
  re-applies and retries, exactly like every other write in this extension.

### 20.4 Retiring the question sequence
- `agentWizard.ts` loses the QuickPick flow — around seven hundred lines whose job the form
  now does. Its callers become the panel.
- `steps.ts` keeps every validator and gains the ones the wizard held inline.
- The integration tests that drove the wizard are deleted rather than rewritten: they proved
  that a sequence of quick picks produced a draft, and that sequence no longer exists. What
  replaces them is in 20.6.
- This is the phase's real cost and it is worth stating plainly: working, tested code is
  removed because keeping it would mean maintaining two ways to build the same object.

### 20.5 Deleting from the panel
- The delete action reuses `rounds.deleteAgent` and its modal confirmation, unchanged: the
  panel adds no destructive behaviour of its own, and the wording that says result files
  are kept and history is removed stays in one place.

### 20.6 Keyboard and accessibility
- The flow being replaced was keyboard-only, so the form has to be usable the same way:
  every control reachable by Tab in reading order, every input tied to a real `<label>`, the
  error summary focusable, Escape closing the panel with the unsaved-changes question.
- This is not polish. Replacing a keyboard-first flow with a mouse-first one is a
  regression whatever it looks like.

### 20.7 Tests
- Unit: the draft-to-agent conversion for every field, including the source shapes from
  phase 19; validation results mapped to the field that produced them; unsaved-change
  detection.
- Integration: create, edit, duplicate and delete through the panel's message protocol; a
  save that hits a revision conflict retries and does not lose the edit; changing the
  connection re-labels the source fields and clears the cursor.

## Exit criteria

- [ ] An agent is created, read, changed and deleted from the panel, with no quick-pick sequence
      left in the code.
- [ ] Every validation rule has exactly one implementation, called by both the form and the tests.
- [ ] A sub-threshold schedule still requires an explicit confirmation before it is saved.
- [ ] A save that collides with another window keeps the user's edit.
- [ ] The form is fully usable from the keyboard.
- [ ] Opening an agent and closing it again writes nothing.
