# Phase 8 — Execution engine and results

**Goal:** one agent runs end-to-end on demand — dependencies validated, source fetched,
prompt resolved, model called through the agentic loop (or handed off to chat), result
file written, history recorded. Milestone **M2**.

**Depends on:** phases 4, 5, 6, 7.

## Steps

### 8.1 Run context and pipeline (`src/agents/runner.ts`) ✅
```
validate → claim → fetch source → resolve prompt → dispatch(mode) → write result → record
```
- `RunContext`: `{ runId, agent, trigger, startedAt, clock, logger, cancellation }`.
- The pipeline **never throws outward**. Every stage failure is converted into a failed
  `RunRecord` with a typed code and an English reason, then persisted.
- Cancellation: a `CancellationTokenSource` per run, cancelled on window shutdown, on
  agent disable, and on an overall run timeout (default 15 minutes).
- The claim from step 3.4 is taken before any expensive work and released in `finally`.
- A prompt written around `{{issueKey}}` is rendered once per item, which means one model request
  per item. That is capped at 10 per run (`MAX_ITEM_PROMPTS`): a query matching forty issues would
  otherwise quietly make forty requests. The results are written as one file with a section per
  item.
- Typed failures keep their own code and message; only unrecognised errors go through the model
  error mapping. A test caught the alternative: routing everything through it reported a missing
  prompt file as "the model is not available", purely because the error class name contains the
  word "unavailable".

### 8.2 Dependency validation (step `validate`) ✅
Per `plan.md`, each agent validates its own dependencies before running:
consent granted, `modelId` still resolvable, required secret present, source config
valid, output folder writable, daily caps not exhausted, allowed time window (phase 9).
A failure records a `skipped` or `failed` run with the specific reason — never a throw.

### 8.3 `api` mode: model resolution
- Resolve the model by the stored `modelId` through the catalog. If that exact model is
  gone: fail the run with `model.unavailable` and a message listing the valid ids and
  telling the user to re-select. **No silent substitution, ever.**
- Build the request: a system-style preamble describing the agent, then the resolved
  prompt as a `LanguageModelChatMessage.User` message.

### 8.4 `api` mode: agentic loop (`src/model/loop.ts`) ✅
```
1. sendRequest(messages, { tools, toolMode }, token)
2. stream parts:
   - text part      → append to the answer buffer
   - tool call part → collect
3. if tool calls collected:
     execute each via the registry (respecting permission results)
     append the assistant message with the tool calls
     append a User message with LanguageModelToolResultPart per call
     iteration += 1; if iteration > 10 → fail with `model.iterationCap`
     go to 1
   else → final answer is the buffered text
```
- Tool results are size-capped (reuse phase 6 truncation) before being fed back.
- Every iteration is logged at `debug` with call names and durations.
- `LanguageModelError` is mapped through the phase 4 table and ends the run with the
  mapped code.

### 8.5 `chat` mode handoff (`src/model/chatHandoff.ts`) ✅
- `vscode.commands.executeCommand('workbench.action.chat.open', { query, mode,
  isPartialQuery: true })` — `isPartialQuery: true` gives the review-before-send flow.
- The extension cannot capture the output. Record a run with status `handedOff`,
  `resultFilePath: undefined`, and a summary saying the prompt was opened in chat for
  review. The UI must state this limitation wherever chat-mode runs are shown.
- Chat mode still counts against the daily cap and still respects jitter and windows. When a
  per-item prompt produced several renders, only the first is opened and the run record says so —
  filling the chat input with ten prompts would help nobody.

### 8.6 Result writer (`src/agents/resultWriter.ts`) ✅
- Path: `<outputFolder>/<agent-name-slug>-<YYYYMMDD-HHmmss>.md`, timestamp in the
  effective timezone; slug is lowercase ASCII, non-alphanumerics collapsed to `-`,
  trimmed to 60 characters; on collision append `-2`, `-3`, …
- Output folder resolution: `agent.outputFolder` → `rounds.defaultOutputFolder` →
  `<globalStorageUri>/results`. Created recursively if missing.
- Front matter (YAML) exactly covering the fields from `plan.md`:
  ```yaml
  ---
  agent: <name>
  agentId: <id>
  model: <modelId>
  mode: api | chat
  trigger: schedule | manual | startup | missedRun
  startedAt: <ISO UTC>
  finishedAt: <ISO UTC>
  status: succeeded | failed | skipped | handedOff
  sourceItems: [<id>, ...]
  toolCalls: [{ name, allowed, durationMs }]
  promptSource: inline | file
  promptFile: <path>
  usedPromptSnapshot: true | false
  truncated: true | false
  ---
  ```
- Then the model output verbatim. Failed runs still write a file when any output exists;
  otherwise the error goes to history only.
- Writes use the same temp-file-and-rename strategy as the state store.

### 8.7 History recording ✅
- One `RunRecord` per run, appended through the phase 2 history store (respecting the
  cap), including a one-line summary: first non-empty line of the model output, trimmed
  to 120 characters, or the error message for failures.
- Source cursors (`sinceCursor`) advance only on `succeeded`.

### 8.8 Testability seam
- All `vscode.lm` usage sits behind `interface LanguageModelGateway` implemented once for
  real and once as a fake that replays scripted responses (text, tool calls, errors).
  The loop, the writer and the pipeline are then unit-testable without an extension host.

### 8.9 Wire up `rounds.runNow` ✅
- Replace the phase 1 stub: pick an agent (argument from the tree, or QuickPick),
  run through the pipeline with `trigger: 'manual'`, show progress in the status bar,
  and offer `Open Result` / `Show Output` in the completion notification.

### 8.10 Tests ✅
- Unit: loop with 0, 1, 3 tool-call rounds; iteration cap; tool denial fed back; model
  error mapping; cancellation mid-stream.
- Unit: result file naming, slugging, collisions, front matter fields, folder fallback.
- Unit: failed run always yields a history record.
- Integration: `rounds.runNow` against fakes writes a real file into a temp folder.

## Exit criteria

- [x] A run produces a result file with correct front matter and a history record, for both an
      issue-tracker agent and a repository agent, with fake connectors and a fake model. The
      command that starts it is wired to the same pipeline.
- [x] A missing `modelId` fails the run with the list of valid ids and no substitution.
- [x] The tool loop terminates at the iteration cap with an explicit failure reason.
- [x] Chat mode opens the chat with a partial query and records a `handedOff` run that says the
      output was not captured.
- [x] No pipeline stage can throw out of `run()`: failures injected into the source and the model
      both come back as recorded failed runs, and a result file that cannot be written leaves the
      run recorded as succeeded without a path.
