import * as assert from 'node:assert/strict';

import type { Agent } from '../../state/types.js';
import { emptyState } from '../../state/validate.js';
import {
  agentToDraft,
  deleteConfirmation,
  draftToAgent,
  duplicateAgent,
  endpointsForKind,
  splitSchedule,
  validateAgentName,
  validateJql,
  validateMaxResults,
  validatePromptText,
  validateRepo,
  validateScheduleInput,
  validateTimeWindow,
  validateTimeZoneInput,
} from '../../ui/wizard/steps.js';

const NOW = new Date('2026-08-17T09:00:00.000Z');

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

describe('wizard validation', () => {
  it('requires a name and rejects a duplicate', () => {
    const existing = [agent()];
    assert.match(validateAgentName('', existing) ?? '', /Enter a name/);
    assert.match(validateAgentName('Morning triage', existing) ?? '', /already exists/);
    assert.equal(validateAgentName('Evening triage', existing), undefined);
  });

  it('lets an agent keep its own name while being edited', () => {
    assert.equal(validateAgentName('Morning triage', [agent()], 'agent-1'), undefined);
  });

  it('rejects an absurdly long name', () => {
    assert.match(validateAgentName('x'.repeat(200), []) ?? '', /shorter/);
  });

  it('validates the result count', () => {
    assert.equal(validateMaxResults('20'), undefined);
    assert.match(validateMaxResults('many') ?? '', /whole number/);
    assert.match(validateMaxResults('20.5') ?? '', /whole number/);
    assert.match(validateMaxResults('0') ?? '', /between 1 and 200/);
    assert.match(validateMaxResults('500') ?? '', /between 1 and 200/);
  });

  it('validates a repository name', () => {
    assert.equal(validateRepo('octo/rounds'), undefined);
    // A project key and a personal project are both two segments, and both are valid there.
    assert.equal(validateRepo('ROUNDS/rounds'), undefined);
    assert.equal(validateRepo('~alex/rounds'), undefined);
    assert.match(validateRepo('rounds') ?? '', /owner and the repository/);
    assert.match(validateRepo('octo/rounds/extra') ?? '', /owner and the repository/);
  });

  it('requires a search query', () => {
    assert.match(validateJql('   ') ?? '', /Enter a search query/);
    assert.equal(validateJql('project = ROUNDS'), undefined);
  });

  it('rejects a prompt with an unknown placeholder', () => {
    assert.equal(validatePromptText('Summarize {{items}}'), undefined);
    assert.match(validatePromptText('Summarize {{issus}}') ?? '', /does not know/);
    assert.match(validatePromptText('   ') ?? '', /Write a prompt/);
  });

  it('rejects a prompt that mixes per-item and batch placeholders', () => {
    assert.match(validatePromptText('{{issueKey}} in {{items}}') ?? '', /mixes placeholders/);
  });

  it('validates one or several schedules', () => {
    assert.equal(validateScheduleInput('0 9 * * *'), undefined);
    assert.equal(validateScheduleInput('0 9 * * *; 0 18 * * 5'), undefined);
    assert.match(validateScheduleInput('every morning') ?? '', /not a valid schedule/);
    assert.match(validateScheduleInput('  ') ?? '', /Enter a schedule/);
  });

  it('splits several schedules and ignores empty parts', () => {
    assert.deepEqual(splitSchedule(' 0 9 * * * ; ; 0 18 * * 5 '), ['0 9 * * *', '0 18 * * 5']);
  });

  it('validates a time window as a pair', () => {
    assert.equal(validateTimeWindow('', ''), undefined);
    assert.equal(validateTimeWindow('09:00', '17:00'), undefined);
    assert.match(validateTimeWindow('09:00', '') ?? '', /both ends/);
    assert.match(validateTimeWindow('nine', 'five') ?? '', /both ends/);
  });

  it('validates a time zone name', () => {
    assert.equal(validateTimeZoneInput(''), undefined);
    assert.equal(validateTimeZoneInput('Europe/Berlin'), undefined);
    assert.match(validateTimeZoneInput('Mars/Olympus') ?? '', /IANA time zone/);
  });
});

