import * as assert from 'node:assert/strict';

import type { Agent } from '../../state/types.js';
import { renderAgentForm } from '../../ui/panel/agentFormContent.js';
import type { AgentFormViewModel } from '../../ui/panel/agentFormContent.js';
import {
  draftFromMessage,
  emptyDraft,
  panelUpdateKind,
  validateDraft,
} from '../../ui/panel/agentFormModel.js';
import type { FormContext } from '../../ui/panel/agentFormModel.js';
import { escapeHtml, renderDocument } from '../../ui/panel/agentPanelContent.js';
import { agentToDraft } from '../../ui/wizard/steps.js';

const OPTIONS = {
  title: 'Morning triage',
  nonce: 'abc123==',
  cspSource: 'vscode-resource://host',
  scriptUri: 'https://host/media/agentPanel.js',
};

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-1',
    name: 'Morning triage',
    enabled: true,
    executionMode: 'api',
    schedule: { cronExpressions: ['0 9 * * *'], runOnStartup: false, missedRunPolicy: 'skip' },
    source: { kind: 'jira', baseUrlRef: 'tracker', jql: 'project = ROUNDS', maxResults: 20 },
    prompt: { source: 'inline', inlineText: 'Summarize {{items}}' },
    modelId: 'model-a',
    tools: ['readFile'],
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function context(overrides: Partial<FormContext> = {}): FormContext {
  return {
    agents: [agent()],
    editing: agent(),
    connections: [
      { name: 'tracker', kind: 'jira', baseUrl: 'https://tracker.invalid', authScheme: 'basic' },
      { name: 'github', kind: 'git', baseUrl: 'https://github.com', authScheme: 'bearer' },
    ],
    models: [{ id: 'model-a', name: 'Model A', vendor: 'vendor', family: 'family' }],
    tools: [
      { name: 'readFile', description: 'reads a file' },
      { name: 'runScript', description: 'runs a command' },
    ],
    emptyScriptWhitelist: false,
    provider: 'github',
    ...overrides,
  };
}

function model(overrides: Partial<AgentFormViewModel> = {}): AgentFormViewModel {
  const formContext = overrides.context ?? context();
  return {
    draft: agentToDraft(formContext.editing ?? agent()),
    context: formContext,
    errors: {},
    canSave: false,
    outputFolder: '/storage/results',
    ...overrides,
  };
}

describe('the agent form', () => {
  it('renders every value the agent already has', () => {
    const html = renderAgentForm(model());

    assert.match(html, /value="Morning triage"/);
    assert.match(html, /value="project = ROUNDS"/);
    assert.match(html, /<option value="model-a" selected/);
    assert.match(html, /value="0 9 \* \* \*"/);
    assert.match(html, /id="tool:readFile"[^>]*checked/);
  });

  it('starts an empty form with defaults rather than blanks', () => {
    const formContext = context({ editing: undefined });
    const html = renderAgentForm(model({ context: formContext, draft: emptyDraft(formContext) }));

    assert.match(html, /<h1>New agent<\/h1>/);
    assert.match(html, /Summarize \{\{items\}\}/);
    // Nothing to delete or reveal yet.
    assert.ok(!html.includes('data-command="delete"'));
    assert.ok(!html.includes('data-command="openFolder"'));
  });

  it('keeps Save disabled until something changes', () => {
    assert.match(renderAgentForm(model()), /id="save" disabled/);
    assert.ok(!renderAgentForm(model({ canSave: true })).includes('id="save" disabled'));
  });

  it('labels the project field with the word the host uses', () => {
    const git = agent({
      source: { kind: 'git', baseUrlRef: 'github', project: 'octo', repo: 'rounds', mode: 'newPullRequests' },
    });

    const forGithub = renderAgentForm(
      model({ context: context({ editing: git, provider: 'github' }) }),
    );
    assert.match(forGithub, /<label for="project">Owner<\/label>/);

    const forServer = renderAgentForm(
      model({ context: context({ editing: git, provider: 'bitbucketServer' }) }),
    );
    assert.match(forServer, /<label for="project">Project key<\/label>/);
    assert.match(forServer, /~username/);
  });

  it('draws an error next to the field that produced it, and says which', () => {
    const html = renderAgentForm(model({ errors: { name: 'A name is required.' } }));

    assert.match(html, /aria-invalid="true" aria-describedby="name-error"/);
    assert.match(html, /id="name-error" role="alert">A name is required\./);
  });

  it('states the chat-mode limitation next to the choice, not in a tooltip', () => {
    const chat = agent({ executionMode: 'chat' });
    const html = renderAgentForm(model({ context: context({ editing: chat }) }));

    assert.match(html, /does not capture the answer/);
  });

  it('warns that runScript is inert while the whitelist is empty', () => {
    const withScript = agent({ tools: ['runScript'] });
    const html = renderAgentForm(
      model({ context: context({ editing: withScript, emptyScriptWhitelist: true }) }),
    );

    assert.match(html, /refuses every command/);
  });

  it('says what to do when there is no model to choose', () => {
    const html = renderAgentForm(model({ context: context({ models: [] }) }));
    assert.match(html, /Run Check Setup/);
  });

  it('escapes user content on its way into the document', () => {
    // The prompt is the one place in this extension where an injection is possible at all.
    const nasty = agent({
      name: 'Triage <img src=x onerror=alert(1)>',
      prompt: { source: 'inline', inlineText: '</textarea><script>alert("x")</script>' },
    });
    const html = renderAgentForm(model({ context: context({ editing: nasty, agents: [nasty] }) }));

    assert.ok(!html.includes('<img src=x'));
    assert.ok(!html.includes('<script>alert'));
    assert.match(html, /&lt;script&gt;alert/);
  });

  it('collapses the settings that used to make creation feel like an interrogation', () => {
    const html = renderAgentForm(model());
    assert.match(html, /<details>\s*<summary>Advanced<\/summary>/);
  });

  it('shows the schedule preview beside the expression', () => {
    const html = renderAgentForm(model({ schedulePreview: 'At 09:00. Next: tomorrow.' }));
    assert.match(html, /At 09:00\. Next: tomorrow\./);
  });

  it('gives every field and the preview a fixed place, so an update needs no repaint', () => {
    const html = renderAgentForm(model({ errors: { name: 'A name is required.' } }));

    // The script finds a field by the error it carries; without this it would have to rebuild
    // the form to show one, which is what cost the focus.
    assert.match(html, /data-error-key="name"/);
    assert.match(html, /data-error-key="schedule"/);
    assert.match(html, /<p class="preview" id="schedule-preview">/);
  });
});

