# Phase 16 — Prompt authoring and chat-mode parity

**Goal:** writing a prompt stops being the worst step in the wizard, and a chat-mode agent
opens the chat the way the agent was configured.

**Depends on:** phase 13.

Two gaps a real setup exposes. A prompt is written in a single-line input box, and prompt
files that already exist in the repository have to be hunted for through an OS dialog.
Meanwhile chat mode hands over `query` and nothing else, so an agent pinned to one model
opens a chat still using whatever model was picked last.

## Steps

### 16.1 Prompt files the workspace already has
- Before the file dialog, offer what is there: `*.prompt.md` under `.github/prompts/` in
  every workspace folder, then Markdown files near the workspace root, each shown with its
  path relative to the folder and the first line of its content as the description.
- Keep **Browse…** as the last entry, which is today's dialog unchanged — discovery is an
  accelerator, not a cage.
- Discovery is a pure function over an injected file finder (`FileFinder` from phase 7
  already exists), so ordering, filtering and the relative paths are unit-tested without a
  workspace, on `node:path` joins rather than POSIX literals.

### 16.2 Write a prompt in an editor, not in a text field
- Phase 10 specified a scratch editor document for inline prompts; the implementation is a
  one-line `showInputBox`, which is where a fifteen-line prompt goes to die.
- Open an untitled Markdown document seeded with the current text and the placeholder list
  as a comment, and take its content when it closes. The wizard waits on the document, not
  on a keystroke.
- Placeholder validation stays where it is; it runs on the captured text, and a rejection
  reopens the document with the text intact rather than discarding it.

### 16.3 Chat mode opens with the agent's model
- `handOffToChat` passes the agent's `modelId` alongside `query` and `isPartialQuery`.
- These extra options are **best-effort**: `workbench.action.chat.open` is a built-in
  command whose option shape is not part of the published API surface, so an editor build
  that does not know a field ignores it. One retry without the extra fields, then the plain
  call — never an error shown to the user, because the handoff itself succeeded.
- The run record states which model was requested, so the history does not imply Rounds
  knows which model actually answered. It does not: chat mode captures nothing, and that
  sentence stays everywhere it already appears.
- Custom chat modes are deliberately **not** taken: they would add an agent field, a picker,
  and a dependency on a shape that is not API. The model is the part people actually pin.

### 16.4 Tests
- Unit: discovery ordering and relative paths against a fake finder, including a workspace
  with no prompt files and one with several folders; the retry logic of the handoff around
  an injected command runner that rejects the first shape.
- Integration: choosing a discovered file stores an absolute path that the prompt resolver
  can read back.

## Exit criteria

- [ ] The prompt step lists the prompt files already in the workspace, and Browse… is still
      available.
- [ ] An inline prompt is written in a real editor document, and a validation failure does not
      lose the text.
- [ ] Chat mode requests the agent's model, retries once without the extra options, and never
      turns an ignored option into a visible error.
- [ ] Nothing in the UI or the history suggests Rounds saw a chat-mode answer.
