#!/usr/bin/env node
/**
 * Audits what goes into the installable package.
 *
 * `.vscodeignore` is easy to get wrong and the mistake is invisible: the extension still works, it
 * just ships things it should not. This build shipped 1.4 MB of coverage artefacts before anybody
 * looked, so the file list is now an allowlist that fails on anything unexpected.
 */
import { spawnSync } from 'node:child_process';

/** Exactly what an installed extension needs, plus the files a marketplace listing uses. */
const ALLOWED = new Set([
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'dist/extension.js',
  // The marketplace icon, the activity bar glyph the manifest points at, and the image the README
  // shows. The vector originals stay in the repository and out of the package.
  'docs/media/rounds-icon-128.png',
  'docs/media/rounds-activitybar.svg',
  'docs/media/rounds-lockup.png',
]);

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['--yes', '@vscode/vsce@latest', 'ls', '--no-dependencies'],
  { encoding: 'utf8' },
);

if (result.status !== 0) {
  console.error('Could not list the package contents:');
  console.error(result.stderr || result.stdout);
  process.exit(1);
}

const files = result.stdout
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('npm '));

const unexpected = files.filter((file) => !ALLOWED.has(file));
const missing = [...ALLOWED].filter((file) => !files.includes(file));
const failures = [];

if (unexpected.length > 0) {
  failures.push(`the package would ship files nobody needs: ${unexpected.join(', ')}`);
}
if (missing.length > 0) {
  failures.push(`the package is missing: ${missing.join(', ')}`);
}

if (failures.length > 0) {
  console.error('The installable package does not contain what it should:');
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  console.error('Adjust .vscodeignore, or the allowlist in this script if the change is intended.');
  process.exit(1);
}

console.log(`check-package: ${files.length} files, exactly what an install needs`);
