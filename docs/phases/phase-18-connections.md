# Phase 18 — Connections managed from the view

**Goal:** a connection is a thing you can see, add, change and remove, with its own token.

**Depends on:** phase 13.

Connections are the least finished part of the extension. `addConnection` is reachable only
from inside Check Setup or in the middle of the agent wizard, `removeEndpoint` exists in
`src/setup/endpointEditor.ts` and is called from nowhere, and nothing edits a connection at
all: a mistyped base URL means deleting the agent that uses it or editing the state file by
hand. Phase 5 then made this worse in a way worth naming — with GitHub, Bitbucket Cloud and
self-hosted Bitbucket all supported, two repository connections **share one token**, because
`SECRET_KEYS` has exactly one key per source kind.

## Steps

### 18.1 A second view, not a second kind of row in the first ✅
- `rounds.connectionsView`, titled `Connections`, in the existing activity bar container,
  under the agents view.
- The alternative — group nodes inside the agents tree — keeps the manifest smaller and
  makes both halves worse: an agent and a connection have nothing in common except that
  they are configuration, and a tree that mixes them has to explain itself in every row.
- **Specification change.** `plan.md` fixes one view id. Amend it, `package.json`
  (`contributes.views`, plus a `viewsWelcome` entry for the empty case that points at
  `rounds.addConnection`), and the README.

### 18.2 What a row says ✅
- Label: the connection name. Description: host and provider — `github.com · GitHub`,
  `bitbucket.example.com · Bitbucket, self-hosted`.
- Icon by kind: issue tracker and repository host are different things and should not need
  reading to tell apart.
- Tooltip: base URL, resolved API root (the value `resolveApiRoot` produces, which is what
  a request actually uses), auth scheme, user name for basic auth, whether a token is
  stored, and the result of the last reachability check.
- **Never the token, not even masked.** A masked token still leaks its length, and there is
  no question a person can answer by looking at one.
- The tooltip names the **resolved API root** rather than only the base URL: that is the value a
  request actually uses, and a base URL pointing at the wrong place shows up there first.

### 18.3 Three commands ✅
- `rounds.addConnection` in the view title, `rounds.editConnection` and
  `rounds.deleteConnection` inline on the row.
- **Specification change.** The command list in `plan.md` grows by these three ids; they go
  into `package.json`, the menus with a `viewItem` clause of their own, and the README
  command table. `contributions.unit.test.ts` compares the manifest with the code, so the
  three have to land together.
- Editing reuses the input sequence that already exists in `endpointEditor.ts` — base URL,
  auth scheme, user name, provider, name — seeded with the current values. A field left
  unchanged stays unchanged; this is an edit, not a re-creation.

### 18.4 One token per connection ✅
- Add `secretRef` to `EndpointConfig`: a short opaque id generated when the connection is
  created. The token lives at `rounds.secret.connection.<secretRef>`.
- Keyed on `secretRef` rather than on the name, so renaming a connection moves nothing:
  a rename that has to move a secret is a rename that can half-fail.
- **Specification change.** `plan.md` lists two secret keys. It gains the per-connection
  form; the two old keys stay listed as the migration source.
- Migration, once, at first read: for each existing connection, copy `jiraToken` or
  `gitToken` into its own key. The old keys are read as a fallback for one release and
  deleted only after a connection has a key of its own — a token that vanishes because a
  migration ran in the wrong window is unrecoverable, since nobody keeps a copy.
- `SECRET_BY_KIND` stays in `factory.ts` as the fallback path and nothing else reads it to
  decide where a token goes; `tokenFor(secrets, endpoint)` is the one place that answers that.
- Done. The migration runs once at activation, is additive, and is safe to run twice or in two
  windows: it assigns a reference, copies the shared token under it, and skips a connection that
  already has one. A test holds the defect this exists for — two repository connections holding
  different tokens.

### 18.5 Renaming, when agents point at the name ✅
- Agents reference a connection through `source.baseUrlRef`, which is its name. A rename
  therefore rewrites every referencing agent in the same store update — one revisioned
  write, so the two can never disagree.
- Refuse a name that another connection already has, with the same validator the wizard
  uses for agent names.

### 18.6 Deleting ✅
- Name the agents that use the connection and refuse while any of them does. Silently
  breaking three agents to satisfy one delete is not a trade a person asked for.
- When nothing references it: delete the connection and its token together. This is the
  opposite of the agent rule in phase 10, and for the same reason — there the token was
  shared, here it belongs to exactly this connection.
- Modal confirmation naming the connection and stating that the token is removed with it.

### 18.7 Checking a connection from its row ✅
- The edit flow ends with a reachability check through `ConnectorFactory.ping`, whose
  result is stored on the connection (`lastCheck`) and shown in the tooltip until the next one.
- `ping` already reports instead of throwing, and the message already avoids the token —
  both were built in phase 5 for Check Setup and neither needs changing here.

### 18.8 Check Setup keeps its six checks
- The tracker and repository checks report per connection instead of per kind: three
  connections, three lines under the same two checks.
- The fix action on a failing line opens that connection's edit flow rather than the
  add flow, which is what somebody with a typo in a base URL actually needs.

### 18.9 Tests
- Unit: the secret migration (a connection with a token, one without, a second window
  running it twice); rename rewrites referencing agents; delete is refused while referenced;
  the row's description and tooltip contain no token when one is stored.
- Integration: the view is declared and welcomes an empty state; the three commands appear
  in the manifest with menu clauses that key on context values the view produces.

## Exit criteria

- [ ] Connections are listed, added, edited and deleted from the view, with no path through
      Check Setup or the agent wizard required.
- [ ] A GitHub connection and a Bitbucket connection each hold their own token, and an existing
      installation keeps working across the migration without re-entering either.
- [ ] Renaming a connection keeps every agent that used it working.
- [ ] Deleting is refused while an agent references the connection, and removes the token when
      it is not.
- [ ] No token, masked or otherwise, appears in a row, a tooltip, a log line or an error.
- [ ] `plan.md`, `package.json` and the README agree on the new view, the three commands and the
      per-connection secret key.
