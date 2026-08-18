import * as vscode from 'vscode';

import type { ServiceContainer } from '../../container.js';
import { mapModelError } from '../../model/errors.js';
import { describeModel } from '../../model/gateway.js';
import { describeCron, minIntervalMinutes } from '../../scheduler/cron.js';
import { userAction } from '../../setup/consentGate.js';
import { addConnection } from '../../setup/endpointEditor.js';
import type { Agent, PersistedState } from '../../state/types.js';

import {
  agentToDraft,
  draftToAgent,
  endpointsForKind,
  splitSchedule,
  validateAgentName,
  validateJql,
  validateMaxResults,
  validatePromptText,
  validateProject,
  validateRepo,
  describeScheduleInput,
  validateTimeWindow,
  validateTimeZoneInput,
} from './steps.js';
import { resolveProvider, tokenFor } from '../../connectors/factory.js';
import { formatRepository, sourceVocabulary } from '../../agents/sourceLabels.js';
import { createVscodeFileFinder } from '../../tools/vscodeFileFinder.js';

import type { AgentDraft } from './steps.js';
import { describeCandidate, discoverPromptFiles } from './promptFiles.js';
import type { PromptFileCandidate } from './promptFiles.js';

/** A step the user cancelled out of. */
const CANCELLED = Symbol('cancelled');

type StepResult<T> = T | typeof CANCELLED;

function cancelled<T>(value: StepResult<T>): value is typeof CANCELLED {
  return value === CANCELLED;
}

async function ask<T>(promise: Thenable<T | undefined>): Promise<StepResult<T>> {
  const value = await promise;
  return value === undefined ? CANCELLED : value;
}

/**
 * Creates or edits an agent.
 *
 * Linear on creation and a field list on edit, because those are different jobs: setting an agent up
 * means answering every question once, while changing one means finding that one thing again.
 */
export async function agentWizard(
  container: ServiceContainer,
  existing?: Agent,
): Promise<Agent | undefined> {
  const state = await container.store.read();
  const draft: AgentDraft = existing
    ? agentToDraft(existing)
    : {
        name: '',
        executionMode: 'api',
        sourceKind: 'jira',
        endpointName: '',
        promptSource: 'inline',
        modelId: '',
        tools: [],
        schedule: ['0 9 * * *'],
        runOnStartup: false,
        missedRunPolicy: 'skip',
      };

  if (existing) {
    const field = await pickField(draft);
    if (cancelled(field)) {
      return undefined;
    }
    if (!(await editField(container, state, draft, field, existing.id))) {
      return undefined;
    }
  } else {
    if (!(await runFullFlow(container, state, draft))) {
      return undefined;
    }
  }

  const agent = draftToAgent(draft, new Date(), existing);
  await container.store.update((update) => {
    const index = update.agents.findIndex((candidate) => candidate.id === agent.id);
    if (index >= 0) {
      update.agents[index] = agent;
    } else {
      update.agents.push(agent);
    }
  });
  container.logger.info(`${existing ? 'Updated' : 'Created'} the agent "${agent.name}".`);
  return agent;
}

type Field =
  | 'name'
  | 'mode'
  | 'source'
  | 'prompt'
  | 'model'
  | 'tools'
  | 'schedule'
  | 'timezone'
  | 'startup'
  | 'limits'
  | 'outputFolder';

