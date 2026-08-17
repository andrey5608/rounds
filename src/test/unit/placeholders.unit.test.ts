import * as assert from 'node:assert/strict';

import {
  PromptValidationError,
  renderItem,
  renderPrompt,
  scanPlaceholders,
  validatePrompt,
} from '../../agents/placeholders.js';
import { LIMITS, truncate, truncateList } from '../../agents/truncate.js';
import type { SourceItem } from '../../connectors/items.js';

const NOW = new Date('2026-08-17T22:30:00.000Z');

function item(overrides: Partial<SourceItem> = {}): SourceItem {
  return {
    id: 'ROUNDS-1',
    title: 'Scheduler skips a run',
    url: 'https://tracker.invalid/browse/ROUNDS-1',
    updatedAt: '2026-08-17T09:30:00.000Z',
    body: 'The run is skipped after a restart.',
    extra: { status: 'In Progress', assignee: 'Alex Doe', empty: '' },
    ...overrides,
  };
}

describe('placeholder scanning', () => {
  it('reports the placeholders a prompt uses', () => {
    const scan = scanPlaceholders('On {{date}} review {{items}} carefully.');
    assert.deepEqual(scan.used.sort(), ['date', 'items']);
    assert.equal(scan.batch, true);
    assert.equal(scan.perItem, false);
  });

  it('recognises per-item prompts', () => {
    const scan = scanPlaceholders('Summarize {{issueKey}}: {{summary}}');
    assert.equal(scan.perItem, true);
    assert.equal(scan.batch, false);
  });

  it('tolerates whitespace inside the braces', () => {
    assert.deepEqual(scanPlaceholders('{{  items  }}').used, ['items']);
  });

  it('ignores an escaped placeholder', () => {
    const scan = scanPlaceholders('Write \\{{items}} to use the list placeholder.');
    assert.deepEqual(scan.used, []);
  });

  it('rejects an unknown placeholder and lists the supported ones', () => {
    assert.throws(() => scanPlaceholders('Hello {{issueKay}}'), (error: unknown) => {
      assert.ok(error instanceof PromptValidationError);
      assert.match(error.message, /\{\{issueKay\}\}/);
      assert.match(error.message, /\{\{issueKey\}\}/);
      return true;
    });
  });

  it('refuses to mix per-item and batch placeholders', () => {
    assert.throws(
      () => validatePrompt('Look at {{issueKey}} inside {{items}}'),
      /mixes placeholders about a single item/,
    );
  });

  it('accepts a prompt that uses neither kind', () => {
    const scan = validatePrompt('Report the state of the world on {{date}}.');
    assert.equal(scan.perItem, false);
    assert.equal(scan.batch, false);
  });
});

describe('prompt rendering', () => {
  it('fills in the item placeholders', () => {
    const result = renderPrompt('{{issueKey}} — {{summary}}', {
      item: item(),
      items: [item()],
      now: NOW,
      timeZone: 'UTC',
    });
    assert.equal(result.text, 'ROUNDS-1 — Scheduler skips a run');
  });

  it('says so instead of rendering nothing when there is no item', () => {
    const result = renderPrompt('{{issueKey}}', { items: [], now: NOW });
    assert.equal(result.text, '(no item)');
  });

  it('renders the item list as bullets with url, timestamp and extras', () => {
    const result = renderPrompt('{{items}}', { items: [item()], now: NOW });

    assert.match(result.text, /- \*\*ROUNDS-1\*\* Scheduler skips a run/);
    assert.match(result.text, /https:\/\/tracker\.invalid\/browse\/ROUNDS-1/);
    assert.match(result.text, /updated 2026-08-17T09:30:00\.000Z/);
    assert.match(result.text, /status: In Progress · assignee: Alex Doe/);
    assert.ok(!result.text.includes('empty:'), 'empty extras are left out');
  });

  it('says that nothing was found for an empty batch', () => {
    const result = renderPrompt('{{items}}', { items: [], now: NOW });
    assert.equal(result.text, 'No items were found.');
  });

  it('renders the diff and reports nothing available when there is none', () => {
    assert.equal(
      renderPrompt('{{diff}}', { items: [], now: NOW, diff: 'diff --git a/f b/f' }).text,
      'diff --git a/f b/f',
    );
    assert.equal(renderPrompt('{{diff}}', { items: [], now: NOW }).text, '(no diff available)');
  });

  it('renders date and time in the effective time zone', () => {
    const tokyo = renderPrompt('{{date}} {{datetime}}', {
      items: [],
      now: NOW,
      timeZone: 'Asia/Tokyo',
    });
    // 22:30 UTC is already the next morning in Tokyo.
    assert.equal(tokyo.text, '2026-08-18 2026-08-18 07:30');

    const utc = renderPrompt('{{date}}', { items: [], now: NOW, timeZone: 'UTC' });
    assert.equal(utc.text, '2026-08-17');
  });

  it('names the workspace, or says there is none', () => {
    assert.equal(
      renderPrompt('{{workspace}}', { items: [], now: NOW, workspaceName: 'rounds' }).text,
      'rounds',
    );
    assert.equal(renderPrompt('{{workspace}}', { items: [], now: NOW }).text, 'no workspace');
  });

  it('leaves an escaped placeholder in the text without substituting it', () => {
    const result = renderPrompt('Use \\{{items}} for the list.', { items: [item()], now: NOW });
    assert.equal(result.text, 'Use {{items}} for the list.');
  });

  it('truncates a diff with a visible marker and reports it', () => {
    const result = renderPrompt('{{diff}}', {
      items: [],
      now: NOW,
      diff: 'x'.repeat(LIMITS.diff + 10),
    });
    assert.equal(result.truncated, true);
    assert.match(result.text, /\[truncated: \d+ of \d+ characters shown\]/);
  });

  it('truncates an item list that is too long and says how many were shown', () => {
    const items = Array.from({ length: LIMITS.itemCount + 5 }, (_, index) =>
      item({ id: `ROUNDS-${index}` }),
    );
    const result = renderPrompt('{{items}}', { items, now: NOW });

    assert.equal(result.truncated, true);
    assert.match(result.text, new RegExp(`\\[truncated: ${LIMITS.itemCount} of ${items.length} items shown\\]`));
  });

  it('caps an item body but keeps the item', () => {
    const rendered = renderItem(item({ body: 'y'.repeat(LIMITS.itemBody + 100) }));
    assert.match(rendered, /\[truncated: \d+ of \d+ characters shown\]/);
    assert.match(rendered, /ROUNDS-1/);
  });

  it('caps the whole prompt as a last resort', () => {
    const result = renderPrompt('z'.repeat(LIMITS.prompt + 50), { items: [], now: NOW });
    assert.equal(result.truncated, true);
    assert.ok(result.text.length < LIMITS.prompt + 100);
  });
});

describe('truncation helpers', () => {
  it('leaves short text alone', () => {
    assert.deepEqual(truncate('short', 100), { text: 'short', truncated: false });
  });

  it('marks what it cut', () => {
    const result = truncate('abcdef', 3);
    assert.equal(result.truncated, true);
    assert.equal(result.text, 'abc\n\n[truncated: 3 of 6 characters shown]');
  });

  it('cuts lists and reports it', () => {
    assert.deepEqual(truncateList([1, 2, 3], 5), { items: [1, 2, 3], truncated: false });
    assert.deepEqual(truncateList([1, 2, 3], 2), { items: [1, 2], truncated: true });
  });
});
