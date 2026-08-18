import { randomBytes } from 'node:crypto';

import * as vscode from 'vscode';

import { scanPlaceholders } from '../../agents/placeholders.js';
import type { ServiceContainer } from '../../container.js';
import { describeCron, nextRuns } from '../../scheduler/cron.js';
import { effectiveTimeZone } from '../../scheduler/schedule.js';
import { evaluateReadiness } from '../../setup/needsSetup.js';
import { resolveOutputFolder } from '../../setup/outputFolder.js';
import type { Agent } from '../../state/types.js';
import { describeRun } from '../agentsView.js';
import { runDocumentUri } from '../runDetails.js';
import { buildViewData } from '../viewState.js';

import { renderAgentPanel } from './agentPanelContent.js';
import type { AgentPanelViewModel } from './agentPanelContent.js';

/** How many runs the panel lists. The same ten the tree shows. */
const RECENT_RUNS = 10;

/** How many upcoming fire times the panel shows. The same three the tooltip shows. */
const UPCOMING_RUNS = 3;

/**
 * The agent panel.
 *
 * One panel for every agent rather than one per agent: a second agent replaces the content and
 * keeps the tab, because a panel per agent turns the editor into a wall of tabs nobody closes.
 * It holds no state of its own — every repaint is built from the store — so there is nothing to
 * retain when it is hidden and no way for it to disagree with the tree.
 */
export class AgentPanel {
  private static current: AgentPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private agentId: string;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly container: ServiceContainer,
    agent: Agent,
  ) {
    this.agentId = agent.id;

    this.panel.webview.onDidReceiveMessage(
      (message: { type?: string; target?: string }) => void this.handle(message),
      undefined,
      this.disposables,
    );
    this.disposables.push(
      this.container.store.onDidChange(() => {
        void this.render();
      }),
    );
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
  }

  /** Opens the panel beside the editor, or points the existing one at this agent. */
  static async show(container: ServiceContainer, agent: Agent): Promise<AgentPanel> {
    if (AgentPanel.current) {
      AgentPanel.current.agentId = agent.id;
      AgentPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      await AgentPanel.current.render();
      return AgentPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      'rounds.agentPanel',
      agent.name,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        // The extension may only talk to the hosts the user configured. The panel needs no
        // network at all, and the CSP below says so; this list is what it may load from disk.
        localResourceRoots: [vscode.Uri.joinPath(container.extensionContext.extensionUri, 'media')],
      },
    );
    AgentPanel.current = new AgentPanel(panel, container, agent);
    await AgentPanel.current.render();
    return AgentPanel.current;
  }

  /** The agent currently on screen, for tests and for the command that reopens it. */
  static get openAgentId(): string | undefined {
    return AgentPanel.current?.agentId;
  }

  static disposeCurrent(): void {
    AgentPanel.current?.panel.dispose();
  }

  private async handle(message: { type?: string; target?: string }): Promise<void> {
    const agent = await this.findAgent();
    if (!agent) {
      return;
    }
    switch (message.type) {
      case 'run':
        await vscode.commands.executeCommand('rounds.runNow', agent);
        return;
      case 'edit':
        await vscode.commands.executeCommand('rounds.editAgent', agent);
        return;
      case 'openFolder':
        await vscode.commands.executeCommand('rounds.openResultFolder', agent);
        return;
      case 'open':
        if (message.target) {
          await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(message.target));
        }
        return;
      default:
        this.container.logger.debug(`The agent panel sent an unknown message: ${String(message.type)}`);
    }
  }

  private async findAgent(): Promise<Agent | undefined> {
    const state = await this.container.store.read();
    return state.agents.find((candidate) => candidate.id === this.agentId);
  }

  /** Rebuilds the whole document. Cheap enough that no client-side state is worth the risk. */
  async render(): Promise<void> {
    const model = await this.buildModel();
    if (!model) {
      this.panel.title = 'Agent removed';
      this.panel.webview.html = '<!DOCTYPE html><html lang="en"><body></body></html>';
      return;
    }
    this.panel.title = model.agent.name;
    const nonce = randomBytes(16).toString('base64');
    this.panel.webview.html = renderAgentPanel(model, {
      nonce,
      cspSource: this.panel.webview.cspSource,
      scriptUri: this.panel.webview
        .asWebviewUri(
          vscode.Uri.joinPath(this.container.extensionContext.extensionUri, 'media', 'agentPanel.js'),
        )
        .toString(),
    });
  }

  private async buildModel(): Promise<AgentPanelViewModel | undefined> {
    const data = await buildViewData(this.container);
    const agent = data.state.agents.find((candidate) => candidate.id === this.agentId);
    if (!agent) {
      return undefined;
    }

    const settings = this.container.settings();
    const timeZone = effectiveTimeZone(agent, settings.timezone) ?? 'system time zone';
    const readiness = evaluateReadiness({
      agent,
      hasConsent: data.state.setup.consentGrantedAt !== undefined,
      models: data.state.setup.models ?? [],
      endpoints: data.state.endpoints,
      storedSecrets: data.storedSecrets,
      workspaceTrusted: data.workspaceTrusted,
    });
    const endpoint = data.state.endpoints[agent.source.baseUrlRef];
    const promptText =
      agent.prompt.source === 'inline'
        ? (agent.prompt.inlineText ?? '')
        : (agent.prompt.snapshot?.content ?? '');

    return {
      agent,
      schedule: describeCron(agent.schedule.cronExpressions),
      timeZone,
      nextRuns: agent.enabled
        ? nextRuns(
            agent.schedule.cronExpressions,
            UPCOMING_RUNS,
            new Date(),
            effectiveTimeZone(agent, settings.timezone),
          ).map((run) => run.toLocaleString())
        : [],
      notReady: readiness.ready ? undefined : readiness.reason,
      connection: endpoint
        ? {
            name: endpoint.name,
            baseUrl: endpoint.baseUrl,
            ready: data.storedSecrets.includes(endpoint.kind === 'jira' ? 'jiraToken' : 'gitToken'),
          }
        : undefined,
      placeholders: scanPlaceholders(promptText).used,
      promptFallback:
        agent.prompt.source === 'file' && agent.prompt.snapshot
          ? 'showing the stored snapshot of the prompt file'
          : undefined,
      outputFolder: resolveOutputFolder({
        agentFolder: agent.outputFolder,
        settingFolder: settings.defaultOutputFolder,
        globalStorage: this.container.extensionContext.globalStorageUri.fsPath,
      }),
      emptyScriptWhitelist:
        agent.tools.includes('runScript') && settings.scriptWhitelist.length === 0,
      runs: (data.state.history[agent.id] ?? []).slice(0, RECENT_RUNS).map((run) => ({
        id: run.id,
        status: run.status,
        startedAt: new Date(run.startedAt).toLocaleString(),
        description: describeRun(run),
        target: (run.resultFilePath
          ? vscode.Uri.file(run.resultFilePath)
          : runDocumentUri(run)
        ).toString(),
      })),
    };
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