async function pickField(draft: AgentDraft): Promise<StepResult<Field>> {
  const items: { label: string; detail?: string; field: Field }[] = [
    { label: 'Name', detail: draft.name, field: 'name' },
    {
      label: 'Execution mode',
      detail: draft.executionMode === 'api' ? 'result captured' : 'handed to chat',
      field: 'mode',
    },
    {
      label: 'Source',
      detail:
        draft.sourceKind === 'jira'
          ? draft.jql
          : `${formatRepository(draft.project ?? '', draft.repo ?? '')} (${draft.gitMode ?? ''})`,
      field: 'source',
    },
    {
      label: 'Prompt',
      detail: draft.promptSource === 'inline' ? 'written here' : draft.promptFile,
      field: 'prompt',
    },
    { label: 'Model', detail: draft.modelId, field: 'model' },
    { label: 'Tools', detail: draft.tools.join(', ') || 'none', field: 'tools' },
    { label: 'Schedule', detail: describeCron(draft.schedule), field: 'schedule' },
    { label: 'Time zone', detail: draft.timezone ?? 'the setting, or the system zone', field: 'timezone' },
    {
      label: 'Start-up and missed runs',
      detail: `${draft.runOnStartup ? 'runs on start-up' : 'does not run on start-up'}, missed: ${draft.missedRunPolicy}`,
      field: 'startup',
    },
    {
      label: 'Limits and time window',
      detail:
        [
          draft.maxExecutionsPerDay ? `${draft.maxExecutionsPerDay} run(s) per day` : undefined,
          draft.allowedTimeStart && draft.allowedTimeEnd
            ? `only ${draft.allowedTimeStart} to ${draft.allowedTimeEnd}`
            : undefined,
        ]
          .filter(Boolean)
          .join(', ') || 'no extra limits',
      field: 'limits',
    },
    {
      label: 'Result folder',
      detail: draft.outputFolder ?? 'the default folder',
      field: 'outputFolder',
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'What would you like to change?',
    ignoreFocusOut: true,
  });
  return picked ? picked.field : CANCELLED;
}

async function editField(
  container: ServiceContainer,
  state: PersistedState,
  draft: AgentDraft,
  field: Field,
  currentId?: string,
): Promise<boolean> {
  switch (field) {
    case 'name':
      return askName(state, draft, currentId);
    case 'mode':
      return askMode(draft);
    case 'source':
      return askSource(container, draft);
    case 'prompt':
      return askPrompt(draft);
    case 'model':
      return askModel(container, draft);
    case 'tools':
      return askTools(container, draft);
    case 'schedule':
      return askSchedule(container, draft);
    case 'timezone':
      return askTimeZone(draft);
    case 'startup':
      return askStartupBehaviour(draft);
    case 'limits':
      return askLimits(draft);
    case 'outputFolder':
      return askOutputFolder(draft);
  }
}

async function runFullFlow(
  container: ServiceContainer,
  state: PersistedState,
  draft: AgentDraft,
): Promise<boolean> {
  const steps = [
    () => askName(state, draft),
    () => askMode(draft),
    () => askSource(container, draft),
    () => askPrompt(draft),
    () => askModel(container, draft),
    () => askTools(container, draft),
    () => askSchedule(container, draft),
  ];
  for (const step of steps) {
    if (!(await step())) {
      return false;
    }
  }

  // The optional settings are offered from the confirmation rather than asked for on the way: the
  // default answer to every one of them is right for most agents, and the review is where somebody
  // notices they want something else.
  for (;;) {
    const decision = await confirm(draft);
    if (decision === 'create') {
      return true;
    }
    if (decision === 'cancel') {
      return false;
    }
    await askAdvanced(container, draft);
  }
}

async function askName(
  state: PersistedState,
  draft: AgentDraft,
  currentId?: string,
): Promise<boolean> {
  const value = await ask(
    vscode.window.showInputBox({
      title: 'Name of the agent',
      value: draft.name,
      ignoreFocusOut: true,
      // The agent being edited must not clash with its own stored name.
      validateInput: (input) => validateAgentName(input, state.agents, currentId),
    }),
  );
  if (cancelled(value)) {
    return false;
  }
  draft.name = value.trim();
  return true;
}

async function askMode(draft: AgentDraft): Promise<boolean> {
  const picked = await ask(
    vscode.window.showQuickPick(
      [
        {
          label: 'Run and store the result',
          detail: 'Rounds calls the model itself and writes the answer to a file.',
          value: 'api' as const,
        },
        {
          label: 'Open the prompt in chat for review',
          detail: 'Rounds fills the chat input and stops there; it never sees the answer.',
          value: 'chat' as const,
        },
      ],
      { title: 'How should this agent run?', ignoreFocusOut: true },
    ),
  );
  if (cancelled(picked)) {
    return false;
  }
  draft.executionMode = picked.value;
  return true;
}

