# Phase 19 — Sources as project and repository

**Goal:** an agent points at a project and a repository the host actually has, chosen from a
list, instead of at a string somebody typed in the shape `owner/name`.

**Depends on:** phases 5 and 18.

`GitSource.repo` is one string holding two things, and the word the wizard uses for the
first half — owner — is right for one provider out of three. Bitbucket Cloud calls it a
workspace, self-hosted Bitbucket calls it a project key, and a personal Bitbucket project is
written `~user`. A person who types the right value for their host still has to guess the
shape Rounds wants. On the tracker side there is no project at all: an agent carries raw JQL
and nothing knows which project it reads.

## Steps

### 19.1 Schema version 2 ✅
- `GitSource` becomes `{ project, repo, mode, sinceCursor? }`; `JiraSource` gains an
  optional `project`.
- `migrate()` in `src/state/validate.ts` already has the hook and the comment saying to add
  one block per schema change. The block splits `repo` on its single slash. A value that
  does not split was never valid — `parseRepo` rejected it at run time — so it is
  quarantined with a reason rather than guessed at.
- `CURRENT_SCHEMA_VERSION` becomes 2, and a state written by version 2 must still be read by
  the validators without the migration running twice.

### 19.2 Each provider's own word ✅
- One function returns the vocabulary for a provider: `github` → Owner, `bitbucketCloud` →
  Workspace, `bitbucketServer` → Project key. The wizard, the panel, the tooltip and the
  validation message all use it, so the field is labelled the way the host's own
  documentation labels it.
- The provider comes from the connection (phase 5's `resolveProvider`), so choosing a
  connection is what decides the wording. Changing the connection re-labels the fields and
  clears a project that no longer means anything.
- `~user` stays valid for self-hosted Bitbucket, and the validator says so in its message
  instead of rejecting a form the API accepts.
- Done as `sourceVocabulary` in `src/agents/sourceLabels.ts`, with `validateProject` taking the
  provider so the message uses the host's word. `validateRepo` now rejects a slash and says the
  other half is a separate field — that is the shape somebody types out of habit.
- The token question in the wizard also became per connection here: "the git token exists" stopped
  being an answer to "can this connection authenticate" in phase 18.

### 19.3 Connectors take the pair ✅
- `ListPullRequestsRequest` carries `project` and `repo` separately. Every connector already
  splits the string as its first act, so this removes code rather than adding it.
- `parseRepo` survives for exactly one caller: the migration in 19.1.
- The item shape does not change. `extra.repo` keeps carrying `project/repo` joined, so no
  prompt that already works starts producing something different.
- Done. `getDiff` takes the pair too, and each connector encodes both halves into its path, so a
  value containing a slash cannot become two path segments — a test pins that, replacing the
  three that used to assert `parseRepo` rejected a one-part string.

### 19.4 Choosing from a list ✅
- New port methods: `listProjects()` and `listRepositories(project)` on the repository host
  connector, `listProjects()` on the issue tracker.
  - GitHub: the viewer's own repositories and organizations.
  - Bitbucket Cloud: workspaces, then the repositories of one.
  - Self-hosted Bitbucket: projects, then repositories of a project.
  - Jira: projects.
- Every one of them paginates, and every one can be refused by the host's permissions.
  A refusal is not a dead end: the picker falls back to a text field with the label from
  19.2, and says why the list is empty. On a locked-down self-hosted installation that is
  the normal path, not the exception.
- Listing is only ever triggered by a person opening the picker — never during a run, and
  never on activation. The fake connectors in the runner tests reject both calls, so a run that
  started listing would fail loudly rather than quietly costing requests.
- Done. GitHub falls back from `/orgs/<name>/repos` to the viewer's own repositories, because
  that path is a 404 for a personal account and that is not an error worth showing somebody who
  is picking from a list.

### 19.5 The tracker's project does not rewrite anybody's query ✅
- `jql` stays authoritative. `project` is used to offer a starting query when the field is
  empty (`project = KEY ORDER BY updated DESC`) and to show which project an agent reads.
- Rewriting a query somebody wrote, to keep it consistent with a dropdown, is how an agent
  silently starts reading something else.
- Done: picking a project seeds an empty query with `project = KEY ORDER BY updated DESC` and
  touches nothing that is already there. The field itself is optional.

### 19.6 What has to move with the model ✅
- `validateSource`, the draft conversion in `src/ui/wizard/steps.ts`, the wizard's repo
  step, the tree tooltip, the run picker detail line and `runner.ts` all read
  `source.repo` today; each of them takes the pair.
- The cursor rule from phase 6 still applies: changing the project or the repository drops
  `sinceCursor`, because the new source never showed the items the old cursor covers.

### 19.7 Tests ✅
- Unit: the migration over a real v1 state, including the value that cannot be split; the
  vocabulary function for all three providers; each connector's listing against recorded
  fixtures, including a second page and a `403`; the cursor is dropped when either half of
  the source changes.
- Integration: a v1 state file on disk opens without data loss and its agents still run.

## Exit criteria

- [x] An agent stores its project and its repository separately, and an installation written by
      schema version 1 migrates without losing an agent.
- [x] The fields are labelled with the provider's own word, decided by the connection.
- [x] Projects and repositories can be picked from the host, and a host that refuses to list them
      leaves typing available with the reason shown.
- [x] Nothing calls a listing endpoint during a scheduled run.
- [x] Changing either half of the source clears the cursor.
