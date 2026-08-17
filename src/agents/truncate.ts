/**
 * Size limits for anything that ends up in a prompt.
 *
 * A model request is billed and rate limited by size, and a diff of a thousand-file pull
 * request would fail the request outright. Cutting text is therefore unavoidable; doing it
 * silently is not, because a summary written from half a diff looks exactly like one written
 * from all of it.
 */
export const LIMITS = {
  /** Whole rendered prompt. */
  prompt: 120_000,
  /** One pull request diff. */
  diff: 60_000,
  /** One issue description or pull request body inside the item list. */
  itemBody: 4_000,
  /** Items rendered by `{{items}}`. */
  itemCount: 100,
  /** Output of one tool call fed back to the model. */
  toolResult: 20_000,
} as const;

export interface Truncated {
  text: string;
  truncated: boolean;
}

/** Cuts `text` to `limit` characters and says so in the text itself. */
export function truncate(text: string, limit: number, label = 'characters'): Truncated {
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return {
    text: `${text.slice(0, limit)}\n\n[truncated: ${limit} of ${text.length} ${label} shown]`,
    truncated: true,
  };
}

/** Cuts a list and says how many entries were left out. */
export function truncateList<T>(items: T[], limit: number): { items: T[]; truncated: boolean } {
  if (items.length <= limit) {
    return { items, truncated: false };
  }
  return { items: items.slice(0, limit), truncated: true };
}

/** The note appended to a rendered list that had to be cut. */
export function listTruncationNote(shown: number, total: number): string {
  return `\n\n[truncated: ${shown} of ${total} items shown]`;
}
