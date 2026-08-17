#!/usr/bin/env node
/**
 * Fails when tracked text contains letters outside the ASCII range.
 *
 * Everything in this repository is written in English (see AGENTS.md), so a Cyrillic,
 * CJK or accented Latin letter means a rule was broken. Punctuation, arrows and emoji
 * are not letters and are therefore allowed.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const ROOT = resolve('.');
const TARGETS = [
  'src',
  'docs',
  'scripts',
  '.github',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'plan.md',
  'package.json',
  'esbuild.js',
  'eslint.config.mjs',
];
const TEXT_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.json', '.md', '.yml', '.yaml']);

/**
 * Non-ASCII letters that are allowed anyway, with the reason.
 * Keep this list short and justify every entry.
 */
const ALLOWED = new Map();

const LETTER = /\p{L}/u;

async function collect(target) {
  const full = resolve(ROOT, target);
  let info;
  try {
    info = await stat(full);
  } catch {
    return [];
  }
  if (info.isFile()) {
    return TEXT_EXTENSIONS.has(extname(full)) ? [full] : [];
  }
  const entries = await readdir(full, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    files.push(...(await collect(join(target, entry.name))));
  }
  return files;
}

const files = (await Promise.all(TARGETS.map(collect))).flat();
const failures = [];

for (const file of files) {
  const source = await readFile(file, 'utf8');
  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    for (const character of line) {
      if (character.codePointAt(0) > 127 && LETTER.test(character) && !ALLOWED.has(character)) {
        failures.push(`${relative(ROOT, file)}:${index + 1}: non-English letter ${JSON.stringify(character)}`);
        break;
      }
    }
  }
}

if (failures.length > 0) {
  console.error('Repository content must be written in English:');
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log(`check-language: ${files.length} file(s) contain English text only`);
