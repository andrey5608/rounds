#!/usr/bin/env node
/**
 * Audits what actually ships.
 *
 * The source-level guards say what the code base does; this one says what ended up in the file a
 * user installs. A dependency added and then bundled would pass every other check, so the bundle is
 * searched for the things the specification forbids, and for the things it requires to be there.
 */
import { readFile, stat } from 'node:fs/promises';

const BUNDLE = 'dist/extension.js';

/** Identifiers and hosts that would mean the extension talks to a model provider on its own. */
const FORBIDDEN = [
  { pattern: /api\.openai\.com/i, what: 'an OpenAI endpoint' },
  { pattern: /api\.anthropic\.com/i, what: 'an Anthropic endpoint' },
  { pattern: /generativelanguage\.googleapis\.com/i, what: 'a Google model endpoint' },
  { pattern: /api\.cohere\.ai/i, what: 'a Cohere endpoint' },
  { pattern: /api\.mistral\.ai/i, what: 'a Mistral endpoint' },
  { pattern: /openrouter\.ai/i, what: 'an OpenRouter endpoint' },
  { pattern: /\bnode_modules[/\\](openai|@anthropic-ai|langchain|llamaindex|cohere-ai)\b/i, what: 'a bundled model SDK' },
  { pattern: /sk-[A-Za-z0-9]{20,}/, what: 'something shaped like a model API key' },
];

/** Things whose absence would mean the bundle is not what it should be. */
const REQUIRED = [
  { pattern: /require\(["']vscode["']\)/, what: 'the editor API kept external rather than bundled' },
  { pattern: /rounds\.agentsView/, what: 'the contributed view id' },
];

let info;
try {
  info = await stat(BUNDLE);
} catch {
  console.error(`${BUNDLE} is missing. Run npm run package first.`);
  process.exit(1);
}

const bundle = await readFile(BUNDLE, 'utf8');
const failures = [];

for (const { pattern, what } of FORBIDDEN) {
  if (pattern.test(bundle)) {
    failures.push(`the bundle contains ${what}`);
  }
}
for (const { pattern, what } of REQUIRED) {
  if (!pattern.test(bundle)) {
    failures.push(`the bundle is missing ${what}`);
  }
}

// A bundle that suddenly grows by an order of magnitude usually means a dependency came along for
// the ride. Deliberately generous: this is a tripwire, not a budget.
const MAX_BYTES = 2_000_000;
if (info.size > MAX_BYTES) {
  failures.push(`the bundle is ${info.size} bytes, above the ${MAX_BYTES} byte tripwire`);
}

if (failures.length > 0) {
  console.error('The shipped bundle does not match what the specification allows:');
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log(
  `check-bundle: ${Math.round(info.size / 1024)} KB, no model SDK or provider endpoint, editor API external`,
);
