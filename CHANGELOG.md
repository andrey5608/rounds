# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The agent panel** — one surface beside the editor where an agent is read, created, changed and
  deleted, with the schedule's next three runs, the source, the prompt and the recent runs on it.
  The quick-pick wizard is gone: keeping both would have meant two implementations of every
  validation rule.
- **A Connections view** — the hosts agents read from can be listed, corrected and removed, and each
  one now carries its own token instead of sharing one per source kind.
- **Workspace trust** — `runScript` refuses to execute in an untrusted workspace, and an agent that
  depends on it says so before it is due rather than failing at 09:00.
- **`rounds_query`** — a read-only language model tool, so a chat conversation can answer what is
  scheduled, why a run failed, and when an expression fires next.
- **`rounds.notifications`** — `failures`, `all` or `silent`. Silent stops the toasts and nothing
  else.
- Prompt files already in the workspace are offered when choosing one, and an inline prompt is
  written in a real editor document.
- **Bitbucket support**, both the hosted service and self-hosted installations. They share a name and
  almost nothing else — different REST versions, paths, payloads, pagination and timestamp formats —
  so each has its own connector. A repository host connection now records which API it speaks; the
  setup flow asks only when the address does not say, which is the self-hosted case.

### Changed

- An agent stores its project and its repository separately, and the project is labelled the way
  the chosen host labels it: owner, workspace or project key. Schema version 2 migrates what
  version 1 wrote.
- Notifications are one policy with one owner. A schedule shows what it means and its next three
  runs while it is typed, and a run row says how many items it read and how long it took.

### Fixed

- Four agents with fast schedules produced four identical warnings on every window start; they are
  now one message.
- Timestamps from a repository host are normalised to ISO-8601 UTC before they become a cursor. A
  cursor is compared as a string, so a host reporting epoch milliseconds or a non-`Z` offset could
  otherwise skip items or repeat them.
- The extended log now records the full model request, every streamed response part and the collected
  turn, formatted, so "the model returned no text" can be diagnosed from the log instead of guessed
  at. A response part that the editor sends in a shape the API types do not cover is read
  structurally rather than dropped.

## [1.0.0] - 2026-08-17

First release: recurring agents that collect data from an issue tracker or a repository host, send it
through a prompt to a language model, and store the result.

### Added

- **Agents** — a name, a source, a prompt, a model, tools, a schedule and a result folder, created
  and edited from a guided flow in the side panel. Duplicate, enable, disable, delete and run on
  demand from the same place.
- **Two execution modes** — either Rounds calls the model itself, runs the tool-calling loop and
  writes the answer to a Markdown file with front matter, or it opens the prompt in the chat view for
  review and records that the handoff happened without seeing the answer.
- **Sources** — issues matching a search query, and pull requests that were opened or changed since
  the last run. Both work against hosted and self-hosted installations, because the base URL is
  configuration.
- **Tools the model may call** — `readFile`, `listFiles` and `runScript`, each with a permission check.
  Nothing reaches outside the workspace and no command runs unless it is on the user's whitelist.
- **Scheduling** — cron expressions with time zone support, several per agent, plus run-on-startup and
  a policy for occurrences missed while the editor was closed.
- **Rate limit safeguards** — a random delay before each scheduled run, a daily limit per agent and
  overall, a warning for schedules that fire more often than every 30 minutes, optional time windows,
  and sequential rather than parallel runs.
- **Multi-window safety** — one window schedules runs, chosen by a lock with a heartbeat; the others
  stay responsive and can still start a run manually. Claims prevent two windows from running the
  same agent, and a window that crashes leaves nothing blocked.
- **Setup check** — six checks covering model access, both source connections, the result folder, the
  script whitelist and the rate limit settings, each with the action that fixes it.
- **Run history** — per agent, newest first, with the status, the summary, the tool calls and a link
  to the result file. Runs without a file, including chat handoffs, open a detail view instead.
- **An output channel** with configurable verbosity, redacting credentials before anything is written.

### Known limitations

- Agents run only while the editor is open. There is no background service.
- Chat mode cannot capture the model's answer; that is what the mode is.
- No chat participant and no Language Model Tools contribution.
- No sharing of agent configuration between machines or people.
- A manual run cannot deliberately exceed the daily limit; it is skipped like a scheduled one.
