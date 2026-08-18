import type { ScriptWhitelistEntry } from '../state/settings.js';

import { entryAllows } from './runScript.js';

/**
 * Characters that only mean something to a shell.
 *
 * Commands are spawned directly, never through a shell, so these are ordinary text that would
 * become part of an argument and match nothing. Refusing them here says that once, instead of
 * leaving somebody with an entry that silently never fires.
 */
const SHELL_CHARACTERS = /[;&|><`$\n]/;

export type WhitelistParse =
  | { ok: true; entry: ScriptWhitelistEntry }
  | { ok: false; message: string };

/**
 * Turns a command line into a whitelist entry.
 *
 * Quotes group an argument that contains spaces; everything else splits on whitespace. This is
 * deliberately not a shell parser — there is no shell — and the entry it produces is matched
 * argument for argument by `entryAllows`, so what somebody types here is exactly what will be
 * allowed and nothing else.
 */
export function parseCommandLine(input: string): WhitelistParse {
  const text = input.trim();
  if (text.length === 0) {
    return { ok: false, message: 'Enter a command, for example npm test.' };
  }
  if (SHELL_CHARACTERS.test(text)) {
    return {
      ok: false,
      message:
        'Commands run directly rather than through a shell, so ; && | > and $ are ordinary text and would match nothing. Add one command per entry.',
    };
  }

  const parts = splitArguments(text);
  const command = parts[0];
  if (!command) {
    return { ok: false, message: 'Enter a command, for example npm test.' };
  }
  const args = parts.slice(1);
  return { ok: true, entry: args.length > 0 ? { command, args } : { command } };
}

/** The entry as a command line, which is how it was typed and how the README describes it. */
export function describeEntry(entry: ScriptWhitelistEntry): string {
  return [entry.command, ...(entry.args ?? [])].join(' ');
}

/**
 * Adds an entry unless the list already allows exactly that command line.
 *
 * Returning the list unchanged rather than appending a duplicate keeps the setting readable: two
 * identical entries would both match and neither would be wrong, which is the kind of thing
 * nobody notices until the file is unrecognisable.
 */
export function addToWhitelist(
  whitelist: readonly ScriptWhitelistEntry[],
  entry: ScriptWhitelistEntry,
): { whitelist: ScriptWhitelistEntry[]; added: boolean } {
  const already = whitelist.some((candidate) =>
    entryAllows(candidate, { command: entry.command, args: entry.args ?? [] }),
  );
  return already
    ? { whitelist: [...whitelist], added: false }
    : { whitelist: [...whitelist, entry], added: true };
}

/** Splits on whitespace, with quotes grouping one argument. */
function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | undefined;

  for (const character of text) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }

  if (current.length > 0) {
    parts.push(current);
  }
  return parts;
}
