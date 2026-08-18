# Rounds — documentation

| Document | Purpose |
| --- | --- |
| [implementation-plan.md](./implementation-plan.md) | Master implementation plan: phases, milestones, conventions, traceability to `plan.md`. |
| [phases/](./phases/) | One file per phase with numbered steps and exit criteria. |
| [leftovers.md](./leftovers.md) | Everything the plan did not close, with the reason: owner decisions, checks that need a real environment, and the one missing feature. |
| [manual-checks.md](./manual-checks.md) | The checks that need eyes rather than a test runner. |

The product specification lives in [`../plan.md`](../plan.md). That file is the single
source of truth for names, identifiers and constraints. Whenever this documentation and
`plan.md` disagree, `plan.md` wins and the documentation must be corrected.

## Phase index

| Phase | Title | File |
| --- | --- | --- |
| 0 | Repository bootstrap and toolchain | [phase-00-bootstrap.md](./phases/phase-00-bootstrap.md) |
| 1 | Manifest and contribution skeleton | [phase-01-manifest.md](./phases/phase-01-manifest.md) |
| 2 | State, secrets and logging | [phase-02-state.md](./phases/phase-02-state.md) |
| 3 | Multi-window safety | [phase-03-multi-window.md](./phases/phase-03-multi-window.md) |
| 4 | Setup, consent and model catalog | [phase-04-setup-consent.md](./phases/phase-04-setup-consent.md) |
| 5 | Connectors | [phase-05-connectors.md](./phases/phase-05-connectors.md) |
| 6 | Prompt resolution and placeholders | [phase-06-prompts.md](./phases/phase-06-prompts.md) |
| 7 | Tool registry and v1 tools | [phase-07-tools.md](./phases/phase-07-tools.md) |
| 8 | Execution engine and results | [phase-08-execution.md](./phases/phase-08-execution.md) |
| 9 | Scheduler and rate-limit safety | [phase-09-scheduler.md](./phases/phase-09-scheduler.md) |
| 10 | User interface | [phase-10-ui.md](./phases/phase-10-ui.md) |
| 11 | Documentation and compliance | [phase-11-docs.md](./phases/phase-11-docs.md) |
| 12 | Hardening, testing and release | [phase-12-release.md](./phases/phase-12-release.md) |

Phases 0–12 are complete and describe the extension as it is. The phases below are planned
work, written after comparing Rounds against a published scheduling extension; each one
states what it does not do as clearly as what it does.

| Phase | Title | File |
| --- | --- | --- |
| 13 | Interface refinements and notification policy | [phase-13-interface-notifications.md](./phases/phase-13-interface-notifications.md) |
| 14 | Agent panel | [phase-14-agent-panel.md](./phases/phase-14-agent-panel.md) |
| 15 | Workspace trust | [phase-15-workspace-trust.md](./phases/phase-15-workspace-trust.md) |
| 16 | Prompt authoring and chat-mode parity | [phase-16-prompts-chat-mode.md](./phases/phase-16-prompts-chat-mode.md) |
| 17 | Asking about agents from chat | [phase-17-chat-tools.md](./phases/phase-17-chat-tools.md) |
| 18 | Connections managed from the view | [phase-18-connections.md](./phases/phase-18-connections.md) |
| 19 | Sources as project and repository | [phase-19-structured-sources.md](./phases/phase-19-structured-sources.md) |
| 20 | Agents created and edited in the panel | [phase-20-agent-editor.md](./phases/phase-20-agent-editor.md) |