async function askSource(container: ServiceContainer, draft: AgentDraft): Promise<boolean> {
  const kind = await ask(
    vscode.window.showQuickPick(
      [
        { label: 'Issue tracker', detail: 'Issues matching a search query', value: 'jira' as const },
        { label: 'Repository host', detail: 'Pull requests in a repository', value: 'git' as const },
      ],
      { title: 'What should this agent look at?', ignoreFocusOut: true },
    ),
  );
  if (cancelled(kind)) {
    return false;
  }
  draft.sourceKind = kind.value;

  let state = await container.store.read();
  let endpoints = endpointsForKind(state, draft.sourceKind);
  if (endpoints.length === 0) {
    // The token belongs to this decision, not to a separate errand somewhere else.
    const added = await addConnection(container.store, container.secrets, draft.sourceKind);
    if (!added) {
      return false;
    }
    state = await container.store.reload();
    endpoints = endpointsForKind(state, draft.sourceKind);
  }

  const endpoint =
    endpoints.length === 1
      ? endpoints[0]
      : await ask(
          vscode.window.showQuickPick(endpoints, {
            title: 'Which connection should it use?',
            ignoreFocusOut: true,
          }),
        );
  if (endpoint === undefined || cancelled(endpoint)) {
    return false;
  }
  draft.endpointName = endpoint;

  const chosen = state.endpoints[draft.endpointName];
  if (chosen && !(await tokenFor(container.secrets, chosen))) {
    // Per connection: two repository hosts hold two tokens, so "the git token exists" is not an
    // answer to "can this connection authenticate".
    const token = await vscode.window.showInputBox({
      title: `Token for "${chosen.name}"`,
      prompt: 'Stored in the editor secret storage, never in settings or in a result file.',
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim().length === 0 ? 'Enter a token.' : undefined),
    });
    if (!token || !chosen.secretRef) {
      return false;
    }
    await container.secrets.setForConnection(chosen.secretRef, token.trim());
  }

  if (draft.sourceKind === 'jira') {
    const jql = await ask(
      vscode.window.showInputBox({
        title: 'Search query for the issues to collect',
        value: draft.jql ?? '',
        placeHolder: 'project = ROUNDS AND status != Done',
        ignoreFocusOut: true,
        validateInput: validateJql,
      }),
    );
    if (cancelled(jql)) {
      return false;
    }
    draft.jql = jql.trim();

    const maxResults = await ask(
      vscode.window.showInputBox({
        title: 'How many issues at most?',
        value: String(draft.maxResults ?? 20),
        ignoreFocusOut: true,
        validateInput: validateMaxResults,
      }),
    );
    if (cancelled(maxResults)) {
      return false;
    }
    draft.maxResults = Number.parseInt(maxResults, 10);
    return true;
  }

  // Which word this host uses decides the label: "owner" is right for one provider out of three.
  const connection = state.endpoints[draft.endpointName];
  const provider = connection ? resolveProvider(connection) : 'github';
  const vocabulary = sourceVocabulary(provider);

  const project = await ask(
    vscode.window.showInputBox({
      title: vocabulary.project,
      prompt: vocabulary.hint,
      value: draft.project ?? '',
      placeHolder: vocabulary.example,
      ignoreFocusOut: true,
      validateInput: (input) => validateProject(input, provider),
    }),
  );
  if (cancelled(project)) {
    return false;
  }
  draft.project = project.trim();

  const repo = await ask(
    vscode.window.showInputBox({
      title: 'Repository',
      value: draft.repo ?? '',
      placeHolder: 'rounds',
      ignoreFocusOut: true,
      validateInput: validateRepo,
    }),
  );
  if (cancelled(repo)) {
    return false;
  }
  draft.repo = repo.trim();

  const mode = await ask(
    vscode.window.showQuickPick(
      [
        { label: 'Pull requests opened since the last run', value: 'newPullRequests' as const },
        { label: 'Pull requests changed since the last run', value: 'updatedPullRequests' as const },
      ],
      { title: 'Which pull requests?', ignoreFocusOut: true },
    ),
  );
  if (cancelled(mode)) {
    return false;
  }
  draft.gitMode = mode.value;
  return true;
}

