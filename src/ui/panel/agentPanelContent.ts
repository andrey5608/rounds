import type { Agent, RunRecord } from '../../state/types.js';

/**
 * Everything the panel draws, gathered before any HTML exists.
 *
 * A view model rather than the agent itself: the panel shows things the agent does not carry —
 * the next fire times, whether the connection it names is configured, where its results go — and
 * computing those inside a template is how a template stops being testable.
 */
export interface AgentPanelViewModel {
  agent: Agent;
  /** Upcoming fire times, already formatted in the agent's effective zone. */
  nextRuns: string[];
  timeZone: string;
  /** Human sentence for the schedule, from `describeCron`. */
  schedule: string;
  /** Why the agent cannot run, when it cannot. */
  notReady?: string;
  connection?: {
    name: string;
    baseUrl: string;
    /** Configured, with a token stored for it. */
    ready: boolean;
  };
  /** Placeholders the prompt uses, so somebody can see what the model will actually receive. */
  placeholders: string[];
  /** Set when the prompt is a file and the stored snapshot is being used instead. */
  promptFallback?: string;
  outputFolder: string;
  runs: RunPresentation[];
  /** True when `runScript` is enabled and the whitelist is empty, which makes it inert. */
  emptyScriptWhitelist: boolean;
}

export interface RunPresentation {
  id: string;
  status: RunRecord['status'];
  startedAt: string;
  /** Already formatted: `12 items · 8.4 s — summary`. */
  description: string;
  /** Where clicking it leads. The panel does not decide this; the extension side does. */
  target: string;
}

/**
 * Escapes text on its way into HTML.
 *
 * A prompt body is user content and lands in this document. That makes it the one place in the
 * extension where an injection is possible at all, so nothing reaches the template without
 * passing through here.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function row(label: string, value: string): string {
  return `<div class="row"><span class="label">${escapeHtml(label)}</span><span class="value">${value}</span></div>`;
}

function chip(text: string, tone: 'ok' | 'warn' | 'muted' = 'muted'): string {
  return `<span class="chip ${tone}">${escapeHtml(text)}</span>`;
}

function describeSource(agent: Agent): string {
  if (agent.source.kind === 'jira') {
    return `<code>${escapeHtml(agent.source.jql)}</code> · at most ${agent.source.maxResults} item(s)`;
  }
  const mode = agent.source.mode === 'newPullRequests' ? 'new' : 'updated';
  return `${escapeHtml(agent.source.repo)} · ${mode} pull requests`;
}

function promptSection(model: AgentPanelViewModel): string {
  const { agent } = model;
  const origin =
    agent.prompt.source === 'inline'
      ? 'written into the agent'
      : `file: <code>${escapeHtml(agent.prompt.filePath ?? '')}</code>`;
  const body =
    agent.prompt.source === 'inline'
      ? (agent.prompt.inlineText ?? '')
      : (agent.prompt.snapshot?.content ?? '');
  const placeholders =
    model.placeholders.length > 0
      ? model.placeholders.map((name) => chip(name)).join(' ')
      : '<span class="muted-text">none</span>';

  return `<section>
    <h2>Prompt</h2>
    ${row('Source', origin)}
    ${row('Placeholders', placeholders)}
    ${model.promptFallback ? row('Fallback', `${chip(model.promptFallback, 'warn')}`) : ''}
    <pre class="prompt">${escapeHtml(body)}</pre>
  </section>`;
}

function runsSection(model: AgentPanelViewModel): string {
  if (model.runs.length === 0) {
    return `<section><h2>Runs</h2><p class="muted-text">No runs yet.</p></section>`;
  }
  const items = model.runs
    .map(
      (run) => `<li class="run ${escapeHtml(run.status)}">
        <a href="#" data-target="${escapeHtml(run.target)}">${escapeHtml(run.startedAt)}</a>
        <span class="status">${escapeHtml(run.status)}</span>
        <span class="muted-text">${escapeHtml(run.description)}</span>
      </li>`,
    )
    .join('');
  return `<section><h2>Runs</h2><ul class="runs">${items}</ul></section>`;
}

/** The styles, written against the editor's own theme variables so the panel follows it. */
function styles(): string {
  return `
    :root { color-scheme: light dark; }
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      margin: 0;
      padding: 1.25rem 1.5rem 2.5rem;
      line-height: 1.5;
    }
    h1 { font-size: 1.4rem; margin: 0 0 0.25rem; }
    h2 {
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--vscode-descriptionForeground);
      margin: 1.75rem 0 0.5rem;
    }
    section { border-top: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); }
    section:first-of-type { border-top: none; }
    .row { display: flex; gap: 1rem; padding: 0.2rem 0; align-items: baseline; }
    .label { min-width: 9rem; color: var(--vscode-descriptionForeground); }
    .value { flex: 1; overflow-wrap: anywhere; }
    .muted-text { color: var(--vscode-descriptionForeground); }
    .chip {
      display: inline-block;
      padding: 0.05rem 0.4rem;
      border-radius: 3px;
      border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
      font-size: 0.85em;
    }
    .chip.ok { border-color: var(--vscode-charts-green); }
    .chip.warn {
      border-color: var(--vscode-editorWarning-foreground);
      color: var(--vscode-editorWarning-foreground);
    }
    pre.prompt {
      white-space: pre-wrap;
      overflow-x: auto;
      background: var(--vscode-textCodeBlock-background);
      padding: 0.75rem;
      border-radius: 4px;
      margin: 0.5rem 0 0;
    }
    ul.runs { list-style: none; margin: 0; padding: 0; }
    li.run { display: flex; gap: 0.75rem; padding: 0.25rem 0; align-items: baseline; }
    li.run .status { min-width: 6rem; }
    li.run.failed .status { color: var(--vscode-editorError-foreground); }
    a { color: var(--vscode-textLink-foreground); }
    a:focus-visible, button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .actions { display: flex; gap: 0.5rem; margin-top: 1.5rem; flex-wrap: wrap; }
    button {
      font-family: inherit;
      font-size: inherit;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: none;
      padding: 0.35rem 0.9rem;
      border-radius: 2px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .warning {
      color: var(--vscode-editorWarning-foreground);
      margin: 0.5rem 0 0;
    }
  `;
}