describe('what a message from the form does to the document', () => {
  it('never repaints on a keystroke', () => {
    // The bug this pins: every keystroke rebuilt the whole document, which replaces the element
    // being typed into, so the field lost focus after one character and the rest went nowhere.
    assert.equal(panelUpdateKind('change'), 'patch');
    assert.equal(panelUpdateKind('touched'), 'patch');
  });

  it('repaints only when which fields exist has changed', () => {
    assert.equal(panelUpdateKind('reshape'), 'repaint');
    assert.equal(panelUpdateKind('pickPromptFile'), 'repaint');
  });

  it('treats the buttons as actions and anything else as unknown', () => {
    for (const type of ['save', 'run', 'openFolder', 'delete', 'open']) {
      assert.equal(panelUpdateKind(type), 'action', type);
    }
    assert.equal(panelUpdateKind('nonsense'), 'unknown');
    assert.equal(panelUpdateKind(undefined), 'unknown');
  });
});

describe('the document around the form', () => {
  it('forbids every remote origin and carries a nonce the script uses', () => {
    const html = renderDocument({ ...OPTIONS, body: '<p>body</p>' });

    assert.match(html, /default-src 'none'/);
    assert.match(html, /script-src 'nonce-abc123=='/);
    assert.match(html, /<script nonce="abc123=="/);
    assert.match(html, /<style nonce="abc123=="/);
    assert.ok(!/connect-src/.test(html), 'nothing widens the policy back out');
  });

  it('refuses a nonce that is not a nonce', () => {
    assert.throws(
      () => renderDocument({ ...OPTIONS, body: '', nonce: "x' src='evil" }),
      /base64/,
    );
  });

  it('escapes the characters that end an attribute or a tag', () => {
    assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });
});

describe('reading a draft back off the wire', () => {
  it('takes every value as the string the form sent', () => {
    const draft = draftFromMessage({
      name: '  Morning triage  ',
      enabled: 'true',
      sourceKind: 'git',
      endpointName: 'github',
      project: 'octo',
      repo: 'rounds',
      gitMode: 'updatedPullRequests',
      promptSource: 'inline',
      promptText: 'Summarize {{items}}',
      modelId: 'model-a',
      tools: ['readFile', 42],
      schedule: '0 9 * * *; 0 18 * * *',
      maxExecutionsPerDay: '5',
    });

    assert.equal(draft.name, 'Morning triage');
    assert.equal(draft.enabled, true);
    assert.equal(draft.sourceKind, 'git');
    assert.deepEqual(draft.schedule, ['0 9 * * *', '0 18 * * *']);
    assert.deepEqual(draft.tools, ['readFile'], 'anything that is not a tool name is dropped');
    assert.equal(draft.maxExecutionsPerDay, 5);
  });

  it('survives a message that is not a draft at all', () => {
    const draft = draftFromMessage(undefined);
    assert.equal(draft.name, '');
    assert.deepEqual(draft.schedule, []);
  });
});

describe('the rules the form applies', () => {
  it('accepts a draft that is complete', () => {
    assert.deepEqual(validateDraft(agentToDraft(agent()), context()), {});
  });

  it('reports each problem against its own field', () => {
    const draft = {
      ...agentToDraft(agent()),
      name: '',
      jql: '',
      modelId: '',
      schedule: ['not a cron expression'],
    };

    const errors = validateDraft(draft, context());

    assert.ok(errors.name);
    assert.ok(errors.jql);
    assert.ok(errors.model);
    assert.ok(errors.schedule);
  });

  it('applies the repository rules only to a repository source', () => {
    const git = {
      ...agentToDraft(agent()),
      sourceKind: 'git' as const,
      project: '',
      repo: 'octo/rounds',
    };
    const errors = validateDraft(git, context());

    assert.match(errors.project ?? '', /Enter the owner/);
    assert.match(errors.repo ?? '', /separate field/);
    assert.equal(errors.jql, undefined);
  });

  it('lets an agent keep its own name while it is being edited', () => {
    const errors = validateDraft(agentToDraft(agent()), context({ agents: [agent()] }));
    assert.equal(errors.name, undefined);
  });

  it('rejects a name another agent already has', () => {
    const other = agent({ id: 'agent-2', name: 'Release watch' });
    const draft = { ...agentToDraft(agent()), name: 'Release watch' };

    const errors = validateDraft(draft, context({ agents: [agent(), other] }));
    assert.ok(errors.name);
  });
});