describe('draft conversion', () => {
  it('builds a new agent from a draft', () => {
    const built = draftToAgent(
      {
        name: '  Evening triage  ',
        executionMode: 'chat',
        sourceKind: 'git',
        endpointName: 'repos',
        repo: 'octo/rounds',
        gitMode: 'updatedPullRequests',
        promptSource: 'inline',
        promptText: 'Summarize {{items}}',
        modelId: 'model-b',
        tools: ['listFiles'],
        schedule: ['0 18 * * *'],
        runOnStartup: true,
        missedRunPolicy: 'runOnce',
      },
      NOW,
    );

    assert.equal(built.name, 'Evening triage');
    assert.equal(built.enabled, true);
    assert.equal(built.executionMode, 'chat');
    assert.equal(built.source.kind, 'git');
    assert.equal(built.createdAt, NOW.toISOString());
    assert.ok(built.id.length > 0);
  });

  it('keeps identity, history and enabled state when editing', () => {
    const existing = agent({ enabled: false, lastRunAt: '2026-08-16T09:00:00.000Z' });
    const built = draftToAgent({ ...agentToDraft(existing), name: 'Renamed' }, NOW, existing);

    assert.equal(built.id, existing.id);
    assert.equal(built.enabled, false);
    assert.equal(built.lastRunAt, existing.lastRunAt);
    assert.equal(built.createdAt, existing.createdAt);
    assert.equal(built.updatedAt, NOW.toISOString());
    assert.equal(built.name, 'Renamed');
  });

  it('keeps the repository cursor when the repository is unchanged', () => {
    const existing = agent({
      source: {
        kind: 'git',
        baseUrlRef: 'repos',
        repo: 'octo/rounds',
        mode: 'newPullRequests',
        sinceCursor: '2026-08-16T00:00:00.000Z',
      },
    });
    const built = draftToAgent(agentToDraft(existing), NOW, existing);
    assert.equal(
      built.source.kind === 'git' ? built.source.sinceCursor : undefined,
      '2026-08-16T00:00:00.000Z',
    );
  });

  it('drops the cursor when the repository changed', () => {
    const existing = agent({
      source: {
        kind: 'git',
        baseUrlRef: 'repos',
        repo: 'octo/rounds',
        mode: 'newPullRequests',
        sinceCursor: '2026-08-16T00:00:00.000Z',
      },
    });
    const built = draftToAgent(
      { ...agentToDraft(existing), repo: 'octo/other' },
      NOW,
      existing,
    );
    // Keeping it would skip everything the new repository changed before now.
    assert.equal(built.source.kind === 'git' ? built.source.sinceCursor : 'kept', undefined);
  });

  it('keeps the prompt snapshot only while the file is the same', () => {
    const existing = agent({
      prompt: {
        source: 'file',
        filePath: '/workspace/prompt.md',
        snapshot: { content: 'text', hash: 'abc', capturedAt: '2026-08-10T00:00:00.000Z' },
      },
    });

    const unchanged = draftToAgent(agentToDraft(existing), NOW, existing);
    assert.equal(unchanged.prompt.snapshot?.hash, 'abc');

    const changed = draftToAgent(
      { ...agentToDraft(existing), promptFile: '/workspace/other.md' },
      NOW,
      existing,
    );
    assert.equal(changed.prompt.snapshot, undefined);
  });

  it('round-trips an agent through a draft', () => {
    const original = agent({ allowedTimeStart: '09:00', allowedTimeEnd: '17:00', maxExecutionsPerDay: 4 });
    const rebuilt = draftToAgent(agentToDraft(original), NOW, original);

    // Compared through JSON: the rebuilt agent carries explicit undefined values where the
    // original simply lacks the key, which is the same agent by any meaning that matters.
    assert.deepEqual(
      JSON.parse(JSON.stringify({ ...rebuilt, updatedAt: original.updatedAt })),
      JSON.parse(JSON.stringify(original)),
    );
  });
});

describe('duplicating an agent', () => {
  it('copies it disabled, with a fresh identity and no history of its own', () => {
    const original = agent({ lastRunAt: '2026-08-16T09:00:00.000Z', nextRunAt: '2026-08-18T09:00:00.000Z' });
    const copy = duplicateAgent(original, [original], NOW);

    assert.notEqual(copy.id, original.id);
    assert.equal(copy.name, 'Morning triage (copy)');
    assert.equal(copy.enabled, false, 'a copy must not double the original traffic unnoticed');
    assert.equal(copy.lastRunAt, undefined);
    assert.equal(copy.nextRunAt, undefined);
    assert.equal(copy.createdAt, NOW.toISOString());
  });

  it('numbers further copies', () => {
    const original = agent();
    const first = duplicateAgent(original, [original], NOW);
    const second = duplicateAgent(original, [original, first], NOW);
    assert.equal(second.name, 'Morning triage (copy 2)');
  });

  it('does not inherit the repository cursor', () => {
    const original = agent({
      source: {
        kind: 'git',
        baseUrlRef: 'repos',
        repo: 'octo/rounds',
        mode: 'newPullRequests',
        sinceCursor: '2026-08-16T00:00:00.000Z',
      },
    });
    const copy = duplicateAgent(original, [original], NOW);
    assert.equal(copy.source.kind === 'git' ? copy.source.sinceCursor : 'kept', undefined);
  });
});

describe('other wizard helpers', () => {
  it('lists the connections of one kind', () => {
    const state = emptyState('2026-08-17');
    state.endpoints = {
      tracker: { name: 'tracker', kind: 'jira', baseUrl: 'https://tracker.invalid', authScheme: 'bearer' },
      repos: { name: 'repos', kind: 'git', baseUrl: 'https://git.invalid', authScheme: 'bearer' },
    };

    assert.deepEqual(endpointsForKind(state, 'jira'), ['tracker']);
    assert.deepEqual(endpointsForKind(state, 'git'), ['repos']);
  });

  it('says what deleting an agent does and does not remove', () => {
    const text = deleteConfirmation(agent(), 7);
    assert.match(text, /"Morning triage"/);
    assert.match(text, /7 recorded run\(s\)/);
    assert.match(text, /Result files already written are kept/);
  });
});
