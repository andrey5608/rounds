import * as assert from 'node:assert/strict';

import { createExternalTools, listExternalTools } from '../../tools/vscodeLmTools.js';
import { createRunRegistry } from '../../tools/index.js';
import type { ToolContext } from '../../tools/registry.js';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * A real tool, contributed the way every reachable tool is.
 *
 * `vscode.lm.registerTool` alone is not enough: the host answers "was not contributed" and keeps
 * the tool out of `vscode.lm.tools` unless the manifest declares it. That is the rule this file
 * exists to hold us to, so the probe is our own `rounds_query` — contributed, registered at
 * activation, and reachable exactly the way another extension's tool is.
 */
const PROBE = 'rounds_query';

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceFolders: ['/workspace'],
    scriptWhitelist: [],
    logger: silentLogger,
    runId: 'run-1',
    ...overrides,
  };
}

describe('tools the editor reports', () => {
  it('include what extensions contribute, this one included', () => {
    const names = listExternalTools().map((tool) => tool.name);

    assert.ok(
      names.includes(PROBE),
      `expected a contributed tool in the list; got ${names.join(', ') || 'nothing'}`,
    );
  });

  it('are declared to the model when an agent enables them', () => {
    const registry = createRunRegistry(createExternalTools());
    const declared = registry.toChatTools(['readFile', PROBE]);

    assert.deepEqual(declared.map((tool) => tool.name), ['readFile', PROBE]);
    // A declaration with no schema is one the editor rejects, so the fallback matters.
    assert.ok(declared[1]?.inputSchema);
  });

  it('run when the model calls them, and answer into the conversation', async () => {
    // The path the whole feature stands on: registry.invoke reaches vscode.lm.invokeTool outside
    // any chat request, and what the tool says comes back as the tool result.
    const registry = createRunRegistry(createExternalTools());
    const outcome = await registry.invoke(PROBE, { kind: 'list' }, context());

    assert.equal(outcome.record.allowed, true);
    assert.equal(outcome.record.error, undefined);
    assert.match(outcome.content, /"ok": true/);
  });

  it('are refused in an untrusted workspace, with a reason the model can act on', async () => {
    const registry = createRunRegistry(createExternalTools());
    const outcome = await registry.invoke(
      PROBE,
      { kind: 'list' },
      context({ workspaceTrusted: false }),
    );

    assert.equal(outcome.record.allowed, false);
    assert.match(outcome.content, /not trusted/);
  });

  it('never take the name of one of ours', () => {
    // Ours carry the permission checks; a tool that could take the name `runScript` would take
    // the script whitelist with it.
    const registry = createRunRegistry(createExternalTools());

    for (const name of ['readFile', 'listFiles', 'runScript']) {
      assert.ok(registry.get(name), name);
      assert.ok(!listExternalTools().some((tool) => tool.name === name), name);
    }
  });

  it('reports a name nothing registers rather than inventing an answer', async () => {
    const registry = createRunRegistry(createExternalTools());
    const outcome = await registry.invoke('a_tool_nobody_registers', {}, context());

    assert.equal(outcome.record.allowed, false);
    assert.match(outcome.content, /There is no tool named/);
  });

  it('names what a skill is not: a slash command is not among them', () => {
    // The report this test was written for: an agent asked for `/feature-research` and the model
    // answered that it was not available. Skills and slash commands belong to the chat view; what
    // reaches a run is what the editor lists here, and nothing in that list is addressed with a
    // slash. Keeping the assertion makes the day this changes visible.
    const withSlash = listExternalTools().filter((tool) => tool.name.startsWith('/'));
    assert.deepEqual(withSlash, []);
  });
});
