import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SETTING_KEYS } from '../../state/settings.js';

interface Manifest {
  name: string;
  displayName: string;
  publisher: string;
  version: string;
  icon: string;
  contributes: {
    commands: { command: string; title: string; category?: string }[];
    configuration: { title: string; properties: Record<string, unknown> };
    viewsContainers: { activitybar: { id: string; title: string; icon: string }[] };
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
    assert.equal(manifest.publisher, 'rounds');
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

  it('points at icon files that exist', () => {
    const root = resolve(__dirname, '../../..');
    const paths = [
      manifest.icon,
      ...manifest.contributes.viewsContainers.activitybar.map((container) => container.icon),
    ];

    for (const path of paths) {
      assert.ok(path, 'an icon path is declared');
      // A missing icon leaves the view container blank without an error anywhere.
      assert.ok(existsSync(resolve(root, path)), `${path} is declared but not in the repository`);
    }
  });

  it('declares none of the contributions v1 leaves out', () => {
    // The out-of-scope list is a promise about the shipped manifest, so it is checked there rather
    // than remembered: a chat participant or a language model tool would change what the extension
    // is, not just what it can do.
    const contributes = manifest.contributes as unknown as Record<string, unknown>;
    for (const key of ['chatParticipants', 'languageModelTools', 'configurationDefaults']) {
      assert.equal(contributes[key], undefined, `v1 must not contribute ${key}`);
    }
  });

  it('agrees with the changelog about the version', () => {
    const changelog = readFileSync(resolve(__dirname, '../../../CHANGELOG.md'), 'utf8');
    assert.match(
      changelog,
      new RegExp(`^## \\[${manifest.version.replace(/\./g, '\\.')}\\]`, 'm'),
      `CHANGELOG.md has no entry for version ${manifest.version}`,
    );
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
