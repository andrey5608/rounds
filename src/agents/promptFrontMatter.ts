/**
 * What a prompt file's header says.
 *
 * A `.prompt.md` file starts with a YAML block meant for the editor, not for the model: a
 * description, which mode to open it in, which model to use, which tools to allow. Sending it as
 * prompt text — which is what happened until this was written — asks the model to read a header
 * addressed to somebody else.
 */
export interface PromptFrontMatter {
  description?: string;
  /** Tool names the file asks for. Used to preselect, never to enable behind somebody's back. */
  tools: string[];
  /** A suggestion only. The agent's stored model always wins; see `parsePromptFile`. */
  model?: string;
  /**
   * The chat mode the file names, kept for the record and deliberately unused: chat modes belong
   * to the chat view and cannot be reached through `vscode.lm`.
   */
  mode?: string;
}

export interface ParsedPromptFile {
  /** The prompt itself, with the header removed. */
  text: string;
  frontMatter?: PromptFrontMatter;
}

const DELIMITER = /^---[ \t]*$/;

/**
 * Splits a prompt file into its header and its text.
 *
 * A hand-written reader rather than a YAML dependency: this is a handful of `key: value` lines
 * and one short list, the runtime dependency list is three packages on purpose, and
 * `check-dependencies` is what keeps it that way. Anything more elaborate in a header — nested
 * maps, anchors, multi-line scalars — is left in place and ignored rather than half-understood.
 */
export function parsePromptFile(content: string): ParsedPromptFile {
  // Files come from disk and from other operating systems, so both line endings arrive here.
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || !DELIMITER.test(lines[0] ?? '')) {
    return { text: content };
  }

  const end = lines.findIndex((line, index) => index > 0 && DELIMITER.test(line));
  if (end === -1) {
    // An opening delimiter with no closing one is not a header; it is a document that begins with
    // a horizontal rule, and cutting it would take the first paragraph with it.
    return { text: content };
  }

  const frontMatter = readFrontMatter(lines.slice(1, end));
  const text = lines.slice(end + 1).join('\n');
  return { text: stripLeadingBlankLines(text), frontMatter };
}

function readFrontMatter(lines: string[]): PromptFrontMatter {
  const result: PromptFrontMatter = { tools: [] };
  let listKey: string | undefined;

  for (const line of lines) {
    const item = /^\s*-\s+(.*)$/.exec(line);
    if (item && listKey === 'tools') {
      const value = unquote(item[1] ?? '');
      if (value) {
        result.tools.push(value);
      }
      continue;
    }

    const pair = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) {
      continue;
    }
    const key = (pair[1] ?? '').toLowerCase();
    const value = unquote(pair[2] ?? '');
    listKey = value.length === 0 ? key : undefined;

    switch (key) {
      case 'description':
        result.description = value || undefined;
        break;
      case 'model':
        result.model = value || undefined;
        break;
      case 'mode':
        result.mode = value || undefined;
        break;
      case 'tools':
        result.tools.push(...readInlineList(value));
        break;
      default:
        break;
    }
  }

  return result;
}

/** `tools: ['a', 'b']` on one line, the form the editor's own documentation uses. */
function readInlineList(value: string): string[] {
  const inline = /^\[(.*)\]$/.exec(value.trim());
  if (!inline) {
    return [];
  }
  return (inline[1] ?? '')
    .split(',')
    .map((entry) => unquote(entry.trim()))
    .filter((entry) => entry.length > 0);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(['"])(.*)\1$/.exec(trimmed);
  return (quoted ? (quoted[2] ?? '') : trimmed).trim();
}

function stripLeadingBlankLines(text: string): string {
  return text.replace(/^(?:[ \t]*\n)+/, '');
}