async function askPrompt(draft: AgentDraft): Promise<boolean> {
  const source = await ask(
    vscode.window.showQuickPick(
      [
        { label: 'Write the prompt here', value: 'inline' as const },
        { label: 'Use a file in the workspace', value: 'file' as const },
      ],
      { title: 'Where does the prompt come from?', ignoreFocusOut: true },
    ),
  );
  if (cancelled(source)) {
    return false;
  }

  if (source.value === 'file') {
    const file = await pickPromptFile();
    if (!file) {
      return false;
    }
    draft.promptSource = 'file';
    draft.promptFile = file;
    return true;
  }

  const text = await editPromptText(
    draft.promptText ?? 'Summarize {{items}} and list what needs attention.',
  );
  if (text === undefined) {
    return false;
  }
  draft.promptSource = 'inline';
  draft.promptText = text;
  return true;
}

/**
 * Offers the prompt files the workspace already has, with Browse… still available.
 *
 * Typing or hunting for a path was the whole interaction before; a repository that keeps its
 * prompts in `.github/prompts` should not make somebody find them again by hand.
 */
async function pickPromptFile(): Promise<string | undefined> {
  const candidates = await discoverPromptFiles(createVscodeFileFinder());
  const browse = { label: '$(folder-opened) Browse…', detail: 'Choose any file on disk', browse: true };
  const items: (vscode.QuickPickItem & { candidate?: PromptFileCandidate; browse?: boolean })[] = [
    ...candidates.map((candidate) => {
      const described = describeCandidate(candidate);
      return { label: described.label, detail: described.detail, candidate };
    }),
    browse,
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: candidates.length > 0 ? 'Prompt file' : 'No prompt files found in the workspace',
    placeHolder: 'Files under .github/prompts come first',
    ignoreFocusOut: true,
    matchOnDetail: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.candidate) {
    const [folder] = vscode.workspace.workspaceFolders ?? [];
    return folder
      ? vscode.Uri.joinPath(folder.uri, picked.candidate.path).fsPath
      : picked.candidate.path;
  }

  const chosen = await vscode.window.showOpenDialog({
    title: 'Choose the prompt file',
    canSelectMany: false,
    filters: { Markdown: ['md', 'txt', 'prompt'] },
  });
  return chosen?.[0]?.fsPath;
}

/**
 * Writes a prompt in a real editor rather than in a one-line box.
 *
 * Phase 10 specified a scratch document and the implementation used `showInputBox`, which is
 * where a fifteen-line prompt goes to die. The document is untitled and never saved; closing it
 * takes the text, and a validation failure reopens it with the text intact rather than throwing
 * the work away.
 */
async function editPromptText(initial: string): Promise<string | undefined> {
  let text = initial;
  for (;;) {
    const document = await vscode.workspace.openTextDocument({
      content: text,
      language: 'markdown',
    });
    const editor = await vscode.window.showTextDocument(document, { preview: false });

    const confirmed = await vscode.window.showInformationMessage(
      'Write the prompt in the editor, then choose Use this prompt. Placeholders: {{items}}, {{issueKey}}, {{summary}}, {{diff}}, {{date}}, {{datetime}}, {{workspace}}',
      { modal: true },
      'Use this prompt',
    );
    text = editor.document.getText();
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    if (confirmed !== 'Use this prompt') {
      return undefined;
    }

    const problem = validatePromptText(text);
    if (!problem) {
      return text;
    }
    const retry = await vscode.window.showWarningMessage(problem, { modal: true }, 'Edit again');
    if (retry !== 'Edit again') {
      return undefined;
    }
  }
}

