# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [1.0.0]

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
