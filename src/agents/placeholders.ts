import type { SourceItem } from '../connectors/items.js';
import { localDate, localTime } from '../state/time.js';

import { LIMITS, listTruncationNote, truncate, truncateList } from './truncate.js';

/** Every placeholder a prompt may use. Exactly the list from plan.md. */
export const PLACEHOLDERS = [
  'issueKey',
  'summary',
  'diff',
  'items',
  'date',
  'datetime',
  'workspace',
] as const;

export type PlaceholderName = (typeof PLACEHOLDERS)[number];

/** Placeholders that describe a single item, so the prompt is rendered once per item. */
export const ITEM_PLACEHOLDERS: PlaceholderName[] = ['issueKey', 'summary', 'diff'];

/** Placeholders that describe the whole batch, so the prompt is rendered once. */
export const BATCH_PLACEHOLDERS: PlaceholderName[] = ['items'];

export class PromptValidationError extends Error {
  readonly code = 'prompt.invalidPlaceholder';

  constructor(message: string) {
    super(message);
    this.name = 'PromptValidationError';
  }
}

const PLACEHOLDER_PATTERN = /(\\?)\{\{\s*([A-Za-z0-9_]*)\s*\}\}/g;

export interface PlaceholderScan {
  used: PlaceholderName[];
  /** True when the prompt talks about one item at a time. */
  perItem: boolean;
  /** True when the prompt talks about the batch as a whole. */
  batch: boolean;
}

/**
 * Reports which placeholders a prompt uses.
 *
 * Two things depend on this. Rendering mode: a prompt mentioning `{{issueKey}}` runs once per
 * item, one mentioning `{{items}}` runs once for all of them. And fetching: comments, links
 * and diffs are only requested when the prompt actually refers to them, so an agent over
 * fifty issues does not drag in text nobody reads.
 */
export function scanPlaceholders(text: string): PlaceholderScan {
  const used = new Set<PlaceholderName>();
  const unknown = new Set<string>();

  for (const match of text.matchAll(PLACEHOLDER_PATTERN)) {
    const [, escape, name] = match;
    if (escape === '\\') {
      continue;
    }
    if ((PLACEHOLDERS as readonly string[]).includes(name ?? '')) {
      used.add(name as PlaceholderName);
    } else {
      unknown.add(name ?? '');
    }
  }

  if (unknown.size > 0) {
    throw new PromptValidationError(
      `This prompt uses ${[...unknown].map((name) => `{{${name}}}`).join(', ')}, which Rounds does not know. Supported placeholders: ${PLACEHOLDERS.map((name) => `{{${name}}}`).join(', ')}.`,
    );
  }

  const usedList = [...used];
  return {
    used: usedList,
    perItem: usedList.some((name) => ITEM_PLACEHOLDERS.includes(name)),
    batch: usedList.some((name) => BATCH_PLACEHOLDERS.includes(name)),
  };
}

/**
 * Checks a prompt at save time.
 *
 * Mixing per-item and batch placeholders has no sensible meaning: the prompt would have to be
 * rendered once and once per item at the same time. Catching that in the wizard is far kinder
 * than catching it at three in the morning when the agent runs.
 */
export function validatePrompt(text: string): PlaceholderScan {
  const scan = scanPlaceholders(text);
  if (scan.perItem && scan.batch) {
    throw new PromptValidationError(
      `This prompt mixes placeholders about a single item (${ITEM_PLACEHOLDERS.map((name) => `{{${name}}}`).join(', ')}) with {{items}}, which covers the whole batch. Use one style or the other.`,
    );
  }
  return scan;
}

export interface RenderContext {
  /** The item this render is about, in per-item mode. */
  item?: SourceItem;
  /** Every fetched item, for `{{items}}`. */
  items: SourceItem[];
  /** Diff text for the current item, already fetched. */
  diff?: string;
  now: Date;
  timeZone?: string;
  workspaceName?: string;
}

export interface RenderResult {
  text: string;
  truncated: boolean;
}

/** Renders one item as a Markdown bullet, body included but capped. */
export function renderItem(item: SourceItem): string {
  const body = item.body ? truncate(item.body, LIMITS.itemBody).text : undefined;
  const extras = Object.entries(item.extra)
    .filter(([, value]) => value !== undefined && String(value).length > 0)
    .map(([key, value]) => `${key}: ${String(value)}`);

  const lines = [`- **${item.id}** ${item.title}`, `  ${item.url}`, `  updated ${item.updatedAt}`];
  if (extras.length > 0) {
    lines.push(`  ${extras.join(' · ')}`);
  }
  if (body) {
    lines.push(...body.split('\n').map((line) => `  ${line}`));
  }
  return lines.join('\n');
}

function renderItems(items: SourceItem[]): { text: string; truncated: boolean } {
  if (items.length === 0) {
    return { text: 'No items were found.', truncated: false };
  }
  const { items: shown, truncated } = truncateList(items, LIMITS.itemCount);
  const text = shown.map(renderItem).join('\n\n');
  return {
    text: truncated ? `${text}${listTruncationNote(shown.length, items.length)}` : text,
    truncated,
  };
}

/**
 * Substitutes every placeholder.
 *
 * Unknown names were already rejected by the scan, so anything left is either known or
 * escaped. A placeholder with no value renders as an explicit note rather than an empty
 * string: a prompt that silently loses its subject produces confident nonsense.
 */
export function renderPrompt(template: string, context: RenderContext): RenderResult {
  let truncatedAnything = false;

  const values: Record<PlaceholderName, () => string> = {
    issueKey: () => context.item?.id ?? '(no item)',
    summary: () => context.item?.title ?? '(no item)',
    diff: () => {
      if (context.diff === undefined) {
        return '(no diff available)';
      }
      const result = truncate(context.diff, LIMITS.diff);
      truncatedAnything = truncatedAnything || result.truncated;
      return result.text;
    },
    items: () => {
      const result = renderItems(context.items);
      truncatedAnything = truncatedAnything || result.truncated;
      return result.text;
    },
    date: () => localDate(context.now, context.timeZone),
    datetime: () =>
      `${localDate(context.now, context.timeZone)} ${localTime(context.now, context.timeZone)}`,
    workspace: () => context.workspaceName ?? 'no workspace',
  };

  const substituted = template.replace(PLACEHOLDER_PATTERN, (whole, escape: string, name: string) => {
    if (escape === '\\') {
      // `\{{name}}` is how a prompt talks about a placeholder without using it.
      return whole.slice(1);
    }
    const render = values[name as PlaceholderName];
    return render ? render() : whole;
  });

  const capped = truncate(substituted, LIMITS.prompt);
  return { text: capped.text, truncated: truncatedAnything || capped.truncated };
}
