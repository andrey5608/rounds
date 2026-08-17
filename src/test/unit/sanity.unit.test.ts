import * as assert from 'node:assert/strict';

/**
 * Proves the unit test runner works. Unit tests run outside the extension host
 * and must never import the `vscode` module; scripts/check-unit-tests.mjs enforces that.
 */
describe('unit test harness', () => {
  it('runs without the extension host', () => {
    assert.equal(typeof process.versions.node, 'string');
  });
});
