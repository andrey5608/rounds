import * as assert from 'node:assert/strict';

import { entryAllows } from '../../tools/runScript.js';
import { addToWhitelist, describeEntry, parseCommandLine } from '../../tools/scriptWhitelist.js';

function parsed(input: string) {
  const result = parseCommandLine(input);
  assert.equal(result.ok, true, `expected "${input}" to parse`);
  return result.ok ? result.entry : { command: '' };
}

describe('allowing a command to run', () => {
  it('splits a command line into the command and its arguments', () => {
    assert.deepEqual(parsed('npm test'), { command: 'npm', args: ['test'] });
    assert.deepEqual(parsed('git status --short'), {
      command: 'git',
      args: ['status', '--short'],
    });
  });

  it('omits the argument list for a command that takes none', () => {
    // `args: []` and no `args` mean the same to the matcher; the shorter one is what the README
    // shows, and a setting somebody may read by hand should look like its documentation.
    assert.deepEqual(parsed('pwd'), { command: 'pwd' });
  });

  it('keeps a quoted argument in one piece', () => {
    assert.deepEqual(parsed('git commit -m "one message"'), {
      command: 'git',
      args: ['commit', '-m', 'one message'],
    });
  });

  it('refuses what only a shell would understand', () => {
    // Commands are spawned directly, so these would become ordinary text inside an argument and
    // the entry would never match anything. Saying so once beats an entry that silently sleeps.
    for (const input of ['npm test && echo done', 'ls | wc -l', 'cat file > out', 'echo $HOME']) {
      const result = parseCommandLine(input);
      assert.equal(result.ok, false, input);
      assert.match(result.ok === false ? result.message : '', /without a shell|not through a shell|directly/);
    }
  });

  it('refuses an empty line rather than storing nothing', () => {
    const result = parseCommandLine('   ');
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.message : '', /Enter a command/);
  });

  it('produces an entry that the matcher then accepts', () => {
    // The point of the parser: what somebody typed is exactly what will be allowed.
    const entry = parsed('npm run lint');
    assert.equal(entryAllows(entry, { command: 'npm', args: ['run', 'lint'] }), true);
    assert.equal(entryAllows(entry, { command: 'npm', args: ['run', 'lint', '--fix'] }), false);
    assert.equal(entryAllows(entry, { command: 'npm', args: ['test'] }), false);
  });

  it('adds an entry to the list', () => {
    const { whitelist, added } = addToWhitelist([{ command: 'git', args: ['status'] }], parsed('npm test'));

    assert.equal(added, true);
    assert.deepEqual(whitelist.map(describeEntry), ['git status', 'npm test']);
  });

  it('does not add a second entry that allows the same command line', () => {
    const { whitelist, added } = addToWhitelist(
      [{ command: 'npm', args: ['test'] }],
      parsed('npm test'),
    );

    assert.equal(added, false);
    assert.equal(whitelist.length, 1);
  });

  it('treats a command already covered by a pattern as covered', () => {
    const { added } = addToWhitelist([{ command: 'npm', args: ['run', 'lint*'] }], parsed('npm run lint'));
    assert.equal(added, false);
  });

  it('writes an entry back the way it was typed', () => {
    assert.equal(describeEntry({ command: 'npm', args: ['run', 'lint'] }), 'npm run lint');
    assert.equal(describeEntry({ command: 'pwd' }), 'pwd');
  });
});
