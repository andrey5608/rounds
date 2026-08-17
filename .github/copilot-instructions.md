# Copilot instructions

The working rules for this repository live in [`AGENTS.md`](../AGENTS.md) at the
repository root. Read that file in full and follow it — it is the single source of truth
for AI assistants here, and it applies to Copilot exactly as it does to any other
assistant.

Quick reminders of the rules that are easiest to break:

- Everything in the repository is written in **English**.
- Identifiers come verbatim from [`plan.md`](../plan.md); never invent new command ids or
  setting keys.
- Never put `Copilot`, `GitHub`, `Jira`, `Atlassian`, `VS Code` or `Visual Studio` in the
  extension name, command titles, view titles or setting keys.
- Models are accessed only through `vscode.lm` or the built-in chat commands. No LLM SDK,
  no direct model HTTP calls, no model API key.
- Tokens live only in `context.secrets`.
- Commit messages carry **no** `Co-Authored-By` trailer and no AI attribution footer.