/**
 * Asks which model to use, resolving the list at this exact moment.
 *
 * This is a user-initiated action, which is what makes the consent prompt legitimate here — and the
 * reason model names are never hardcoded: whatever the provider offers today is what the list shows.
 */
async function askModel(container: ServiceContainer, draft: AgentDraft): Promise<boolean> {
  let models;
  try {
    models = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Rounds: resolving models',
        cancellable: true,
      },
      (_progress, token) =>
        container.models.list(userAction('agent wizard: choose a model'), {
          waitForProviderMs: 15_000,
          isCancelled: () => token.isCancellationRequested,
        }),
    );
  } catch (error) {
    const mapped = mapModelError(error);
    container.logger.error(`Could not resolve models: ${mapped.detail}`);
    await vscode.window.showErrorMessage(mapped.message);
    return false;
  }

  if (models.length === 0) {
    await vscode.window.showErrorMessage(
      'No language models are available. Install and sign in to a language model provider, such as GitHub Copilot, and try again.',
    );
    return false;
  }

  const picked = await ask(
    vscode.window.showQuickPick(
      models.map((model) => {
        const described = describeModel(model);
        return {
          label: described.label,
          description: model.id === draft.modelId ? 'current' : undefined,
          detail: described.detail,
          id: model.id,
        };
      }),
      { title: 'Which model should this agent use?', ignoreFocusOut: true },
    ),
  );
  if (cancelled(picked)) {
    return false;
  }
  draft.modelId = picked.id;
  return true;
}

async function askTools(container: ServiceContainer, draft: AgentDraft): Promise<boolean> {
  const whitelistEmpty = container.settings().scriptWhitelist.length === 0;
  const picked = await vscode.window.showQuickPick(
    container.tools.list().map((tool) => ({
      label: tool.name,
      detail:
        tool.name === 'runScript' && whitelistEmpty
          ? `${tool.description} The whitelist is empty, so it will refuse every command until you add one.`
          : tool.description,
      picked: draft.tools.includes(tool.name),
    })),
    {
      title: 'Which tools may this agent use? (optional)',
      canPickMany: true,
      ignoreFocusOut: true,
    },
  );
  if (!picked) {
    return false;
  }
  draft.tools = picked.map((item) => item.label);
  return true;
}

async function askTimeZone(draft: AgentDraft): Promise<boolean> {
  const timezone = await ask(
    vscode.window.showInputBox({
      title: 'Time zone for this schedule',
      value: draft.timezone ?? '',
      placeHolder: 'Europe/Berlin — leave empty to use the setting or the system zone',
      ignoreFocusOut: true,
      validateInput: validateTimeZoneInput,
    }),
  );
  if (cancelled(timezone)) {
    return false;
  }
  draft.timezone = timezone.trim().length > 0 ? timezone.trim() : undefined;
  return true;
}

async function askSchedule(container: ServiceContainer, draft: AgentDraft): Promise<boolean> {
  const schedule = await ask(
    vscode.window.showInputBox({
      title: 'Schedule',
      value: draft.schedule.join('; '),
      prompt: 'A cron expression, or several separated by a semicolon. For example: 0 9 * * *',
      ignoreFocusOut: true,
      // The box carries both halves: the error while the expression is wrong, and once it is
      // right, what it means and when it fires next. A schedule confirmed only by firing hours
      // later is a schedule nobody can check.
      validateInput: (input) => {
        const feedback = describeScheduleInput(input, { timeZone: draft.timezone });
        return feedback.kind === 'error'
          ? { message: feedback.message, severity: vscode.InputBoxValidationSeverity.Error }
          : { message: feedback.message, severity: vscode.InputBoxValidationSeverity.Info };
      },
    }),
  );
  if (cancelled(schedule)) {
    return false;
  }
  draft.schedule = splitSchedule(schedule);

  const interval = minIntervalMinutes(draft.schedule, new Date(), draft.timezone);
  const threshold = container.settings().minimumIntervalWarning;
  if (interval !== undefined && interval < threshold) {
    const choice = await vscode.window.showWarningMessage(
      `${describeCron(draft.schedule)} runs every ${interval} minute(s). Frequent automated requests can get your model provider account rate limited.`,
      { modal: true },
      'Use it anyway',
    );
    if (choice !== 'Use it anyway') {
      return false;
    }
  }

  return true;
}

