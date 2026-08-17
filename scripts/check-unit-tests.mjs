#!/usr/bin/env node
/**
 * Fails when a unit test depends on the extension host.
 *
 * Unit tests must run under plain Mocha, so importing `vscode` from a *.unit.test.ts
 * file (or from anything it pulls in through a relative import chain) is a mistake:
 * the module only exists inside the extension host.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

const SRC = resolve('src');
const IMPORT_PATTERN = /(?:from\s+|require\()\s*['"]([^'"]+)['"]/g;

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

function importsOf(source) {
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1]);
}

async function resolveRelative(specifier, fromFile) {
  // Imports in this code base carry a .js extension, as Node16 module resolution wants. Resolving
  // "./x.js" as "x.js.ts" finds nothing, which made this guard silently skip every relative import
  // and report success while a unit test pulled in the editor API three files down.
  const withoutJs = specifier.replace(/\.js$/, '');
  const base = resolve(dirname(fromFile), withoutJs);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

/** Walks the relative import graph of one unit test and reports any path reaching `vscode`. */
async function findVscodeImport(entry) {
  const seen = new Set();
  const queue = [[entry, [entry]]];
  while (queue.length > 0) {
    const [file, path] = queue.shift();
    if (seen.has(file)) {
      continue;
    }
    seen.add(file);
    const source = await readFile(file, 'utf8');
    for (const specifier of importsOf(source)) {
      if (specifier === 'vscode') {
        return [...path, 'vscode'];
      }
      if (specifier.startsWith('.')) {
        const target = await resolveRelative(specifier, file);
        if (target) {
          queue.push([target, [...path, target]]);
        }
      }
    }
  }
  return undefined;
}

const unitTests = (await walk(SRC)).filter((file) => file.endsWith('.unit.test.ts'));
const failures = [];

for (const test of unitTests) {
  const chain = await findVscodeImport(test);
  if (chain) {
    failures.push(
      chain
        .map((part) => relative(resolve('.'), part))
        .map((part) => (sep === '/' ? part : part.split(sep).join('/')))
        .join(' -> '),
    );
  }
}

if (failures.length > 0) {
  console.error('Unit tests must not depend on the vscode module:');
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  console.error('Move the test to src/test/integration or hide the API behind an interface.');
  process.exit(1);
}

console.log(`check-unit-tests: ${unitTests.length} unit test file(s) are free of vscode imports`);
