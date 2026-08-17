# Rounds — Scheduled Task Agents

A Visual Studio Code extension for **agents**: recurring tasks that collect data from
Jira or a Git host, send it through a prompt to a language model, and store the result as
a Markdown file you can browse from the side panel.

The name refers to making the rounds — agents periodically visit their sources, check
what changed, and report back.

> **Status: in development.** The specification is in [`plan.md`](./plan.md) and the
> phased implementation plan is in [`docs/`](./docs/README.md). Nothing is published yet.

## Requirements

- Visual Studio Code 1.95 or newer
- An active Language Model API provider, such as GitHub Copilot
- A Jira and/or Git host base URL with an API token

## Concepts

| Term | Meaning |
| --- | --- |
| agent | a configured recurring task |
| run | one execution of an agent |
| source | Jira or Git connector configuration |
| tool | a function the model may call during a run |

## Two execution modes

- `api` — the extension calls the model directly, runs the tool-calling loop, and writes
  the result to a file.
- `chat` — the prompt is handed off to the built-in chat for review. The output is not
  captured; only the handoff is recorded.

## Important caveats

- **Agents run only while Visual Studio Code is open.** The scheduler lives in the editor
  process. Runs missed while the editor was closed follow the agent's missed-run policy.
- **Automating a model provider can get your account rate-limited or restricted.** Rounds
  ships with jitter, a daily execution cap, warnings for schedules that fire more often
  than every 30 minutes, and optional time windows — but you are responsible for the
  volume you schedule. Review your provider's acceptable use policy before enabling
  frequent agents.
- Tokens are stored in the editor's secret storage. Network access is limited to the base
  URLs you configure. There is no telemetry.

## Documentation

- [`plan.md`](./plan.md) — product specification and constraints
- [`docs/implementation-plan.md`](./docs/implementation-plan.md) — phases, milestones,
  conventions
- [`docs/phases/`](./docs/phases/) — step-by-step plan for each phase

## License

MIT
