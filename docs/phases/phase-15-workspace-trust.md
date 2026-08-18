# Phase 15 — Workspace trust

**Goal:** opening a repository must not be enough to make Rounds run commands from it.

**Depends on:** phase 7 for the tool registry; independent of 13 and 14.

Rounds does not consult `vscode.workspace.isTrusted` anywhere, and `package.json` declares
no `capabilities.untrustedWorkspaces`. Without that declaration the editor assumes the
extension is safe everywhere and activates it in full. Meanwhile `runScript` executes
whitelisted commands with the workspace as its working directory, an agent can be scheduled
to start on activation, and a file prompt is read from the workspace — three ways for a
repository somebody cloned to reach a shell. Workspace trust is the mechanism the editor
provides for exactly this, and using it is cheaper than any of the alternatives.

## Steps

### 15.1 Declare the capability
- `capabilities.untrustedWorkspaces`: `supported: "limited"`, a description saying what is
  limited and why, and `restrictedConfigurations: ["rounds.scriptWhitelist"]` so a
  workspace cannot supply its own list of runnable commands.
- `limited` rather than `false`: reading an issue tracker and writing a result file are
  harmless, and refusing to activate would punish the common case for the rare one.

### 15.2 `runScript` refuses in an untrusted workspace
- Trust reaches the tool as a field on `ToolContext`, next to `scriptWhitelist`. The tools
  layer stays free of `vscode` imports — the same reason `workspaceFolders` is passed in
  rather than read.
- The refusal is a `checkPermission` denial, not an exception: the loop already feeds a
  denial back to the model, so a run continues with one tool fewer instead of failing.
- The message says what to do — trust the workspace, or remove the tool from the agent —
  because "not permitted" without a next step is where support requests come from.

### 15.3 Reading stays allowed, executing does not
- `readFile` and `listFiles` keep working in an untrusted workspace: the editor itself
  shows those files, and Rounds sending their contents to a model the user configured is
  the job they asked for.
- File prompts keep working for the same reason. Write the decision and its reasoning into
  this step, so nobody has to re-derive it from the diff later.

### 15.4 An agent that cannot work says so before it runs
- Readiness (`needsSetup` in the tree, and the panel from phase 14) accounts for trust: an
  enabled agent with `runScript` in an untrusted workspace is marked not ready, with the
  reason.
- Better than failing at 09:00: the icon is visible when somebody is looking at the view.

### 15.5 Check Setup reports it without growing a seventh check
- The script whitelist check already exists and already warns about an empty list. It gains
  one more state: whitelist configured, workspace untrusted, therefore inert.
- `plan.md` fixes the check list at six. Reusing the one that already owns this subject
  keeps the specification and the code in agreement.

### 15.6 Tests
- Unit: `runScript` denies with `workspaceTrusted: false` and the denial names both remedies;
  readiness marks such an agent not ready; `readFile` is unaffected.
- Integration: the manifest declares the capability and lists `rounds.scriptWhitelist` as
  restricted; the setup check reports the untrusted state.

## Exit criteria

- [ ] `package.json` declares limited untrusted-workspace support and restricts
      `rounds.scriptWhitelist`.
- [ ] With trust withheld, `runScript` never executes, and the run continues with a recorded
      denial rather than a failure.
- [ ] Reading files and file prompts still work, and the reasoning is documented in this phase.
- [ ] An agent that depends on `runScript` is shown as not ready before it is due, with the reason.
- [ ] Check Setup still reports six checks.
