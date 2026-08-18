import * as assert from 'node:assert/strict';

import type { Agent } from '../../state/types.js';
import { escapeHtml, renderAgentPanel } from '../../ui/panel/agentPanelContent.js';
import type { AgentPanelViewModel } from '../../ui/panel/agentPanelContent.js';

const OPTIONS = { nonce: 'abc123==', cspSource: 'vscode-resource://host', scriptUri: 'https://host/media/agentPanel.js' };

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

function model(overrides: Partial<AgentPanelViewModel> = {}): AgentPanelViewModel {
  return {
    agent: agent(),
    schedule: 'At 09:00',
    timeZone: 'UTC',
    nextRuns: ['18/08/2026, 09:00:00', '19/08/2026, 09:00:00', '20/08/2026, 09:00:00'],
    placeholders: ['items'],
    outputFolder: '/storage/results',
    emptyScriptWhitelist: false,
    connection: { name: 'tracker', baseUrl: 'https://tracker.invalid', ready: true },
    runs: [],
    ...overrides,
  };
}

describe('agent panel content', () => {
  it('shows the agent, its schedule and what it reads', () => {
    const html = renderAgentPanel(model(), OPTIONS);

    assert.match(html, /<h1>Morning triage<\/h1>/);
    assert.match(html, /At 09:00/);
    assert.match(html, /18\/08\/2026, 09:00:00/);
    assert.match(html, /project = ROUNDS/);
    assert.match(html, /model-a/);
    assert.match(html, /readFile/);
    assert.match(html, /\/storage\/results/);
  });

  it('escapes user content on its way into the document', () => {
    // The prompt is the one place in this extension where an injection is possible at all.
    const html = renderAgentPanel(
      model({
        agent: agent({
          name: 'Triage <img src=x onerror=alert(1)>',
          prompt: { source: 'inline', inlineText: '</pre><script>alert("x")</script>' },
        }),
      }),
      OPTIONS,
    );

    assert.ok(!html.includes('<img src=x'), 'the name is escaped');
    assert.ok(!html.includes('<script>alert'), 'the prompt cannot open a tag');
    assert.match(html, /&lt;script&gt;alert/);
    // The only script element is the one the panel put there itself.
    assert.equal(html.match(/<script/g)?.length, 1);
  });

  it('escapes the characters that end an attribute or a tag', () => {
    assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  });

  it('forbids every remote origin and carries a nonce the script uses', () => {
    const html = renderAgentPanel(model(), OPTIONS);

    assert.match(html, /default-src 'none'/);
    assert.match(html, /script-src 'nonce-abc123=='/);
    assert.match(html, /<script nonce="abc123=="/);
    assert.match(html, /<style nonce="abc123=="/);
    assert.ok(!/connect-src/.test(html), 'nothing widens the policy back out');
  });

  it('refuses a nonce that is not a nonce', () => {
    assert.throws(
      () => renderAgentPanel(model(), { ...OPTIONS, nonce: "x' src='evil" }),
      /base64/,
    );
  });

  it('states the chat-mode limitation in the same words as the rest of the UI', () => {
    const html = renderAgentPanel(
      model({ agent: agent({ executionMode: 'chat' }) }),
      OPTIONS,
    );
    assert.match(html, /does not capture the answer/);
  });

  it('says why an agent cannot run, when it cannot', () => {
    const html = renderAgentPanel(model({ notReady: 'No token is stored for the tracker.' }), OPTIONS);
    assert.match(html, /No token is stored for the tracker\./);
  });

  it('warns that runScript is inert while the whitelist is empty', () => {
    const html = renderAgentPanel(model({ emptyScriptWhitelist: true }), OPTIONS);
    assert.match(html, /whitelist is empty/);
  });

  it('lists runs with what they cost and where they lead', () => {
    const html = renderAgentPanel(
      model({
        runs: [
          {
            id: 'run-1',
            status: 'succeeded',
            startedAt: '17/08/2026, 09:00:00',
            description: '12 items · 8.4 s — Two issues need attention.',
            target: 'file:///storage/results/triage.md',
          },
        ],
      }),
      OPTIONS,
    );

    assert.match(html, /12 items · 8\.4 s/);
    assert.match(html, /data-target="file:\/\/\/storage\/results\/triage\.md"/);
  });

  it('says there are no runs rather than showing an empty list', () => {
    assert.match(renderAgentPanel(model(), OPTIONS), /No runs yet\./);
  });

  it('offers the three actions and nothing that acts on its own', () => {
    const html = renderAgentPanel(model(), OPTIONS);

    assert.match(html, /data-command="run"/);
    assert.match(html, /data-command="edit"/);
    assert.match(html, /data-command="openFolder"/);
    assert.ok(!/onclick=/.test(html), 'no inline handlers: the CSP would refuse them anyway');
  });

  it('marks a connection with no token instead of implying it works', () => {
    const html = renderAgentPanel(
      model({ connection: { name: 'tracker', baseUrl: 'https://tracker.invalid', ready: false } }),
      OPTIONS,
    );
    assert.match(html, /no token/);
  });

  it('reports a prompt file that is being served from its snapshot', () => {
    const html = renderAgentPanel(
      model({
        agent: agent({
          prompt: {
            source: 'file',
            filePath: '/workspace/prompts/triage.md',
            snapshot: { content: 'Summarize {{items}}', hash: 'abc', capturedAt: '2026-08-01T00:00:00.000Z' },
          },
        }),
        promptFallback: 'showing the stored snapshot of the prompt file',
      }),
      OPTIONS,
    );

    assert.match(html, /triage\.md/);
    assert.match(html, /stored snapshot/);
  });
});
