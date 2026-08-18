# Phase 22 — Agents with no source

**Goal:** an agent may be a prompt on a schedule. A source is one of the things it can have,
not the reason it exists.

**Depends on:** phases 19 and 20.

Every agent must currently name a connection and a source, because the model says so: `source`
is required on `Agent`, and readiness refuses an agent whose connection has no token. That is
right for "summarize what changed in these pull requests" and wrong for everything else somebody
might want on a timer — a prompt that reads the workspace, runs a command through `runScript`
and writes what it found, with nothing to fetch from anywhere.

Such an agent is not a lesser agent. It leans on the tools instead of on a connector, which is
the same pipeline with one stage removed, and after [phase 21](./phase-21-workspace-tools.md) it
can lean on the tools the workspace itself provides.

## Steps

### 22.1 Change the specification first
- `plan.md` describes the agent model with a source. It gains the sentence that a source is
  optional, and what an agent without one means: no fetch, no connection, no token, one
  rendering of the prompt as written.
- The README's agent table says the same, next to the row that currently describes a source as
  configuration every agent carries.

### 22.2 `source` becomes optional, not a third kind of source
- `Agent.source?: AgentSource` rather than a `{ kind: 'none' }` member of the union.
- The reason is what the compiler does with each. This code base reads a source through
  ternaries — `agent.source.kind === 'jira' ? … : …` — in the tree, the run picker, the form and
  the chat tool. Adding a union member leaves every one of those compiling and silently taking
  the git branch. Making the field optional turns each of them into a compile error until
  somebody decides what an agent with no source shows there. The change is only worth making if
  it is impossible to half-make.
- No schema bump: an absent field reads correctly under version 2, and nothing needs migrating.
  Worth knowing for the other direction, though: an **older build** reading an agent with no
  source will quarantine it, because its validator requires the field. The state file is not
  damaged and the agent returns when the build is current again, which is what the quarantine
  design is for — but it is a downgrade, not a crash, and this is where it is written down.
- `validateSource` keeps its rules and simply is not called when the field is absent.

### 22.3 The run with nothing to fetch
- `runner.ts` skips the fetch, the connector factory and the cursor entirely. It never asks for
  a connection, so a prompt-only agent works in an installation with no connections at all —
  which is the point of the phase.
- `sourceItemCount` stays 0 and means it. The "the source returned nothing to work on" skip must
  not fire: there was no source, so there is nothing to be empty, and recording a skip would be
  a lie about why nothing happened.
- One rendering, always. `scanPlaceholders` decides between per-item and batch rendering today;
  with no items there is one prompt, rendered as written.
- The result file's front matter says the source is a prompt rather than omitting the field:
  a reader who finds no source line cannot tell whether the agent had none or the writer forgot.

### 22.4 The placeholders that stop making sense
- `{{items}}`, `{{issueKey}}`, `{{summary}}` and `{{diff}}` have nothing to render without a
  source. `{{date}}`, `{{datetime}}` and `{{workspace}}` still do.
- `validatePrompt` gains the knowledge of whether a source exists, and rejects the first group by
  name, listing the ones that remain. Rendering a placeholder to an empty string would be worse
  than refusing it: an agent that silently prompts about nothing produces confident text about
  nothing, and nobody reads the prompt again afterwards.
- The form's hint under the prompt lists only the placeholders that apply, so the rule is visible
  before it is enforced.

### 22.5 Readiness, Check Setup and the connections that no longer count
- `evaluateReadiness` asks for a connection and a token only when there is a source. Without one,
  an agent is ready when consent is on record and its model exists — and the workspace-trust rule
  from phase 15 still applies to `runScript`.
- The two connection checks in Check Setup count only agents that have a source, so a setup with
  one prompt-only agent and no connections reports no failure. It has nothing wrong with it.
- Deleting a connection counts referencing agents the same way, or it will refuse a delete on
  behalf of an agent that never used it.

### 22.6 The form and the rest of the interface
- The source select gains "Nothing — just the prompt" as its first option, and choosing it hides
  the connection, project, repository and query fields rather than disabling them. A hidden field
  cannot be half-filled; a disabled one looks like something to argue with.
- The tree row, the run picker and the panel say "prompt only" where they say the repository or
  the query today.
- `rounds_query` reports `source: { kind: "none" }` rather than omitting the key. A model reading
  an absent field cannot tell "no source" from "not included in this view", and the whole point
  of that tool is answers that are true.

### 22.7 Tests
- Unit: an agent with no source validates, survives a store round trip and renders one prompt;
  the item placeholders are rejected with a message naming what remains; readiness ignores
  connections and tokens; Check Setup passes with no connection configured; the run records zero
  items without recording a skip.
- Integration: creating a prompt-only agent through the form leaves no connection fields in the
  document, and the tree row says what it is.

## Exit criteria

- [ ] An agent can be created, saved and run with no connection configured anywhere in the
      installation.
- [ ] Its run fetches nothing, calls no connector, records zero items and is not a skip.
- [ ] A prompt using `{{items}}` or `{{issueKey}}` is refused with a message naming the
      placeholders that still work.
- [ ] Check Setup reports no failure for an installation whose only agent has no source.
- [ ] Deleting a connection is not refused on behalf of an agent that never referenced it.
- [ ] `plan.md` and the README say a source is optional and what an agent without one does.
