import { formatRepository, sourceVocabulary } from '../../agents/sourceLabels.js';
import type { AgentDraft } from '../wizard/steps.js';

import { escapeHtml } from './agentPanelContent.js';
import type { RunPresentation } from './agentPanelContent.js';
import type { FieldErrors, FormContext } from './agentFormModel.js';

export interface AgentFormViewModel {
  draft: AgentDraft;
  context: FormContext;
  errors: FieldErrors;
  /** Sentence and next runs for the schedule as typed, from `describeScheduleInput`. */
  schedulePreview?: string;
  /** Last runs of the agent being edited. Absent while creating. */
  runs?: RunPresentation[];
  /** Where results are written, resolved the same way a run resolves it. */
  outputFolder: string;
  /** Set when this agent cannot run as configured. */
  notReady?: string;
  /** Save is disabled until something changes: opening an agent to look at it writes nothing. */
  canSave: boolean;
}

function error(errors: FieldErrors, field: keyof FieldErrors): string {
  const message = errors[field];
  return message
    ? `<p class="error" id="${field}-error" role="alert">${escapeHtml(message)}</p>`
    : '';
}

function field(options: {
  id: string;
  label: string;
  control: string;
  hint?: string;
  errors: FieldErrors;
  errorKey?: keyof FieldErrors;
}): string {
  const key = options.errorKey ?? (options.id as keyof FieldErrors);
  return `<div class="field${options.errors[key] ? ' invalid' : ''}">
    <label for="${options.id}">${escapeHtml(options.label)}</label>
    ${options.control}
    ${options.hint ? `<p class="hint">${escapeHtml(options.hint)}</p>` : ''}
    ${error(options.errors, key)}
  </div>`;
}

function textInput(options: {
  id: string;
  value?: string;
  placeholder?: string;
  errors: FieldErrors;
  errorKey?: keyof FieldErrors;
}): string {
  const key = options.errorKey ?? (options.id as keyof FieldErrors);
  return `<input type="text" id="${options.id}" name="${options.id}" value="${escapeHtml(options.value ?? '')}"
    placeholder="${escapeHtml(options.placeholder ?? '')}"
    ${options.errors[key] ? `aria-invalid="true" aria-describedby="${key}-error"` : ''} />`;
}

function select(options: {
  id: string;
  value?: string;
  entries: { value: string; label: string; description?: string }[];
  errors: FieldErrors;
}): string {
  const key = options.id as keyof FieldErrors;
  const rendered = options.entries
    .map(
      (entry) =>
        `<option value="${escapeHtml(entry.value)}"${entry.value === options.value ? ' selected' : ''}>${escapeHtml(
          entry.description ? `${entry.label} — ${entry.description}` : entry.label,
        )}</option>`,
    )
    .join('');
  return `<select id="${options.id}" name="${options.id}"${
    options.errors[key] ? ` aria-invalid="true" aria-describedby="${key}-error"` : ''
  }>${rendered}</select>`;
}

function checkbox(id: string, label: string, checked: boolean, value = 'true'): string {
  return `<label class="check"><input type="checkbox" id="${id}" name="${id}" value="${escapeHtml(value)}"${
    checked ? ' checked' : ''
  } /> ${escapeHtml(label)}</label>`;
}

function identitySection(model: AgentFormViewModel): string {
  const { draft, errors } = model;
  const chatNote =
    draft.executionMode === 'chat'
      ? `<p class="warning">The prompt is opened in the chat view, so Rounds does not capture the answer: a run records that the handoff happened and nothing else.</p>`
      : '';

  return `<section>
    <h2>Agent</h2>
    ${field({
      id: 'name',
      label: 'Name',
      errors,
      control: textInput({ id: 'name', value: draft.name, placeholder: 'Morning triage', errors }),
    })}
    <div class="field">
      <label for="executionMode">Execution mode</label>
      ${select({
        id: 'executionMode',
        value: draft.executionMode,
        entries: [
          { value: 'api', label: 'Run it and store the result' },
          { value: 'chat', label: 'Open it in the chat view for review' },
        ],
        errors,
      })}
      ${chatNote}
    </div>
    <div class="field">${checkbox('enabled', 'Scheduled runs are on', model.draft.enabled ?? true)}</div>
  </section>`;
}

