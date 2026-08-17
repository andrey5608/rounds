#!/usr/bin/env node
/**
 * Keeps the consent rule checkable.
 *
 * Resolving a language model triggers a consent prompt on its first call, so it must only
 * happen because the user asked for something. Two rules make that verifiable:
 *
 * 1. `selectChatModels` appears in exactly one file, the gateway.
 * 2. `userAction(` is only called from command handlers, wizard steps and setup code, never
 *    from the scheduler, the runner or the connectors.
 */
import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const ROOT = resolve('.');
const SRC = resolve('src');
const GATEWAY = 'src/model/vscodeGateway.ts';
const USER_ACTION_ALLOWED = [
  'src/setup/',
  'src/ui/',
  'src/extension.ts',
  'src/test/',
];

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

const files = await walk(SRC);
const failures = [];
const selectChatModelsFiles = [];

for (const file of files) {
  const relativePath = relative(ROOT, file);
  const source = await readFile(file, 'utf8');

  if (source.includes('selectChatModels')) {
    selectChatModelsFiles.push(relativePath);
  }

  if (/\buserAction\(/.test(source) && !USER_ACTION_ALLOWED.some((prefix) => relativePath.startsWith(prefix))) {
    failures.push(
      `${relativePath} creates a user action token; only commands, wizard steps and setup code may.`,
    );
  }
}

const unexpected = selectChatModelsFiles.filter((file) => file !== GATEWAY);
if (unexpected.length > 0) {
  failures.push(
    `selectChatModels must only be called from ${GATEWAY}, found it in: ${unexpected.join(', ')}`,
  );
}
if (!selectChatModelsFiles.includes(GATEWAY)) {
  failures.push(`${GATEWAY} no longer calls selectChatModels; is the gateway still there?`);
}

if (failures.length > 0) {
  console.error('Consent gate rules are broken:');
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log('check-consent-gate: one model call site, user action tokens stay in the UI layer');
