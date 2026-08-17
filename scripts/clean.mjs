#!/usr/bin/env node
/**
 * Removes build output directories.
 *
 * Compiling on top of an existing `out/` leaves files behind whose sources are gone,
 * and Mocha happily runs those stale tests. Cleaning first keeps a test run honest.
 */
import { rm } from 'node:fs/promises';

const targets = process.argv.slice(2);

if (targets.length === 0) {
  console.error('usage: node scripts/clean.mjs <directory> [...]');
  process.exit(1);
}

for (const target of targets) {
  await rm(target, { recursive: true, force: true });
}
