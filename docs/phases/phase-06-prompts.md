# Phase 6 — Prompt resolution and placeholders

**Goal:** deterministic prompt text for every run: inline or file-based with a snapshot,
an explicit fallback policy, validated placeholders, and size limits.

**Depends on:** phases 2 and 5.

## Steps

### 6.1 Prompt resolver (`src/agents/promptResolver.ts`) ✅
- `resolve(agent, ctx): Promise<PromptResolution>` where `PromptResolution` is
  `{ text: string; usedSnapshot: boolean; path?: string; hash?: string }` or a typed
  `PromptUnavailableError`.
- Inline prompts resolve trivially from `prompt.inlineText`.
- File prompts: read `prompt.filePath` (absolute, or workspace-relative resolved against
  the first workspace folder), update the snapshot when the content hash changed, and
  record which path was taken.

### 6.2 Snapshot lifecycle ✅
- Snapshot fields: `content`, `hash` (sha256), `capturedAt`.
- Re-sync on: extension activation, file change events, agent edit, and every successful
  file read during a run.
- Snapshot updates go through the revisioned store like any other agent mutation.
- A `FileSystemWatcher` covers the workspace and the sync only reacts when the changed path
  is actually some agent's prompt file; files outside the workspace are re-read on each run
  and on activation anyway.
- All refreshed snapshots are written in **one** state update rather than one per agent, so a
  window with a dozen file-based agents does not produce a dozen revisions on startup.

### 6.3 Fallback policy (`rounds.promptFileFallback`, per-agent override) ✅

| Policy | File readable | File unreadable, snapshot exists | File unreadable, no snapshot |
| --- | --- | --- | --- |
| `snapshot` | use file | use snapshot, log a warning, mark `usedSnapshot` | fail the run (`prompt.unavailable`) |
| `blockWhenResolvable` | use file | fail the run (`prompt.fileUnreadable`) | fail the run |
| `blockAlways` | use file | fail the run | fail the run |

- "Unreadable" covers: missing, permission denied, empty after trim, or larger than the
  200 000 byte maximum. Deciding that here rather than at the call site means the policy
  applies to an empty or enormous file too, not only to a missing one. The run record always
  states which branch was taken.
- The resolver does not write the snapshot itself: it **returns** a refreshed snapshot when
  the file content changed, and the caller stores it through the revisioned store together
  with the rest of the run's agent update. One write instead of two, and no state change at
  all when the run turns out to be impossible.

### 6.4 Placeholder engine (`src/agents/placeholders.ts`) ✅
Supported placeholders exactly as in `plan.md`:

| Placeholder | Value |
| --- | --- |
| `{{issueKey}}` | current item id (per-item mode) |
| `{{summary}}` | current item title |
| `{{diff}}` | unified diff for the current pull request |
| `{{items}}` | rendered list of all fetched items (Markdown bullets: id, title, url, updatedAt) |
| `{{date}}` | local date, `YYYY-MM-DD`, effective timezone |
| `{{datetime}}` | local date and time, `YYYY-MM-DD HH:mm`, effective timezone |
| `{{workspace}}` | name of the first workspace folder, or `no workspace` |

- Rendering rules: unknown placeholder → `PromptValidationError` listing the supported
  ones (fail fast at save time in the wizard **and** at run time).
- `{{` can be escaped as `\{{`.
- Item-scoped placeholders (`{{issueKey}}`, `{{summary}}`, `{{diff}}`) mean the prompt is
  rendered **once per item**; `{{items}}` means one render for the whole batch. Mixing
  both is rejected at validation time with a clear message.

### 6.5 Placeholder scan drives fetching ✅
`scanPlaceholders` lives in the same module as the renderer, because the scan is what decides
both the rendering mode and what needs fetching; splitting it into its own file would have
separated two halves of one decision.
- `scan(text)` returns the set of placeholders used. The run pipeline uses it to decide
  whether Jira comments/links or PR diffs need to be fetched at all (see step 5.4/5.5).

### 6.6 Size limits and truncation ✅
Implemented first, in `src/agents/truncate.ts`, because the renderer depends on the limits.
- Configurable-in-code constants (documented in `CONTRIBUTING.md`): max prompt characters,
  max diff characters per item, max items rendered by `{{items}}`.
- Truncation appends an explicit English marker,
  e.g. `\n\n[truncated: 41231 of 120004 characters shown]`, and sets a flag recorded in
  the run record. Truncation is never silent: a summary written from half a diff looks exactly
  like one written from all of it, so the cut has to be visible in the text itself.
- A placeholder with no value renders as `(no item)` or `(no diff available)` rather than an
  empty string, for the same reason — a prompt that quietly loses its subject produces
  confident nonsense.

### 6.7 Tests ✅
- Unit: each placeholder, escaping, unknown placeholder error text, item-scoped vs batch
  detection, mixed-mode rejection.
- Unit: full fallback matrix from 6.3 with a stubbed file system and clock.
- Unit: truncation markers and recorded flags.
- Path expectations are asserted by shape — absolute, ending in the expected segments built with
  `node:path` — not as POSIX literals. A resolved path carries the host separator and on Windows a
  drive letter, and comparing against `resolve()` of the same inputs would only restate the
  implementation.
- 37 tests cover this phase: every placeholder including the time zone sensitive ones, the
  escape form, the unknown-placeholder message, per-item versus batch detection, the mixed
  mode rejection, the complete fallback matrix against a stubbed file system and clock, and
  every truncation path.

## Exit criteria

- [x] Every placeholder from `plan.md` renders correctly, including the time zone sensitive
      ones, which are asserted across two zones on the same instant.
- [x] The fallback matrix is fully covered by tests and matches the table above, for all three
      kinds of unreadable file and for the per-agent override.
- [x] Prompt validation fails at save time: `validatePrompt` rejects unknown placeholders and
      mixed modes, and the wizard calls it before an agent can be stored (phase 10).
- [x] Each resolution produces the record the run stores: source, path, snapshot usage, hash.
- [x] Oversized content is truncated with a visible marker at every level: diff, item body,
      item count and the whole prompt.
