import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';

/** Proves the integration test runner boots a real extension host. */
describe('integration test harness', () => {
  it('runs inside an editor at or above the supported baseline', () => {
    const [major, minor] = vscode.version.split('.').map((part) => Number.parseInt(part, 10));
    assert.ok(major !== undefined && minor !== undefined);
    assert.ok(major > 1 || (major === 1 && minor >= 95), `unsupported version ${vscode.version}`);
  });
});