function sourceSection(model: AgentFormViewModel): string {
  const { draft, errors, context } = model;
  const vocabulary = sourceVocabulary(context.provider);
  const connections = context.connections.filter((endpoint) => endpoint.kind === draft.sourceKind);

  const perKind =
    draft.sourceKind === 'jira'
      ? `${field({
          id: 'project',
          label: 'Project',
          hint: 'Optional. Used to say which project this agent reads.',
          errors,
          control: textInput({ id: 'project', value: draft.project, placeholder: 'ROUNDS', errors }),
        })}
        ${field({
          id: 'jql',
          label: 'Search query',
          errors,
          control: textInput({
            id: 'jql',
            value: draft.jql,
            placeholder: 'project = ROUNDS AND status != Done',
            errors,
          }),
        })}
        ${field({
          id: 'maxResults',
          label: 'At most',
          hint: 'Issues fetched per run.',
          errors,
          control: `<input type="number" id="maxResults" name="maxResults" min="1" max="200" value="${escapeHtml(
            String(draft.maxResults ?? 20),
          )}" />`,
        })}`
      : `${field({
          id: 'project',
          label: vocabulary.project,
          hint: vocabulary.hint,
          errors,
          control: textInput({
            id: 'project',
            value: draft.project,
            placeholder: vocabulary.example,
            errors,
          }),
        })}
        ${field({
          id: 'repo',
          label: 'Repository',
          errors,
          control: textInput({ id: 'repo', value: draft.repo, placeholder: 'rounds', errors }),
        })}
        <div class="field">
          <label for="gitMode">Which pull requests</label>
          ${select({
            id: 'gitMode',
            value: draft.gitMode,
            entries: [
              { value: 'newPullRequests', label: 'Opened since the last run' },
              { value: 'updatedPullRequests', label: 'Changed since the last run' },
            ],
            errors,
          })}
        </div>`;

  return `<section>
    <h2>Source</h2>
    <div class="field">
      <label for="sourceKind">Reads from</label>
      ${select({
        id: 'sourceKind',
        value: draft.sourceKind,
        entries: [
          { value: 'jira', label: 'An issue tracker' },
          { value: 'git', label: 'A repository host' },
        ],
        errors,
      })}
    </div>
    ${field({
      id: 'endpointName',
      label: 'Connection',
      errorKey: 'connection',
      errors,
      control:
        connections.length > 0
          ? select({
              id: 'endpointName',
              value: draft.endpointName,
              entries: connections.map((endpoint) => ({
                value: endpoint.name,
                label: endpoint.name,
                description: endpoint.baseUrl,
              })),
              errors,
            })
          : `<p class="warning">No connection of this kind is configured. Add one in the Connections view.</p>`,
    })}
    ${perKind}
  </section>`;
}

function promptSection(model: AgentFormViewModel): string {
  const { draft, errors } = model;
  const inline = draft.promptSource === 'inline';
  return `<section>
    <h2>Prompt</h2>
    <div class="field">
      <label for="promptSource">Comes from</label>
      ${select({
        id: 'promptSource',
        value: draft.promptSource,
        entries: [
          { value: 'inline', label: 'Text written here' },
          { value: 'file', label: 'A file in the workspace' },
        ],
        errors,
      })}
    </div>
    ${
      inline
        ? field({
            id: 'promptText',
            label: 'Prompt',
            errorKey: 'prompt',
            hint: `Placeholders: ${['items', 'issueKey', 'summary', 'diff', 'date', 'datetime', 'workspace']
              .map((name) => `{{${name}}}`)
              .join(', ')}`,
            errors,
            control: `<textarea id="promptText" name="promptText" rows="8"${
              errors.prompt ? ' aria-invalid="true" aria-describedby="prompt-error"' : ''
            }>${escapeHtml(draft.promptText ?? '')}</textarea>`,
          })
        : field({
            id: 'promptFile',
            label: 'Prompt file',
            errors,
            control: `<div class="row-inline">
              ${textInput({ id: 'promptFile', value: draft.promptFile, placeholder: '.github/prompts/triage.md', errors })}
              <button type="button" data-command="pickPromptFile">Choose…</button>
            </div>`,
          })
    }
  </section>`;
}

function modelSection(model: AgentFormViewModel): string {
  const { draft, errors, context } = model;
  const whitelistNote =
    draft.tools.includes('runScript') && context.emptyScriptWhitelist
      ? `<p class="warning">runScript is on, but the script whitelist is empty, so it refuses every command.</p>`
      : '';

  return `<section>
    <h2>Model and tools</h2>
    ${field({
      id: 'modelId',
      label: 'Model',
      errorKey: 'model',
      errors,
      control:
        context.models.length > 0
          ? select({
              id: 'modelId',
              value: draft.modelId,
              entries: context.models.map((entry) => ({
                value: entry.id,
                label: entry.name || entry.id,
                description: entry.vendor,
              })),
              errors,
            })
          : `<p class="warning">No models are known yet. Run Check Setup to ask the editor for one.</p>`,
    })}
    <div class="field">
      <span class="label-text" id="tools-label">Tools</span>
      <div class="checks" role="group" aria-labelledby="tools-label">
        ${context.tools
          .map((tool) => checkbox(`tool:${tool.name}`, tool.name, draft.tools.includes(tool.name)))
          .join('')}
      </div>
      ${whitelistNote}
    </div>
  </section>`;
}

function scheduleSection(model: AgentFormViewModel): string {
  const { draft, errors } = model;
  return `<section>
    <h2>Schedule</h2>
    ${field({
      id: 'schedule',
      label: 'Cron expression',
      hint: 'Several may be separated by a semicolon.',
      errors,
      control: textInput({
        id: 'schedule',
        value: (draft.schedule ?? []).join('; '),
        placeholder: '0 9 * * *',
        errors,
      }),
    })}
    ${model.schedulePreview ? `<p class="preview">${escapeHtml(model.schedulePreview)}</p>` : ''}
  </section>`;
}

function advancedSection(model: AgentFormViewModel): string {
  const { draft, errors } = model;
  return `<details>
    <summary>Advanced</summary>
    ${field({
      id: 'timezone',
      label: 'Time zone',
      hint: 'Empty means the setting, and then the system zone.',
      errors,
      control: textInput({ id: 'timezone', value: draft.timezone, placeholder: 'Europe/Berlin', errors }),
    })}
    <div class="field">
      ${checkbox('runOnStartup', 'Run when the editor starts', draft.runOnStartup)}
    </div>
    <div class="field">
      <label for="missedRunPolicy">If a run was missed</label>
      ${select({
        id: 'missedRunPolicy',
        value: draft.missedRunPolicy,
        entries: [
          { value: 'skip', label: 'Skip it' },
          { value: 'runOnce', label: 'Run it once, late' },
        ],
        errors,
      })}
    </div>
    ${field({
      id: 'maxExecutionsPerDay',
      label: 'Daily limit',
      hint: 'Stricter than the global setting. Empty means the global one.',
      errors,
      control: `<input type="number" id="maxExecutionsPerDay" name="maxExecutionsPerDay" min="1" value="${escapeHtml(
        draft.maxExecutionsPerDay === undefined ? '' : String(draft.maxExecutionsPerDay),
      )}" />`,
    })}
    ${field({
      id: 'allowedTimeStart',
      label: 'Only between',
      errorKey: 'window',
      errors,
      control: `<div class="row-inline">
        <input type="text" id="allowedTimeStart" name="allowedTimeStart" value="${escapeHtml(
          draft.allowedTimeStart ?? '',
        )}" placeholder="09:00" />
        <span>and</span>
        <input type="text" id="allowedTimeEnd" name="allowedTimeEnd" value="${escapeHtml(
          draft.allowedTimeEnd ?? '',
        )}" placeholder="18:00" />
      </div>`,
    })}
    ${field({
      id: 'outputFolder',
      label: 'Result folder',
      hint: `Empty writes to ${model.outputFolder}`,
      errors,
      control: textInput({ id: 'outputFolder', value: draft.outputFolder, errors }),
    })}
  </details>`;
}

function runsSection(model: AgentFormViewModel): string {
  if (!model.runs) {
    return '';
  }
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

/** The body of the form, without the document around it. Kept separate so a repaint is cheap. */
export function renderAgentForm(model: AgentFormViewModel): string {
  const editing = model.context.editing;
  const title = editing ? escapeHtml(editing.name) : 'New agent';
  let summary = '';
  if (editing) {
    summary =
      editing.source.kind === 'git'
        ? formatRepository(editing.source.project, editing.source.repo)
        : editing.source.jql;
  }

  return `<h1>${title}</h1>
${summary ? `<p class="muted-text">${escapeHtml(summary)}</p>` : ''}
${model.notReady ? `<p class="warning">${escapeHtml(model.notReady)}</p>` : ''}
<form id="agent-form" novalidate>
  ${identitySection(model)}
  ${sourceSection(model)}
  ${promptSection(model)}
  ${modelSection(model)}
  ${scheduleSection(model)}
  ${advancedSection(model)}
</form>
${runsSection(model)}
<div class="actions">
  <button type="button" data-command="save" id="save"${model.canSave ? '' : ' disabled'}>Save</button>
  <button type="button" data-command="run">Run Now</button>
  ${editing ? '<button type="button" data-command="openFolder">Open Result Folder</button>' : ''}
  ${editing ? '<button type="button" class="danger" data-command="delete">Delete Agent</button>' : ''}
</div>`;
}
