import type { RunRecord } from '../../state/types.js';

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
    .field { display: flex; flex-direction: column; gap: 0.25rem; margin: 0.75rem 0; max-width: 42rem; }
    .field label, .label-text { color: var(--vscode-descriptionForeground); }
    .field .hint, .preview { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 0; }
    .preview { margin: 0.25rem 0 0; }
    .error { color: var(--vscode-inputValidation-errorForeground, var(--vscode-editorError-foreground)); margin: 0; }
    input[type="text"], input[type="number"], select, textarea {
      font-family: inherit;
      font-size: inherit;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      padding: 0.3rem 0.4rem;
      width: 100%;
      box-sizing: border-box;
    }
    textarea { resize: vertical; font-family: var(--vscode-editor-font-family, monospace); }
    input:focus-visible, select:focus-visible, textarea:focus-visible, details:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .field.invalid input, .field.invalid select, .field.invalid textarea {
      border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-editorError-foreground));
    }
    .row-inline { display: flex; gap: 0.5rem; align-items: center; }
    .checks { display: flex; flex-wrap: wrap; gap: 0.75rem; }
    .tools { display: flex; flex-direction: column; gap: 0.5rem; }
    .tools .tool .hint { margin-left: 1.4rem; }
    .tools .tool.missing { color: var(--vscode-editorWarning-foreground); }
    ul.allowed { list-style: none; margin: 0.25rem 0; padding: 0; display: flex; flex-direction: column; gap: 0.2rem; }
    ul.allowed code { font-family: var(--vscode-editor-font-family, monospace); }
    label.check { display: flex; align-items: center; gap: 0.35rem; color: var(--vscode-foreground); }
    label.check input { width: auto; }
    details { margin: 1.5rem 0 0; }
    summary { cursor: pointer; color: var(--vscode-descriptionForeground); }
    button:disabled { opacity: 0.5; cursor: default; }
    button.danger {
      background: var(--vscode-inputValidation-errorBackground, var(--vscode-button-secondaryBackground));
      color: var(--vscode-button-secondaryForeground);
    }
  `;
}

/**
 * The document around whatever is being shown.
 *
 * One shell for the panel's two bodies, so the CSP, the nonce and the theme rules exist once and
 * neither can drift into being the less careful of the two.
 */
export function renderDocument(options: {
  title: string;
  body: string;
  nonce: string;
  cspSource: string;
  scriptUri: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonceAttribute(options.nonce)}'; script-src 'nonce-${nonceAttribute(options.nonce)}'; img-src ${escapeHtml(options.cspSource)};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(options.title)}</title>
<style nonce="${nonceAttribute(options.nonce)}">${styles()}</style>
</head>
<body>
${options.body}
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