/**
 * The whole document.
 *
 * `nonce` and `cspSource` come from the webview, which is the only part of this that needs the
 * editor. Everything else is a pure function of the view model, which is what makes the escaping
 * and the structure testable without an extension host.
 */
export function renderAgentPanel(
  model: AgentPanelViewModel,
  options: { nonce: string; cspSource: string; scriptUri: string },
): string {
  const { agent } = model;
  const state = agent.enabled ? chip('enabled', 'ok') : chip('disabled');
  const mode =
    agent.executionMode === 'api'
      ? chip('result captured', 'ok')
      : chip('handed to chat', 'warn');

  const chatNote =
    agent.executionMode === 'chat'
      ? `<p class="warning">The prompt is opened in the chat view, so Rounds does not capture the answer.</p>`
      : '';
  const readiness = model.notReady
    ? `<p class="warning">${escapeHtml(model.notReady)}</p>`
    : '';
  const whitelistNote = model.emptyScriptWhitelist
    ? `<p class="warning">runScript is enabled but the script whitelist is empty, so it refuses every command.</p>`
    : '';

  const connection = model.connection
    ? `${escapeHtml(model.connection.name)} · ${escapeHtml(model.connection.baseUrl)} ${
        model.connection.ready ? chip('token stored', 'ok') : chip('no token', 'warn')
      }`
    : `${chip('not configured', 'warn')}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonceAttribute(options.nonce)}'; script-src 'nonce-${nonceAttribute(options.nonce)}'; img-src ${escapeHtml(options.cspSource)};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(agent.name)}</title>
<style nonce="${nonceAttribute(options.nonce)}">${styles()}</style>
</head>
<body>
<h1>${escapeHtml(agent.name)}</h1>
<p>${state} ${mode}</p>
${chatNote}
${readiness}

<section>
  <h2>Schedule</h2>
  ${row('Runs', escapeHtml(model.schedule))}
  ${row('Time zone', escapeHtml(model.timeZone))}
  ${row(
    'Next runs',
    model.nextRuns.length > 0
      ? model.nextRuns.map((run) => escapeHtml(run)).join(', ')
      : '<span class="muted-text">nothing scheduled</span>',
  )}
  ${
    agent.allowedTimeStart && agent.allowedTimeEnd
      ? row('Only between', `${escapeHtml(agent.allowedTimeStart)} and ${escapeHtml(agent.allowedTimeEnd)}`)
      : ''
  }
  ${agent.maxExecutionsPerDay ? row('Daily limit', `${agent.maxExecutionsPerDay} run(s)`) : ''}
</section>

<section>
  <h2>Source</h2>
  ${row('Connection', connection)}
  ${row(agent.source.kind === 'jira' ? 'Query' : 'Repository', describeSource(agent))}
  ${
    agent.source.kind === 'git' && agent.source.sinceCursor
      ? row('Continues after', escapeHtml(agent.source.sinceCursor))
      : ''
  }
</section>

<section>
  <h2>Model and tools</h2>
  ${row('Model', `<code>${escapeHtml(agent.modelId)}</code>`)}
  ${row(
    'Tools',
    agent.tools.length > 0
      ? agent.tools.map((tool) => chip(tool)).join(' ')
      : '<span class="muted-text">none</span>',
  )}
  ${row('Results', `<code>${escapeHtml(model.outputFolder)}</code>`)}
  ${whitelistNote}
</section>

${promptSection(model)}
${runsSection(model)}

<div class="actions">
  <button data-command="run">Run Now</button>
  <button data-command="edit">Edit Agent</button>
  <button data-command="openFolder">Open Result Folder</button>
</div>

<script nonce="${nonceAttribute(options.nonce)}" src="${escapeHtml(options.scriptUri)}"></script>
</body>
</html>`;
}

/** A nonce is an attribute value and a CSP token at once; anything but base64 characters is a bug. */
function nonceAttribute(nonce: string): string {
  if (!/^[A-Za-z0-9+/=]+$/.test(nonce)) {
    throw new Error('The webview nonce must be base64 characters only.');
  }
  return nonce;
}
