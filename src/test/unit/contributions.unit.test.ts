import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SETTING_KEYS } from '../../state/settings.js';

interface Manifest {
  name: string;
  displayName: string;
  publisher: string;
  contributes: {
    commands: { command: string; title: string; category?: string }[];
    configuration: { title: string; properties: Record<string, unknown> };
    viewsContainers: { activitybar: { id: string; title: string }[] };
    views: Record<string, { id: string; name: string }[]>;
  };
}

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../../package.json'), 'utf8'),
) as Manifest;

/**
 * Product names that may appear in prose only, never in an identifier or a title.
 * See the trademark rule in AGENTS.md.
 */
const FORBIDDEN_NAMES = [
  'Copilot',
  'GitHub',
  'Jira',
  'Atlassian',
  'VS Code',
  'Visual Studio',
];

function assertFree(label: string, value: string): void {
  for (const name of FORBIDDEN_NAMES) {
    assert.ok(
      !value.toLowerCase().includes(name.toLowerCase()),
      `${label} must not contain "${name}": ${value}`,
    );
  }
}

describe('manifest contributions', () => {
  it('declares the expected identity', () => {
    assert.equal(manifest.name, 'rounds');
    assert.equal(manifest.displayName, 'Rounds — Scheduled Task Agents');
    assert.equal(manifest.publisher, 'TODO-PUBLISHER');
  });

  it('declares the settings listed in the code base', () => {
    const declared = Object.keys(manifest.contributes.configuration.properties).sort();
    assert.deepEqual(declared, [...SETTING_KEYS].sort());
  });

  it('prefixes every setting key and command id with the product namespace', () => {
    for (const key of Object.keys(manifest.contributes.configuration.properties)) {
      assert.ok(key.startsWith('rounds.'), `setting key ${key} lacks the rounds. prefix`);
    }
    for (const command of manifest.contributes.commands) {
      assert.ok(
        command.command.startsWith('rounds.'),
        `command id ${command.command} lacks the rounds. prefix`,
      );
    }
  });

  it('writes command titles without the category prefix', () => {
    for (const command of manifest.contributes.commands) {
      assert.equal(command.category, 'Rounds');
      assert.ok(
        !/^rounds\b/i.test(command.title),
        `title "${command.title}" repeats the category, which the editor already prepends`,
      );
    }
  });

  it('keeps product names out of identifiers and titles', () => {
    assertFree('displayName', manifest.displayName);
    assertFree('name', manifest.name);
    for (const command of manifest.contributes.commands) {
      assertFree('command id', command.command);
      assertFree('command title', command.title);
    }
    for (const key of Object.keys(manifest.contributes.configuration.properties)) {
      assertFree('setting key', key);
    }
    assertFree('configuration title', manifest.contributes.configuration.title);
    for (const containerDefinition of manifest.contributes.viewsContainers.activitybar) {
      assertFree('view container title', containerDefinition.title);
    }
    for (const views of Object.values(manifest.contributes.views)) {
      for (const view of views) {
        assertFree('view title', view.name);
        assertFree('view id', view.id);
      }
    }
  });
});
