/**
 * The shape both connectors produce.
 *
 * Everything downstream — placeholder rendering, the result front matter, the history — only
 * knows about `SourceItem`. That is what keeps "add a connector" from turning into "touch
 * every layer": a new source only has to produce these fields.
 */
export interface SourceItem {
  /** Issue key or pull request number, as the user would recognise it. */
  id: string;
  title: string;
  url: string;
  /** ISO timestamp of the last change, used for ordering and for the cursor. */
  updatedAt: string;
  /** Description or pull request body. */
  body?: string;
  /** Anything source specific that a prompt may want: status, author, branch, and so on. */
  extra: Record<string, string | number | undefined>;
}

export interface FetchResult {
  items: SourceItem[];
  /** True when the source had more items than were fetched. */
  truncated: boolean;
  /**
   * Where to continue next time.
   *
   * Only stored after a successful run: a failed run must reprocess the same window rather
   * than skip the items it never managed to look at.
   */
  cursor?: string;
}

/** Newest first. */
export function byUpdatedAtDescending(left: SourceItem, right: SourceItem): number {
  return right.updatedAt.localeCompare(left.updatedAt);
}

/** The cursor value that covers every item in this batch. */
export function newestCursor(items: SourceItem[], previous?: string): string | undefined {
  const newest = items
    .map((item) => item.updatedAt)
    .filter((value) => value.length > 0)
    .sort()
    .at(-1);
  if (!newest) {
    return previous;
  }
  if (previous && previous.localeCompare(newest) >= 0) {
    return previous;
  }
  return newest;
}

/** Items changed strictly after the cursor. An absent cursor lets everything through. */
export function itemsAfterCursor(items: SourceItem[], cursor?: string): SourceItem[] {
  if (!cursor) {
    return items;
  }
  return items.filter((item) => item.updatedAt.localeCompare(cursor) > 0);
}
