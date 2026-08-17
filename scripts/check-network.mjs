#!/usr/bin/env node
/**
 * Keeps "network access is limited to the hosts the user configured" checkable.
 *
 * The HTTP client pins every request to a configured base URL and refuses redirects. That guarantee
 * is only worth anything if nothing bypasses it, so this asserts two things:
 *
 * 1. `fetch(` is called from exactly one file, `src/connectors/http.ts`.
 * 2. No other network client is used: no `http.request`, no `https.request`, no socket.
 *
 * The test support file that disables the global fetch is allowed, since disabling it is the
 * opposite of using it.
 */
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

const ROOT = resolve('.');
const SRC = resolve('src');
const FETCH_ALLOWED = ['src/connectors/http.ts', 'src/test/support/noNetwork.ts'];
const OTHER_CLIENTS = [
  { pattern: /\bnode:https?\b/, what: 'the node http or https module' },
  { pattern: /\bnode:net\b/, what: 'the node net module' },
  { pattern: /\bXMLHttpRequest\b/, what: 'XMLHttpRequest' },
  { pattern: /\bnew WebSocket\b/, what: 'a WebSocket' },
];

const toPosix = (value) => (sep === '/' ? value : value.split(sep).join('/'));

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (extname(entry.name) === '.ts') {
      files.push(full);
    }
  }
  return files;
}

const failures = [];
const fetchCallers = [];

for (const file of await walk(SRC)) {
  const relativePath = toPosix(relative(ROOT, file));
  const source = await readFile(file, 'utf8');

  // Matches a call, so a mention in a comment or a type name does not count.
  if (/(?<![.\w])fetch\s*\(/.test(source) || /\bglobalThis\.fetch\b/.test(source)) {
    fetchCallers.push(relativePath);
  }
  for (const { pattern, what } of OTHER_CLIENTS) {
    if (pattern.test(source)) {
      failures.push(`${relativePath} uses ${what}; every request must go through the HTTP client.`);
    }
  }
}

const unexpected = fetchCallers.filter((file) => !FETCH_ALLOWED.includes(file));
if (unexpected.length > 0) {
  failures.push(
    `fetch must only be called from ${FETCH_ALLOWED[0]}, found it in: ${unexpected.join(', ')}`,
  );
}
if (!fetchCallers.includes(FETCH_ALLOWED[0])) {
  failures.push(`${FETCH_ALLOWED[0]} no longer calls fetch; is the HTTP client still there?`);
}

if (failures.length > 0) {
  console.error('Outbound requests must go through the host-pinned HTTP client:');
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log(`check-network: one fetch call site, no other network client`);
