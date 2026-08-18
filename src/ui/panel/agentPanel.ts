import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { resolveProvider } from '../../connectors/factory.js';
import type { ServiceContainer } from '../../container.js';
import { minIntervalMinutes } from '../../scheduler/cron.js';
import { evaluateReadiness } from '../../setup/needsSetup.js';
import { resolveOutputFolder } from '../../setup/outputFolder.js';
import type { Agent } from '../../state/types.js';
import { describeRun } from '../agentsView.js';
import { parsePromptFile } from '../../agents/promptFrontMatter.js';
import { addToWhitelist, describeEntry, parseCommandLine } from '../../tools/scriptWhitelist.js';
import { listExternalTools } from '../../tools/vscodeLmTools.js';
import { runDocumentUri } from '../runDetails.js';
import { buildViewData } from '../viewState.js';
import { agentToDraft, describeScheduleInput, draftToAgent } from '../wizard/steps.js';
import type { AgentDraft } from '../wizard/steps.js';

import { renderAgentForm } from './agentFormContent.js';
import type { AgentFormViewModel } from './agentFormContent.js';
import { draftFromMessage, emptyDraft, panelUpdateKind, validateDraft } from './agentFormModel.js';
import type { FieldErrors, FormContext, FormState, FormTool } from './agentFormModel.js';
import { renderDocument } from './agentPanelContent.js';
import { pickPromptFile } from './promptFilePicker.js';

/** How many runs the panel lists. The same ten the tree shows. */
const RECENT_RUNS = 10;

interface PanelMessage {
  type?: string;
  draft?: unknown;
  target?: string;
}

/**
 * The agent panel: the one place an agent is read and changed.
 *
 * One panel for every agent rather than one per agent, and one form for creating and editing,
 * because they are the same object. The draft lives in the webview — the form controls *are* the
 * draft — and every rule is applied here by the functions in `steps.ts` that the unit tests call,
 * so the form and the tests cannot drift apart. That was the objection phase 14 raised against a
 * webview form, and answering it is why the quick-pick sequence went rather than gained a sibling.
 */
