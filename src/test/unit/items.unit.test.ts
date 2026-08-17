import * as assert from 'node:assert/strict';

import { byUpdatedAtDescending, itemsAfterCursor, newestCursor } from '../../connectors/items.js';
import type { SourceItem } from '../../connectors/items.js';

function item(id: string, updatedAt: string): SourceItem {
  return { id, title: `item ${id}`, url: `https://host.invalid/${id}`, updatedAt, extra: {} };
}

describe('source items', () => {
  it('sorts newest first', () => {
    const items = [
      item('a', '2026-08-16T10:00:00.000Z'),
      item('c', '2026-08-17T10:00:00.000Z'),
      item('b', '2026-08-17T09:00:00.000Z'),
    ];
    assert.deepEqual(
      [...items].sort(byUpdatedAtDescending).map((entry) => entry.id),
      ['c', 'b', 'a'],
    );
  });

  it('takes the newest timestamp as the next cursor', () => {
    const items = [item('a', '2026-08-16T10:00:00.000Z'), item('b', '2026-08-17T10:00:00.000Z')];
    assert.equal(newestCursor(items), '2026-08-17T10:00:00.000Z');
  });

  it('keeps the previous cursor when the batch is empty', () => {
    assert.equal(newestCursor([], '2026-08-01T00:00:00.000Z'), '2026-08-01T00:00:00.000Z');
    assert.equal(newestCursor([]), undefined);
  });

  it('never moves the cursor backwards', () => {
    const items = [item('a', '2026-08-01T00:00:00.000Z')];
    assert.equal(newestCursor(items, '2026-08-17T00:00:00.000Z'), '2026-08-17T00:00:00.000Z');
  });

  it('returns everything when there is no cursor yet', () => {
    const items = [item('a', '2026-08-16T10:00:00.000Z')];
    assert.deepEqual(itemsAfterCursor(items), items);
  });

  it('drops items that are not newer than the cursor', () => {
    const items = [
      item('old', '2026-08-16T10:00:00.000Z'),
      item('same', '2026-08-17T10:00:00.000Z'),
      item('new', '2026-08-17T11:00:00.000Z'),
    ];
    assert.deepEqual(
      itemsAfterCursor(items, '2026-08-17T10:00:00.000Z').map((entry) => entry.id),
      ['new'],
    );
  });
});
