# Phase 17 — Asking about agents from chat

**Goal:** ask the chat what is scheduled, and get an answer that is true.

**Depends on:** phases 13 and 15.

**Scope decided: read-only.** `plan.md` puts this outside v1 in one line — *"Chat
participant integration and Language Model Tools for managing agents from chat"* — and the
part now taken is the reading half of it. One tool, `rounds_query`, answers questions.
Creating, editing, deleting and enabling agents from chat stay out of scope, and step 17.5
records what taking them would cost, so the question can be reopened with the price visible
rather than re-derived.

## Why read-only, and why that is most of the value

A tool that answers questions cannot break a schedule. A tool that writes has to reimplement
every guard the wizard applies — frequency warning, daily cap, allowed window, model
validity — or it becomes the way around them. Meanwhile the questions people actually ask
need no writes at all: "what runs tonight", "why did the triage agent fail", "when does this
cron next fire".

## Steps

### 17.1 Change the specification first ✅
- Split the out-of-scope line in `plan.md`: chat participants stay out, a read-only
  Language Model Tool comes in, and writing from chat stays out with the reason.
- The same edit lands in `docs/leftovers.md`, whose "out of scope for v1" section repeats
  the line, and in the integration test that asserts the manifest declares no
  `languageModelTools` — that test becomes the opposite assertion: exactly one tool,
  read-only, matching what the code registers.
- `AGENTS.md` points at `plan.md` for scope and needs no rule change of its own.

### 17.2 One tool with a `kind`, not six tools ✅
- `rounds_query` with `kind`: `list`, `get`, `history`, `preview_cron`, `list_models`,
  `list_sources`.
- Each `kind` accepts an explicit set of fields and rejects anything else by name, listing
  what it would have accepted. A model that guesses a field then gets a correction instead
  of silence, which is the difference between one wasted turn and three.
- Failures come back as `{ ok: false, reason, message }` content, not as thrown errors: the
  model can act on a value and cannot act on an exception.

### 17.3 What a tool result may contain ✅
- Never a token. The tool result passes through the same redaction the logger uses — it is
  the same class of output leaving the extension, and a second mechanism would rot.
- Connection names and base URLs may appear; they are configuration, and an answer that
  hides which host an agent reads is not useful.
- Prompt bodies are omitted from list results and returned only by `kind=get`, with the
  preview under its own key so a truncated preview can never be mistaken for the prompt.
- `hint` fields address the model directly where a result is easy to misread.

### 17.4 Registration and gates ✅
- `vscode.lm.registerTool` plus a `languageModelTools` contribution. This does **not** call
  `selectChatModels`, so the consent gate is untouched and `check-consent-gate.mjs` keeps
  passing; add a comment saying so, because the next reader will wonder.
- Registration is unconditional so the tool is visible in the picker and can explain itself,
  but every invocation re-reads state through the store — a tool answering from a stale
  snapshot is worse than no tool.

### 17.5 Write tools — out of scope, and what it would take ✅ (declined, on purpose)
Not in this phase. Kept here so reopening the question costs a read rather than a
rediscovery. If they are ever taken:
- Route every mutation through the same code path the wizard uses, so the guards cannot be
  bypassed. A second creation path is a second set of rules, and the second set is always
  the one that is wrong.
- Require a trusted workspace (phase 15) and confirm destructive actions with the agent's
  name in the prompt.
- Cover the case the guards exist for: creating a one-minute schedule from chat must hit the
  same warning a person hits in the wizard.

### 17.6 Tests ✅
- Unit: every `kind` against a fake store — shapes, the rejection message for an unexpected
  field, prompt bodies absent from lists, a token planted in state absent from every result.
- Integration: the manifest's `languageModelTools` entries match the registered names, the
  way `contributions.unit.test.ts` already pins commands and settings.
- Done: 13 unit tests, including one that plants a token in the state and asserts it cannot come
  back out, and a manifest test that now asserts exactly one tool whose description says it never
  writes — the same test that used to assert no tool at all.

## Exit criteria

- [x] `plan.md` and `docs/leftovers.md` say a read-only tool is in scope and writing from chat
      is not.
- [x] `rounds_query` answers the six kinds from live state, and rejects unknown fields by name.
- [x] No tool result can contain a token, proven by a test that plants one in the state.
- [x] The consent gate is untouched: `check-consent-gate.mjs` still reports one model call site.
- [x] The manifest declares exactly one tool, and no code path in it writes to the store —
      `runQuery` takes a state snapshot rather than the store, so writing is not something it
      chooses not to do, it is something it cannot do.
