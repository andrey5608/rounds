#!/usr/bin/env node
/**
 * Fails when a language model SDK is declared as a dependency.
 *
 * Model access goes through the editor's own surfaces only (see AGENTS.md and plan.md):
 * no third-party LLM SDK, no direct model HTTP calls, no model API key.
 */
import { readFile } from 'node:fs/promises';

const FORBIDDEN =
  /(^|[/@-])(openai|anthropic|langchain|llamaindex|cohere|mistralai?|ollama|@google\/generative-ai|google-generativeai|replicate|huggingface)($|[/-])/i;

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const declared = [
  ...Object.keys(manifest.dependencies ?? {}).map((name) => ['dependencies', name]),
  ...Object.keys(manifest.devDependencies ?? {}).map((name) => ['devDependencies', name]),
];

const failures = declared
  .filter(([, name]) => FORBIDDEN.test(name))
  .map(([section, name]) => `${section}: ${name}`);

if (failures.length > 0) {
  console.error('Language model SDKs are not allowed in this project:');
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  console.error('Use the editor language model API instead.');
  process.exit(1);
}

console.log(`check-dependencies: ${declared.length} declared package(s), no model SDK found`);
