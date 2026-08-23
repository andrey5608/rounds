<img src="docs/media/rounds-lockup.png" alt="Rounds" width="380">

# Rounds — Scheduled Task Agents

A Visual Studio Code extension for **agents**: recurring tasks that collect data from an issue
tracker or a repository host, send it through a prompt to a language model, and store the result as
a Markdown file you can browse from the side panel.

The name refers to making the rounds — agents periodically visit their sources, check what changed,
and report back.

> **Status: in development.** The specification is in [`plan.md`](./plan.md) and the phased build plan
> is in [`docs/`](./docs/README.md). Nothing is published to a marketplace yet.

## Contents

- [Requirements](#requirements)
- [Install and set up](#install-and-set-up)
- [Creating your first agent](#creating-your-first-agent)
- [Execution modes](#execution-modes)
- [⚠️ Agents run only while the editor is open](#-agents-run-only-while-the-editor-is-open)
- [⚠️ Acceptable use and rate limits](#-acceptable-use-and-rate-limits)
- [Settings](#settings)
- [Commands](#commands)
- [Where results are stored](#where-results-are-stored)
- [Data and privacy](#data-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Known limitations in v1](#known-limitations-in-v1)

## Concepts

| Term | Meaning |
| --- | --- |
| agent | a configured recurring task |
| run | one execution of an agent |
| source | optional. Issue tracker or repository host configuration: a connection, and a project plus a repository — owner on GitHub, workspace on Bitbucket Cloud, project key on a self-hosted Bitbucket. An agent without one is a prompt on a schedule |
| tool | a function the model may call during a run |

## Requirements

- Visual Studio Code 1.95 or newer.
- An active Language Model API provider — for example GitHub Copilot — installed and signed in.
  Rounds never talks to a model directly; it asks the editor, which is why no model API key is
  involved anywhere.
- A base URL and an API token for the tracker or repository host you want an agent to read. Issue
  trackers speak the Jira REST API; repository hosts speak the GitHub API (github.com and Enterprise
  Server) or either Bitbucket API (bitbucket.org and self-hosted installations).

## Install and set up

1. Install the extension. The **Rounds** icon appears in the activity bar.
2. Run **Rounds: Check Setup** from the command palette. It reports six checks and each failing one
   offers the action that fixes it:
   - **Language model access** — grant it when the editor asks. This is the only moment a consent
     prompt appears, and it appears because you asked for it.
   - **Issue tracker connection** and **Repository host connection** — enter the base URL, choose how
     the host authenticates, and enter the token. Tokens go into the editor's secret storage, one per
     connection, so two repository hosts never share credentials. A repository host is also asked
     which API it speaks, unless its address already says: github.com and bitbucket.org are
     recognised, a self-hosted installation cannot be. Connections are listed in the **Connections**
     view afterwards, where they can be corrected or removed.
   - **Result folder** — where result files are written; the default is inside the extension's
     storage folder.
   - **Script whitelist** — a warning until you list commands the `runScript` tool may run. An empty
     list means that tool refuses everything, which is the right default.
   - **Rate limit safety** — checks that the delay and daily limit settings are sane.
3. Create an agent with **Rounds: Create Agent**.

## Creating your first agent

**Rounds: Create Agent** asks, in order: a name; whether the result should be captured or the prompt
handed to chat; which source and which connection; the search query or the repository; the prompt;
the model; which tools the agent may use; the schedule; optional per-agent limits and a time window;
and where the results go. The last step lists everything back before anything is stored.

A prompt may use these placeholders:

| Placeholder | Value |
| --- | --- |
| `{{items}}` | every item that was fetched, as a Markdown list |
| `{{issueKey}}` | the id of the current item |
| `{{summary}}` | the title of the current item |
| `{{diff}}` | the diff of the current pull request |
| `{{date}}`, `{{datetime}}` | the local date and time in the agent's time zone |
| `{{workspace}}` | the name of the first workspace folder |

An agent with no source has nothing to fetch, so `{{items}}`, `{{issueKey}}`, `{{summary}}` and
`{{diff}}` are refused when it is saved; `{{date}}`, `{{datetime}}` and `{{workspace}}` still work.
Such an agent runs its prompt once, with whatever its tools find — which is how "every morning,
summarize what changed here" works without a connection to anything.

`{{items}}` describes the whole batch, so the prompt runs once. `{{issueKey}}`, `{{summary}}` and
`{{diff}}` describe one item, so the prompt runs once per item — at most ten per run, so a query
matching forty issues cannot quietly make forty requests. Mixing the two styles is refused when the
agent is saved. Write `\{{items}}` to mention a placeholder without using it.

## Execution modes

| Mode | What happens | Result |
| --- | --- | --- |
| Run and store the result | Rounds calls the model, runs the tool loop and writes the answer | a Markdown file plus a history entry |
| Open the prompt in chat | Rounds fills the chat input and stops there for you to review and send | a history entry only — **the answer is never captured** |

## ⚠️ Agents run only while the editor is open

The scheduler lives in the editor process. There is no background service, so:

- Nothing runs while every window is closed.
- With several windows open, exactly one of them schedules runs. The status bar tooltip says which.
  Closing that window hands scheduling to another within seconds; killing it takes about half a
  minute, until the lock it left behind is treated as abandoned.
- A run that came due while everything was closed follows the agent's missed-run policy: skip it, or
  catch up with a single run — not one per missed occurrence.
- **Run Now** works in any window, whether it schedules or not.

## ⚠️ Acceptable use and rate limits

Automating requests to a language model provider can get your account rate limited or restricted.
For GitHub Copilot, that is governed by the
[GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies)
and the Copilot section of the
[GitHub Terms for Additional Products and Features](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features).
Read them before you schedule anything frequent. **You are responsible for the volume you schedule.**

Rounds ships with these safeguards on by default and they are not meant to be switched off:

- **Jitter** — a random delay of up to `rounds.jitterSeconds` (10 minutes by default) before each
  scheduled run, so runs do not all start on the same second. Manual runs are never delayed.
- **A daily limit** — `rounds.maxExecutionsPerDay` runs per local day across all agents, 24 by
  default, plus an optional lower limit per agent. You are told once per day when it stops a run.
- **A frequency warning** — a schedule that fires more often than `rounds.minimumIntervalWarning`
  minutes needs an explicit confirmation before it is saved, and is flagged in the tree and in
  Check Setup.
- **Time windows** — an agent can be restricted to a range of hours, overnight ranges included.
- **Sequential runs** — due agents run one after another, never several at once.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `rounds.enabled` | `true` | Master switch for scheduled runs. Manual runs still work when off. |
| `rounds.timezone` | system | IANA name used for schedules, daily limits and file names. |
| `rounds.jitterSeconds` | `600` | Upper bound of the random delay before a scheduled run (0–1800). |
| `rounds.maxExecutionsPerDay` | `24` | Runs per local day across all agents. |
| `rounds.minimumIntervalWarning` | `30` | Warn about schedules firing more often than this, in minutes. |
| `rounds.manualRunNextRunPolicy` | `advance` | Whether a manual run leaves the next scheduled run alone or restarts the interval. |
| `rounds.defaultOutputFolder` | extension storage | Where result files go. |
| `rounds.scriptWhitelist` | `[]` | Commands `runScript` may execute. Empty means none — see [below](#allowing-a-command-to-run). |
| `rounds.executionHistoryLimit` | `50` | Runs kept per agent. Result files are never deleted. |
| `rounds.promptFileFallback` | `snapshot` | What a run does when its prompt file cannot be read. |
| `rounds.logLevel` | `info` | Verbosity of the Rounds output channel. |
| `rounds.notifications` | `failures` | How much Rounds may interrupt you: `failures`, `all` or `silent`. A run you start yourself always reports its outcome, and `silent` leaves the output channel, the status bar and the run history untouched. |
| `rounds.maxToolRoundsPerRun` | `30` | How many times the model may ask for tools in one run before the run is stopped and recorded as failed. Raise it for a prompt that genuinely needs many steps. |

## Commands

| Command | What it does |
| --- | --- |
| Rounds: Create Agent | Opens an empty agent form beside the editor |
| Rounds: Edit Agent | Opens an existing agent in the same form |
| Rounds: Duplicate Agent | Copies an agent, disabled, with its own identity |
| Rounds: Delete Agent | Removes an agent and its history; result files are kept |
| Rounds: Enable or Disable Agent | Switches scheduling for one agent |
| Rounds: Run Now | Runs an agent immediately, in any window |
| Rounds: Open Result Folder | Reveals the result folder in the file manager |
| Rounds: Show Agent | Opens one agent on a read-only panel beside the editor: schedule, source, prompt, model, tools and recent runs |
| Rounds: Add Connection | Adds a host an agent can read from, with its own token |
| Rounds: Edit Connection | Corrects a base URL, its authentication or its name, updating the agents that use it |
| Rounds: Delete Connection | Removes a connection and its token, once nothing references it |
| Rounds: Show Run History | Lists an agent's runs; select one to open it |
| Rounds: Check Setup | Runs the six checks and offers to fix what failed |
| Rounds: Refresh | Re-reads the state and repaints the view |
| Rounds: Show Output | Opens the Rounds output channel |

### Allowing a command to run

The `runScript` tool refuses everything until you list what it may run. The quickest way is the
**Allow a command…** button in the agent form, next to the tools — it asks for one command line and
adds it to your user settings. The setting itself takes the same thing as JSON, one entry per
command with the arguments it may be given:

```json
"rounds.scriptWhitelist": [
  { "command": "npm", "args": ["test"] },
  { "command": "npm", "args": ["run", "lint*"] },
  { "command": "git", "args": ["status", "--short"] }
]
```

- Arguments are matched **one for one**. The first entry allows `npm test` and refuses
  `npm test --watch`; add another entry if you want that too.
- A pattern may end with `*` to accept any suffix, so `run lint*` allows both `run lint` and
  `run lint:fix`.
- Omit `args` to allow the command with no arguments at all.
- Commands run directly, never through a shell, and only inside the workspace. `;`, `&&` and pipes are
  ordinary text that matches no pattern, so they cannot be used to chain anything.

### Writing files

A new agent starts with `readFile`, `listFiles` and `writeFile` ticked, since an agent that can
neither look at the workspace nor put anything in it can only ever answer in one message. Untick
what a particular agent has no business doing. `runScript` is never ticked for you.

`writeFile` lets a run produce files instead of putting everything into one answer. It writes UTF-8
text inside the open workspace, creates the folders on the way, and refuses the rest:

- Anything outside the workspace, including a path that reaches out through a symbolic link.
- `.vscode` and `.github/workflows`. Both are executable configuration: a task can be set to run
  when the folder opens, and a workflow runs after a push, which would be a way around the script
  whitelist rather than through it.
- The paths no tool may open at all: `.env`, keys, `.git`, `node_modules`, `.ssh`, `.aws`.
- A file that already exists, unless the call passes `overwrite: true`.
- More than 200 KB in one call, and anything at all in a workspace you have not trusted.

Each file is written beside its target and moved into place, so a run interrupted halfway leaves the
previous file intact. Every write is named in the output channel and in the run's tool calls.

### Tools from other extensions

Besides `readFile`, `listFiles`, `writeFile` and `runScript`, an agent may enable a tool another extension
registered — whatever the editor reports, listed in the agent form under **From this workspace**. A
prompt can then research something before it writes about it.

Read this part before you enable one. Such a tool is somebody else's code: the promise that Rounds
only contacts the base URLs you configured covers the requests Rounds makes, and cannot cover what a
tool does when the model asks it to. So enabling is per agent and explicit, an untrusted workspace
refuses all of them, and a tool that is no longer registered fails the run by name instead of
disappearing from it.

### Skills, slash commands and chat modes

These belong to the chat view, not to the language model API, so which mode an agent runs in
decides whether it can reach them:

| What you want to use | Run and store the result | Open the prompt in chat |
| --- | --- | --- |
| Tools the editor lists (the group above) | yes | yes |
| A skill's instructions | yes, by attaching the skill (below) | yes |
| `/a-command`, `@a-participant`, a custom chat mode | no | yes |

A run in the first mode talks to the model directly. There is no chat view in that conversation, so
there is nothing for a slash to address: an agent told to use `/a-command` gets an answer saying it
was not available, and that answer is correct. The second mode goes through the chat view and
reaches all of it, at the price that mode always charges: Rounds never sees the answer.

### Attaching a skill

A skill is a Markdown file describing a procedure, so a run does not need to call it. Open the
agent, and under **Skills** next to the prompt tick the ones you want. Their instructions are put in
front of the prompt, so the run follows them on whatever it fetched, with the tools you enabled.

Skills are found in any `skills` folder in the workspace — `.github/skills/<name>/SKILL.md`,
`.agents/skills/<name>/SKILL.md` and a flat `skills/<name>.md` all count. Only the skill file
itself is offered: a README, a CHANGELOG or instructions written for a chat agent may sit in the
same folder, and they are support material rather than something to attach.

Each skill is listed by what it calls itself: Rounds reads the `name` and `description` from the
file's own header, and falls back to the folder name when it has none. So the list offers skills
rather than file paths, and you pick a skill by what it does.

If a skill you expect is missing, run **Rounds: Show Output**: the log names every file that was
taken for a skill. A folder hidden by `files.exclude` or `search.exclude` is hidden from this
search too, because it uses the editor's own.

Ticking a skill turns on the tools it needs: whatever its header asks for, plus `readFile` and
`listFiles`, since a procedure about a repository cannot be followed without looking at one. The
boxes move where you can see them. `runScript` is never turned on this way — it runs commands, and
that stays a decision you make yourself.

A skill that is ticked and then deleted fails the run by name rather than running without it,
because running without it would answer a different question than the one you set up.

`.github/copilot-instructions.md` is not read for this. It is prose written for the chat view, and
guessing a list of skills out of somebody's prose would be a list that is wrong in ways nobody can
see. The skill files themselves say what they are.

To see exactly what a run can call, open the agent and look under **From this workspace**: that list
is what the editor reports, and it is what the model is offered. Every run also writes the names it
was given into the log: `Offering 4 tool(s) to the model: …`.

## Where results are stored

The folder is the agent's own, then `rounds.defaultOutputFolder`, then a `results` folder inside the
extension's global storage. Files are named `<agent-name>-<YYYYMMDD-HHmmss>.md` in the agent's time
zone, and each one starts with front matter recording the agent, the model, the mode, the trigger,
the start and finish times, the status, the source items, the tool calls, the skills it followed,
where the prompt came from and whether anything was truncated. The model's answer follows.

Deleting an agent never deletes files it already wrote.

## Data and privacy

- Your prompt and the data an agent collected go to the model through the editor's language model
  API, under your provider's terms.
- Network requests go only to the base URLs you configure. That is enforced in code: a request to any
  other host fails, and redirects are refused rather than followed.
- Tokens live in the editor's secret storage, never in settings, in the state file, in a result file
  or in the log. Log output is redacted before it is written.
- Rounds has no telemetry and no server of its own.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Nothing ever runs | Another window schedules runs (check the status bar tooltip), or `rounds.enabled` is off, or the agent is disabled. |
| "This agent cannot run because …" | Run **Check Setup**; the reason names exactly what is missing. |
| "The model … is not available any more" | The provider no longer offers that model. Edit the agent and pick one from the current list; Rounds never substitutes silently. |
| "The host … could not be reached" | The message says which of the usual reasons it was: a name that did not resolve, a refused port, a timeout, or a certificate this machine does not trust. The output channel carries the full chain underneath it. |
| Requests fail while the same URL opens in a browser | Runs go through the proxy in `HTTPS_PROXY`, `HTTP_PROXY` or their lower-case spellings, and `NO_PROXY` exempts a host from it, the same way `curl` and `git` read them. The editor must be started with those variables set, so on macOS launch it from a terminal rather than from Finder if they come from your shell profile. A failure behind a proxy names the proxy, because the address that could not be reached may be its own. |
| A run failed with a usage limit | The provider is rate limiting. Run agents less often, or lower the daily limit. |
| "The prompt file … could not be read" | The file moved or was deleted. Restore it, point the agent at the new path, or choose a different `rounds.promptFileFallback`. |
| A chat-mode run has no result file | That is the mode: the prompt was opened for review and Rounds never sees the answer. |
| The model says it cannot write files | `writeFile` is off for that agent. Tick it in the agent form; a run only ever has the tools it was given. |
| `runScript` refuses everything | `rounds.scriptWhitelist` is empty. Add the commands you want to allow, with their arguments. |
| Something else | Open **Rounds: Show Output**. Every line, including the ones `rounds.logLevel` hides, is also written to `logs/rounds-<date>.log` inside the extension's storage folder — the output channel prints the full path at startup. Attach that file to a report: it is redacted before anything is written. |

## Asking about agents in chat

Rounds contributes one language model tool, `rounds_query`, so a chat conversation can answer
questions about what is scheduled. Reference it with `#rounds`, or let agent mode pick it up:

- "What does Rounds run tonight?"
- "Why did the triage agent fail?"
- "When does `0 9 * * 1-5` fire next in Europe/Berlin?"

It only reads. Creating, editing, deleting or enabling an agent from chat is out of scope, so the
tool takes no store and has no code path that could write. Tokens never appear in its answers: the
result passes through the same redaction as the log.

## Known limitations in v1

- No chat participant, and no writing to agents from chat: `rounds_query` answers questions, and
  creating or changing an agent happens in the panel and the palette.
- No execution while the editor is closed.
- No sharing of agent configuration between machines or people.
- No model parameters beyond what the editor's language model API accepts.

## Documentation

- [`plan.md`](./plan.md) — product specification and constraints
- [`AGENTS.md`](./AGENTS.md) — working rules for contributors and AI assistants
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — how to add a tool or a connector
- [`docs/implementation-plan.md`](./docs/implementation-plan.md) — phases, milestones, conventions
- [`docs/leftovers.md`](./docs/leftovers.md) — what is not finished, and why

## License

MIT — see [LICENSE](./LICENSE).
