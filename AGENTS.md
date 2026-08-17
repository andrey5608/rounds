# Working rules for AI assistants in this repository

These rules apply to every AI coding assistant working here (Claude Code, Copilot, and
any other). They are derived from [`plan.md`](./plan.md), which is the specification and
always wins in case of conflict. The phased build plan is in [`docs/`](./docs/README.md).

This file is the single source of truth. `CLAUDE.md` and
`.github/copilot-instructions.md` only point at it — put new rules here, never there.

## Project in one line

**Rounds** is a Visual Studio Code extension for *agents*: recurring tasks that pull data
from Jira or a Git host, run a prompt through a language model, and store the result.

## Language

- **DO** write everything in the repository in English: code, comments, UI strings, error
  messages, commit messages, docs, tests.
- **DO** reply to the user in Russian in chat — that is conversation, not repository
  content.
- **DON'T** leave any non-English text in tracked files.

## Naming and identifiers

- **DO** copy identifiers verbatim from `plan.md`: the `rounds.` prefixes, the 11 command
  ids, the 11 setting keys, view ids, `globalState` keys, `secrets` keys.
- **DO** keep `"publisher": "TODO-PUBLISHER"` until the owner supplies a real one.
- **DON'T** invent new command ids, setting keys or alternative names. If something is
  missing from the spec, ask instead of guessing.
- **DON'T** put `Copilot`, `GitHub`, `Jira`, `Atlassian`, `VS Code` or `Visual Studio` in
  the extension name, `displayName`, command titles, view titles or setting keys. They may
  appear only in prose (README, descriptions, error messages) and only descriptively.

## Vocabulary

- **DO** use: *agent* (a configured recurring task), *run* (one execution), *source*
  (Jira or Git configuration), *tool* (a function the model may call).
- **DON'T** use *job*, *task* or *cron job* as user-facing nouns.

## Architecture constraints (non-negotiable)

- **DO** access models only through `vscode.lm` or the built-in chat commands.
- **DON'T** add a third-party LLM SDK, call a model provider over HTTP directly, or
  introduce a model API key.
- **DO** limit network calls to the user-configured Jira base URL and Git host base URL,
  enforced by the host allowlist in `src/connectors/http.ts`.
- **DO** store tokens only in `context.secrets`. **DON'T** put them in `globalState`,
  settings, agent config, logs, errors or result files.
- **DO** call `vscode.lm.selectChatModels` from exactly one place — the consent gate — and
  only from user-initiated actions.
- **DON'T** call it from `activate()` or from a scheduler tick.
- **DO** fail a run explicitly when the stored `modelId` no longer exists, listing the
  valid ids. **DON'T** silently substitute another model.
- **DO** keep the layering: `ui` → `agents`/`scheduler` → `model`/`connectors`/`tools` →
  `state`. Nothing imports upward.
- **DO** route every state write through the revisioned store, and reload-and-retry on
  conflict. **DON'T** overwrite a newer revision.
- **DO** keep runs from throwing outward: a failure becomes a recorded failed run with a
  typed code and an English message.

## Safety features that must stay

Jitter, the daily execution cap, the sub-30-minute schedule warning, allowed time windows,
and the leader lock that keeps a single window ticking. **DON'T** remove, weaken or
bypass any of them for convenience.

## Scope

- **DO** stay inside the v1 scope defined in `plan.md`.
- **DON'T** build the out-of-scope items: chat participant integration, Language Model
  Tools contributions, execution while the editor is closed, team sync of agent configs.
- **DON'T** widen the requested task on your own. Ask when a change looks like it needs
  more than what was asked.

## Dependencies

- **DO** keep runtime dependencies minimal: `cron-parser`, `cronstrue`, `proper-lockfile`.
- **DON'T** add a runtime dependency without noting the reason in `CONTRIBUTING.md`.

## Git

- **DON'T** add `Co-Authored-By` trailers, "Generated with" footers, or any other AI
  attribution to commit messages or pull request bodies.
- **DO** write commit messages in English: a short imperative subject, then a body
  explaining why when it is not obvious.
- **DO** work on a feature branch. **DON'T** commit directly to `main`.
- **DON'T** commit or push unless the user asks for it.

## Documentation

- **DO** update [`docs/implementation-plan.md`](./docs/implementation-plan.md) and the
  relevant phase file in the same commit whenever a step changes in reality.
- **DO** keep the README warnings intact: agents run only while the editor is open, and
  automating a model provider can get an account rate-limited.

## Testing

- **DO** add tests in the same phase as the code: pure logic as unit tests without the
  extension host, `vscode`-touching code as integration tests.
- **DON'T** perform real network calls in tests; use fixtures.
- **DON'T** report a phase as done while its exit criteria in `docs/phases/` are unmet.