export class AgentPanel {
  private static current: AgentPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  /** Absent while creating. */
  private agentId: string | undefined;
  private draft: AgentDraft | undefined;
  private errors: FieldErrors = {};
  private dirty = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly container: ServiceContainer,
    agentId: string | undefined,
  ) {
    this.agentId = agentId;

    this.panel.webview.onDidReceiveMessage(
      (message: PanelMessage) => void this.handle(message),
      undefined,
      this.disposables,
    );
    this.disposables.push(
      this.container.store.onDidChange(() => {
        // A repaint from outside must not throw away what somebody is typing.
        if (!this.dirty) {
          void this.render();
        }
      }),
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /** Opens an agent, or an empty form when no agent is given. */
  static async show(container: ServiceContainer, agent?: Agent): Promise<AgentPanel> {
    if (AgentPanel.current) {
      const panel = AgentPanel.current;
      if (!(await panel.confirmDiscard())) {
        return panel;
      }
      panel.agentId = agent?.id;
      panel.draft = undefined;
      panel.dirty = false;
      panel.errors = {};
      panel.panel.reveal(vscode.ViewColumn.Beside, true);
      await panel.render();
      return panel;
    }

    const created = vscode.window.createWebviewPanel(
      'rounds.agentPanel',
      agent?.name ?? 'New agent',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        // The panel needs no network at all and the CSP says so; this is what it may load from
        // disk. The extension itself may only talk to the hosts the user configured.
        localResourceRoots: [vscode.Uri.joinPath(container.extensionContext.extensionUri, 'media')],
      },
    );
    AgentPanel.current = new AgentPanel(created, container, agent?.id);
    await AgentPanel.current.render();
    return AgentPanel.current;
  }

  /** The agent currently on screen, for tests and for the command that reopens it. */
  static get openAgentId(): string | undefined {
    return AgentPanel.current?.agentId;
  }

  /** Whether the form holds changes nobody has saved. */
  static get hasUnsavedChanges(): boolean {
    return AgentPanel.current?.dirty ?? false;
  }

  static disposeCurrent(): void {
    AgentPanel.current?.panel.dispose();
  }

  private async handle(message: PanelMessage): Promise<void> {
    switch (message.type) {
      case 'touched':
        // Sent on the first keystroke, before the debounced draft arrives, so a store change from
        // another window cannot repaint over what is being typed in that window.
        this.dirty = true;
        return;
      case 'change':
      case 'reshape': {
        this.draft = draftFromMessage(message.draft);
        this.dirty = true;
        // `change` deliberately does not repaint: rebuilding the document replaces the element
        // being typed into, and the field then loses focus after one character. `reshape` does,
        // because a select changed which fields exist. `panelUpdateKind` owns that distinction so
        // a test can hold it.
        await (panelUpdateKind(message.type) === 'repaint' ? this.render() : this.postState());
        return;
      }
      case 'save':
        this.draft = draftFromMessage(message.draft);
        await this.save();
        return;
      case 'pickPromptFile':
        await this.pickPromptFile(draftFromMessage(message.draft));
        return;
      case 'allowCommand':
        this.draft = draftFromMessage(message.draft);
        this.dirty = true;
        await this.allowCommand();
        return;
      case 'run':
        await this.withAgent((agent) => vscode.commands.executeCommand('rounds.runNow', agent));
        return;
      case 'openFolder':
        await this.withAgent((agent) =>
          vscode.commands.executeCommand('rounds.openResultFolder', agent),
        );
        return;
      case 'delete':
        await this.withAgent(async (agent) => {
          await vscode.commands.executeCommand('rounds.deleteAgent', agent);
          if (!(await this.findAgent())) {
            this.panel.dispose();
          }
        });
        return;
      case 'open':
        if (message.target) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(message.target));
        }
        return;
      default:
        this.container.logger.debug(
          `The agent panel sent an unknown message: ${String(message.type)}`,
        );
    }
  }

  /** Sends the rules' verdict on the current draft, for the form to draw where it stands. */
  private async postState(): Promise<void> {
    const draft = this.draft;
    if (!draft) {
      return;
    }
    const context = await this.buildContext();
    this.errors = validateDraft(draft, context);
    const feedback = describeScheduleInput((draft.schedule ?? []).join('; '), {
      timeZone: draft.timezone,
    });

    const state: FormState = {
      errors: this.errors,
      schedulePreview: feedback.kind === 'preview' ? feedback.message : undefined,
      canSave: this.dirty,
    };
    await this.panel.webview.postMessage({ type: 'state', state });
  }

  /** Runs an action that needs a saved agent, and says so when there is not one yet. */
  private async withAgent(action: (agent: Agent) => Promise<unknown> | Thenable<unknown>): Promise<void> {
    const agent = await this.findAgent();
    if (!agent) {
      await this.container.notifier.requested('info', 'Save the agent first.');
      return;
    }
    await action(agent);
  }

  private async findAgent(): Promise<Agent | undefined> {
    if (!this.agentId) {
      return undefined;
    }
    const state = await this.container.store.read();
    return state.agents.find((candidate) => candidate.id === this.agentId);
  }

  /**
   * Applies every rule, then writes.
   *
   * The rules are the functions in `steps.ts`; the form contributes values and nothing else.
   */
  private async save(): Promise<void> {
    const draft = this.draft;
    if (!draft) {
      return;
    }
    const context = await this.buildContext();
    const errors = validateDraft(draft, context);
    if (Object.keys(errors).length > 0) {
      this.errors = errors;
      await this.render();
      await this.container.notifier.requested('warning', 'Some fields still need attention.');
      return;
    }

    // The one rule that asks somebody to accept a consequence rather than to fix a value, so it
    // is a modal on the way out rather than a note in the form that is dismissed by not reading.
    const threshold = this.container.settings().minimumIntervalWarning;
    const interval = minIntervalMinutes(draft.schedule, new Date(), draft.timezone);
    if (interval !== undefined && interval < threshold) {
      const choice = await vscode.window.showWarningMessage(
        `This schedule runs every ${interval} minute(s). Frequent automated requests can get your model provider account rate limited.`,
        { modal: true },
        'Save it anyway',
      );
      if (choice !== 'Save it anyway') {
        return;
      }
    }

    const existing = await this.findAgent();
    const agent = draftToAgent(draft, new Date(), existing);
    agent.enabled = draft.enabled ?? existing?.enabled ?? true;

    // One revisioned write, like every other change to the state: a collision reloads and retries
    // inside the store rather than losing what was typed here.
    await this.container.store.update((state) => {
      const index = state.agents.findIndex((candidate) => candidate.id === agent.id);
      if (index >= 0) {
        state.agents[index] = agent;
      } else {
        state.agents.push(agent);
      }
    });

    this.agentId = agent.id;
    this.draft = undefined;
    this.dirty = false;
    this.errors = {};
    await this.container.ticker.recomputeAll();
    await this.render();
    await this.container.notifier.requested('info', `"${agent.name}" saved.`);
  }

  private async pickPromptFile(draft: AgentDraft): Promise<void> {
    // The discovery picker from phase 16, not a bare dialog: a repository that keeps prompts in
    // `.github/prompts` should not make somebody find them again by hand.
    const file = await pickPromptFile();
    if (!file) {
      return;
    }
    const next: AgentDraft = { ...draft, promptSource: 'file', promptFile: file };
    Object.assign(next, await this.readPromptFileHeader(file, next));

    this.draft = next;
    this.dirty = true;
    await this.render();
  }

  /**
   * What a chosen prompt file's header contributes to the draft.
   *
   * Tools it names are preselected — only the ones that exist, so a file cannot enable something
   * nobody has — and its model is used only when the agent has none. A file quietly changing
   * which model runs would be the substitution the specification refuses everywhere else, by
   * another route.
   */
  private async readPromptFileHeader(
    file: string,
    draft: AgentDraft,
  ): Promise<Partial<AgentDraft>> {
    let content: string;
    try {
      content = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(file))).toString('utf8');
    } catch (error) {
      this.container.logger.debug(`Could not read ${file} for its header: ${String(error)}`);
      return {};
    }

    const header = parsePromptFile(content).frontMatter;
    if (!header) {
      return {};
    }

    const available = new Set(this.container.tools.names());
    const asked = header.tools.filter((name) => available.has(name));
    const ignored = header.tools.filter((name) => !available.has(name));
    if (ignored.length > 0) {
      this.container.logger.info(
        `The prompt file asks for ${ignored.join(', ')}, which nothing registers; left off the agent.`,
      );
    }

    return {
      tools: [...new Set([...draft.tools, ...asked])],
      modelId: draft.modelId || (header.model ?? ''),
    };
  }

  /**
   * Adds one command line to `rounds.scriptWhitelist`.
   *
   * The warning used to name the problem and leave somebody to find a JSON array in the settings,
   * which is a long way to travel from the place that says what is wrong. Written to the user
   * settings rather than the workspace: agents are global here, and the setting is restricted in
   * an untrusted workspace, so a workspace value would be the one that does not apply.
   */
  private async allowCommand(): Promise<void> {
    const typed = await vscode.window.showInputBox({
      title: 'Allow a command for runScript',
      prompt: 'Exactly what may run, arguments included. A pattern may end with * to accept any suffix.',
      placeHolder: 'npm test',
      ignoreFocusOut: true,
      validateInput: (value) => {
        const parsed = parseCommandLine(value);
        return parsed.ok ? undefined : parsed.message;
      },
    });
    if (!typed) {
      return;
    }
    const parsed = parseCommandLine(typed);
    if (!parsed.ok) {
      return;
    }

    const current = this.container.settings().scriptWhitelist;
    const { whitelist, added } = addToWhitelist(current, parsed.entry);
    if (!added) {
      await this.container.notifier.requested(
        'info',
        `"${describeEntry(parsed.entry)}" is already allowed.`,
      );
      return;
    }

    await vscode.workspace
      .getConfiguration()
      .update('rounds.scriptWhitelist', whitelist, vscode.ConfigurationTarget.Global);
    await this.container.notifier.requested(
      'info',
      `runScript may now run "${describeEntry(parsed.entry)}".`,
    );
    await this.render();
  }

  /** Asks once before losing work, and only when there is work to lose. */
  private async confirmDiscard(): Promise<boolean> {
    if (!this.dirty) {
      return true;
    }
    const choice = await vscode.window.showWarningMessage(
      'This agent has unsaved changes.',
      { modal: true },
      'Discard them',
    );
    return choice === 'Discard them';
  }

  /**
   * Ours, then the workspace's, then anything the agent enabled that nothing provides.
   *
   * A missing tool stays in the list, marked, rather than disappearing: the run will fail on it,
   * and a form that hides the cause turns that failure into a mystery.
   */
  private availableTools(enabled: readonly string[]): FormTool[] {
    const ours: FormTool[] = this.container.tools.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));
    const external: FormTool[] = listExternalTools().map((info) => ({
      name: info.name,
      description: info.description,
      external: true,
      tags: info.tags,
    }));

    const known = new Set([...ours, ...external].map((tool) => tool.name));
    const missing: FormTool[] = enabled
      .filter((name) => !known.has(name))
      .map((name) => ({
        name,
        description: 'No extension provides this tool right now, so a run would fail on it.',
        external: true,
        missing: true,
      }));

    return [...ours, ...external, ...missing];
  }

  private async buildContext(): Promise<FormContext> {
    const data = await buildViewData(this.container);
    const agent = data.state.agents.find((candidate) => candidate.id === this.agentId);
    const connections = Object.values(data.state.endpoints);
    const draftTools = this.draft?.tools ?? agent?.tools ?? [];
    const reference = this.draft?.endpointName ?? agent?.source?.baseUrlRef;
    const chosen = connections.find((endpoint) => endpoint.name === reference);

    return {
      agents: data.state.agents,
      editing: agent,
      connections,
      models: data.state.setup.models ?? [],
      tools: this.availableTools(draftTools),
      emptyScriptWhitelist: this.container.settings().scriptWhitelist.length === 0,
      scriptWhitelist: this.container.settings().scriptWhitelist.map(describeEntry),
      provider: chosen && chosen.kind === 'git' ? resolveProvider(chosen) : 'github',
    };
  }

  /** Rebuilds the whole document. The form is small and a repaint is a template call. */
  async render(): Promise<void> {
    const context = await this.buildContext();
    const draft =
      this.draft ?? (context.editing ? agentToDraft(context.editing) : emptyDraft(context));
    if (this.dirty) {
      this.draft = draft;
    }

    const data = await buildViewData(this.container);
    const settings = this.container.settings();
    const feedback = describeScheduleInput((draft.schedule ?? []).join('; '), {
      timeZone: draft.timezone,
    });
    const readiness = context.editing
      ? evaluateReadiness({
          agent: context.editing,
          hasConsent: data.state.setup.consentGrantedAt !== undefined,
          models: data.state.setup.models ?? [],
          endpoints: data.state.endpoints,
          storedSecrets: data.storedSecrets,
          workspaceTrusted: data.workspaceTrusted,
        })
      : undefined;

    const model: AgentFormViewModel = {
      draft,
      context,
      errors: this.errors,
      canSave: this.dirty,
      schedulePreview: feedback.kind === 'preview' ? feedback.message : undefined,
      outputFolder: resolveOutputFolder({
        agentFolder: draft.outputFolder,
        settingFolder: settings.defaultOutputFolder,
        globalStorage: this.container.extensionContext.globalStorageUri.fsPath,
      }),
      notReady: readiness && !readiness.ready ? readiness.reason : undefined,
      runs: context.editing
        ? (data.state.history[context.editing.id] ?? []).slice(0, RECENT_RUNS).map((run) => ({
            id: run.id,
            status: run.status,
            startedAt: new Date(run.startedAt).toLocaleString(),
            description: describeRun(run),
            target: (run.resultFilePath
              ? vscode.Uri.file(run.resultFilePath)
              : runDocumentUri(run)
            ).toString(),
          }))
        : undefined,
    };

    this.panel.title = context.editing?.name ?? 'New agent';
    this.panel.webview.html = renderDocument({
      title: this.panel.title,
      body: renderAgentForm(model),
      nonce: randomBytes(16).toString('base64'),
      cspSource: this.panel.webview.cspSource,
      scriptUri: this.panel.webview
        .asWebviewUri(
          vscode.Uri.joinPath(
            this.container.extensionContext.extensionUri,
            'media',
            'agentPanel.js',
          ),
        )
        .toString(),
    });
  }

  dispose(): void {
    if (AgentPanel.current === this) {
      AgentPanel.current = undefined;
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }
}
