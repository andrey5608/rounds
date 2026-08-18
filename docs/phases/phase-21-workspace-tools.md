# Phase 21 — Tools the workspace already has

**Goal:** an agent may use the language model tools other extensions registered, so a prompt
can research before it summarizes.

**Depends on:** phases 7, 15 and 20.

The agentic loop was built for this and only ever knew about three tools, all ours.
`vscode.lm.tools` lists every tool any extension registered — name, description, input schema,
tags — and `lm.invokeTool` is documented as callable "globally by any extension in any custom
flow", passing `toolInvocationToken: undefined` outside a chat request. So what a workspace can
do is reachable without a chat participant, and the agent that reads Jira every morning can
research an issue before writing about it.

## What is reachable, and what is not

Worth writing down before the code, because "use the workspace's skills" promises more than the
API delivers, and a promise that quietly means "some of them" is worse than a narrow one:

- **Reachable:** anything in `vscode.lm.tools`. That is what other extensions contribute through
  `languageModelTools` — the same contribution point phase 17 used for `rounds_query`.
- **Not reachable:** custom chat modes, `/slash` commands and `@participant` invocations. Those
  are constructs of the chat UI, not of `vscode.lm`; `sendRequest` does not pass through it.
  Skill folders that a chat agent loads are the same story.
- Chat mode (the agent's other execution mode) *can* reach all of it — a query beginning with
  `/research` resolves in the chat view — and equally cannot report the answer back. That trade
  is the definition of that mode and does not change here.

## Steps

### 21.1 Change the specification first ✅
- `plan.md` lists three v1 tools and says adding one means registering an object in the registry.
  It gains a second sentence: a tool the editor reports may be enabled per agent, subject to the
  gates in 21.4.
- The README gains the same, next to the tool list, including the part nobody else will say: an
  external tool is somebody else's code and may talk to hosts this extension never contacts. The
  guarantee about network access covers what is in `src/connectors/`, not what a third-party tool
  does when the model asks it to.
- Done. The README also says what is *not* reachable — chat modes, slash commands, participants —
  next to what is, because that is the sentence somebody needs before they go looking for it.

### 21.2 A second source for the registry ✅
- `src/tools/externalTools.ts`, free of `vscode`: turns a tool's reported information into the
  same `ToolDefinition` shape the registry already holds, given an `invoke` port. Pure, so the
  mapping, the truncation and the denials are unit tests.
- `src/tools/vscodeLmTools.ts`, the thin edge: reads `vscode.lm.tools` and calls
  `vscode.lm.invokeTool`, the way `vscodeFileFinder.ts` is the edge for file search.
- The list is read when a run starts, not cached at activation. Extensions come and go, and a
  stale list offers the model a tool that is no longer there.
- A reported tool whose name collides with `readFile`, `listFiles` or `runScript` does not
  replace ours. Ours are the ones with a permission check written against this extension's
  promises, and silently swapping them is how a whitelist stops meaning anything.
- Done. The adapter produces an ordinary `RoundsTool`, so the registry's denials, audit record and
  result handling apply unchanged — which is the reason this is an adapter and not a second
  execution path. The result reader has the same structural fallback as the model gateway: a text
  part from another copy of the API types is text in every way that matters.

### 21.3 Only what the agent enabled, and only what a run can answer for ✅
- The model sees exactly the tools the request declares, and the agent's stored `tools` list
  already decides that. An external tool is stored the same way, by name.
- A name that is no longer registered **fails the run** with a typed code naming the tool. This
  is the rule the specification already applies to a vanished `modelId`: never silently drop,
  never silently substitute.
- `invokeTool` shows a confirmation dialog for tools that ask for one, even outside chat, and a
  scheduled run has nobody to answer it. `LanguageModelToolInformation` does not say in advance
  which tools those are, so the invocation is wrapped in the same cancellable deadline the model
  request uses: no answer in time means a denial fed back to the model — "the tool did not
  answer; it may be waiting for a confirmation nobody is there to give" — rather than a run that
  hangs until the window closes.
- A tool that needs the chat context rejects the call, because the token is `undefined` outside
  chat. That is caught and fed back as a denial too. The loop already knows how to carry on from
  one; that is what denials were built for in phase 7.
- Done. `createRunRegistry` builds the run's registry from the built-ins plus what the editor
  reports at that moment, and the runner checks the agent's tool names against it before the first
  request rather than discovering a gap halfway through a conversation.

### 21.4 The gates ✅
- **Workspace trust** (phase 15): an untrusted workspace refuses every external tool, in the same
  shape and with the same wording as `runScript`'s denial. Third-party code with unknown reach is
  exactly what trust exists for.
- Every invocation is logged like `runScript` is — the tool name and the size of the input, never
  the input itself, which may carry issue text.
- The result is truncated by the same rule as our own tool results, and only its text parts are
  read: a `prompt-tsx` part is a shape this extension does not render, and the model is told
  something was left out rather than quietly receiving less than the tool sent.
- Done in the adapter, so the trust gate reads as a permission check like `runScript`'s and lands
  in the audit trail the same way.

### 21.5 Prompt files stop leaking their front matter
- A `.prompt.md` file carries YAML: `description`, `mode`, `model`, `tools`. Today the whole
  file is sent as the prompt, header included, so the model reads a header meant for the editor.
  That is a defect on its own and the reason this step is in this phase rather than its own.
- Parse it, strip it from the text, and use what maps: `tools` preselects, `description` labels
  the entry in the picker from phase 16, and `model` is a **suggestion** used only when the agent
  has none. It never overrides the stored `modelId` — a run fails rather than substituting a
  model, and a file quietly changing which model runs would be the same sin by another route.
- `mode` is ignored, with the reason in the code: chat modes are not reachable from `vscode.lm`.
- No YAML dependency. This is a header of `key: value` lines and one short list; the runtime
  dependency list is three packages on purpose, and `check-dependencies` is what keeps it there.

### 21.6 The form says what is available and what is missing
- The tools section grows a second group, "From this workspace", listing what the editor reports
  now, with each tool's description and tags.
- A tool the agent enabled that nothing currently registers is shown in place, marked missing,
  rather than disappearing from the form — the run will fail on it, and a form that hides the
  cause is a form that makes the failure a mystery.

### 21.7 Tests
- Unit: information mapped to a definition; the deadline denial; the missing-chat-token denial;
  an enabled tool that is not registered fails with its own code; a collision with a built-in
  name is refused; the front-matter parser — header stripped, `tools` read, `model` suggested and
  not forced, a file with no header, CRLF line endings.
- Integration: a tool registered inside the test host appears in what a run would offer, which is
  the part that proves the list is read at run time rather than at activation.

## Exit criteria

- [ ] `plan.md` and the README say external tools may be enabled, and say plainly that such a tool
      is third-party code whose network access this extension does not constrain.
- [ ] An agent can enable a tool another extension registered, and the model calls it during a run.
- [ ] A tool that asks for confirmation, or needs a chat context, produces a denial the model can
      act on — never a run that hangs and never an exception out of the pipeline.
- [ ] An enabled tool that is no longer registered fails the run with a typed code naming it.
- [ ] An untrusted workspace refuses every external tool.
- [ ] A `.prompt.md` file's front matter never reaches the model, and never changes the agent's
      stored model.
