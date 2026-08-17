/** Anything longer than this is cut before it reaches the log file. */
const MAX_DUMP_CHARS = 20_000;

/**
 * Formats a value for the extended log, whole and readable, but bounded.
 *
 * Written for the case where a summary is not enough: "the model returned no text" says nothing about
 * what the model actually sent, and the only way to answer that is to write the object down.
 */
export function dump(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value, replaceUnserializable(), 2) ?? String(value);
  } catch (error) {
    return `<could not be serialized: ${String(error)}>`;
  }
  return text.length > MAX_DUMP_CHARS
    ? `${text.slice(0, MAX_DUMP_CHARS)}\n<truncated: ${text.length} characters total>`
    : text;
}

/** Keeps a circular or exotic value from turning a log line into an exception. */
function replaceUnserializable(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '<circular>';
      }
      seen.add(value);
      // Class instances lose their identity in JSON, and that identity is the interesting part when a
      // response part is not the shape this code expected.
      const name = value.constructor?.name;
      if (name && name !== 'Object' && name !== 'Array') {
        return { __type: name, ...(value as Record<string, unknown>) };
      }
    }
    return value;
  };
}