/**
 * The questions with a sensible default, asked only when somebody goes looking for them.
 *
 * Creation asks what an agent cannot work without. Everything here — the time zone, the start-up and
 * missed-run behaviour, a stricter daily limit, a time window, a folder of its own — has a default
 * that is right for most agents, and eleven modal prompts in a row is a worse way to learn that than
 * a field list you open when you need it.
 */
async function askAdvanced(container: ServiceContainer, draft: AgentDraft): Promise<boolean> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Time zone', detail: draft.timezone ?? 'the setting, or the system zone', value: 'timezone' as const },
      {
        label: 'Behaviour around start-up',
        detail: `${draft.runOnStartup ? 'runs on start-up' : 'does not run on start-up'}, missed runs: ${draft.missedRunPolicy === 'skip' ? 'skipped' : 'caught up once'}`,
        value: 'startup' as const,
      },
      {
        label: 'Limits and time window',
        detail:
          [
            draft.maxExecutionsPerDay ? `${draft.maxExecutionsPerDay} run(s) per day` : undefined,
            draft.allowedTimeStart && draft.allowedTimeEnd
              ? `only ${draft.allowedTimeStart} to ${draft.allowedTimeEnd}`
              : undefined,
          ]
            .filter(Boolean)
            .join(', ') || 'the global limit, any time of day',
        value: 'limits' as const,
      },
      { label: 'Result folder', detail: draft.outputFolder ?? 'the default folder', value: 'outputFolder' as const },
    ],
    { title: 'Which optional setting would you like to change?', ignoreFocusOut: true },
  );
  if (!picked) {
    return false;
  }
  switch (picked.value) {
    case 'timezone':
      return askTimeZone(draft);
    case 'startup':
      return askStartupBehaviour(draft);
    case 'limits':
      return askLimits(draft);
    case 'outputFolder':
      return askOutputFolder(draft);
  }
  void container;
  return true;
}

async function askStartupBehaviour(draft: AgentDraft): Promise<boolean> {
  const startup = await ask(
    vscode.window.showQuickPick(
      [
        { label: 'No', detail: 'Only run on schedule.', value: false },
        { label: 'Yes', detail: 'Also run shortly after the editor starts.', value: true },
      ],
      { title: 'Run once when the editor starts?', ignoreFocusOut: true },
    ),
  );
  if (cancelled(startup)) {
    return false;
  }
  draft.runOnStartup = startup.value;

  const missed = await ask(
    vscode.window.showQuickPick(
      [
        { label: 'Skip it', detail: 'Wait for the next scheduled time.', value: 'skip' as const },
        { label: 'Run it once', detail: 'Catch up with a single run.', value: 'runOnce' as const },
      ],
      { title: 'What if a run came due while the editor was closed?', ignoreFocusOut: true },
    ),
  );
  if (cancelled(missed)) {
    return false;
  }
  draft.missedRunPolicy = missed.value;
  return true;
}

async function askLimits(draft: AgentDraft): Promise<boolean> {
  const perDay = await ask(
    vscode.window.showInputBox({
      title: 'Limit this agent to how many runs per day? (optional)',
      value: draft.maxExecutionsPerDay ? String(draft.maxExecutionsPerDay) : '',
      placeHolder: 'Leave empty to use the global limit only',
      ignoreFocusOut: true,
      validateInput: (input) =>
        input.trim().length === 0 ? undefined : validateMaxResults(input),
    }),
  );
  if (cancelled(perDay)) {
    return false;
  }
  draft.maxExecutionsPerDay =
    perDay.trim().length > 0 ? Number.parseInt(perDay, 10) : undefined;

  const window = await ask(
    vscode.window.showInputBox({
      title: 'Only run between these times? (optional)',
      value:
        draft.allowedTimeStart && draft.allowedTimeEnd
          ? `${draft.allowedTimeStart}-${draft.allowedTimeEnd}`
          : '',
      placeHolder: '09:00-17:00 — leave empty to allow any time',
      ignoreFocusOut: true,
      validateInput: (input) => {
        if (input.trim().length === 0) {
          return undefined;
        }
        const [start = '', end = ''] = input.split('-');
        return validateTimeWindow(start, end);
      },
    }),
  );
  if (cancelled(window)) {
    return false;
  }
  if (window.trim().length === 0) {
    draft.allowedTimeStart = undefined;
    draft.allowedTimeEnd = undefined;
  } else {
    const [start = '', end = ''] = window.split('-');
    draft.allowedTimeStart = start.trim();
    draft.allowedTimeEnd = end.trim();
  }
  return true;
}

async function askOutputFolder(draft: AgentDraft): Promise<boolean> {
  const choice = await ask(
    vscode.window.showQuickPick(
      [
        { label: 'Use the default folder', value: 'default' as const },
        { label: 'Choose a folder for this agent', value: 'pick' as const },
      ],
      { title: 'Where should the results go?', ignoreFocusOut: true },
    ),
  );
  if (cancelled(choice)) {
    return false;
  }
  if (choice.value === 'default') {
    draft.outputFolder = undefined;
    return true;
  }
  const picked = await vscode.window.showOpenDialog({
    title: 'Folder for this agent',
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
  });
  const folder = picked?.[0];
  if (!folder) {
    return false;
  }
  draft.outputFolder = folder.fsPath;
  return true;
}

/** Last look before the agent is stored. */
async function confirm(draft: AgentDraft): Promise<'create' | 'advanced' | 'cancel'> {
  const lines = [
    `Mode: ${draft.executionMode === 'api' ? 'run and store the result' : 'open the prompt in chat'}`,
    `Source: ${draft.sourceKind === 'jira' ? `${draft.endpointName}, query ${draft.jql ?? ''}` : `${draft.endpointName}, ${formatRepository(draft.project ?? '', draft.repo ?? '')}`}`,
    `Prompt: ${draft.promptSource === 'inline' ? 'written here' : draft.promptFile ?? ''}`,
    `Model: ${draft.modelId}`,
    `Tools: ${draft.tools.join(', ') || 'none'}`,
    `Schedule: ${describeCron(draft.schedule)}${draft.timezone ? ` (${draft.timezone})` : ''}`,
    `Runs on start-up: ${draft.runOnStartup ? 'yes' : 'no'}; missed runs: ${draft.missedRunPolicy === 'skip' ? 'skipped' : 'caught up once'}`,
    `Limits: ${draft.maxExecutionsPerDay ? `${draft.maxExecutionsPerDay} per day` : 'the global limit'}${draft.allowedTimeStart && draft.allowedTimeEnd ? `, only ${draft.allowedTimeStart} to ${draft.allowedTimeEnd}` : ''}`,
    `Results: ${draft.outputFolder ?? 'the default folder'}`,
  ];
  // A modal message, not a quick pick: a quick pick carries a filter box, and a filter box on a
  // confirmation reads as a field somebody is supposed to fill in.
  const choice = await vscode.window.showInformationMessage(
    `Create the agent "${draft.name}"?`,
    { modal: true, detail: lines.join('\n') },
    'Create',
    'Optional Settings',
  );
  if (choice === 'Create') {
    return 'create';
  }
  return choice === 'Optional Settings' ? 'advanced' : 'cancel';
}
