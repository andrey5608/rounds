import * as assert from 'node:assert/strict';

import {
  BUILT_IN_TOOL_NAMES,
  isExternalTool,
  toExternalTool,
} from '../../tools/externalTools.js';
import type { ExternalToolInfo, ExternalToolResult } from '../../tools/externalTools.js';
import { ToolRegistry } from '../../tools/registry.js';
import type { ToolContext } from '../../tools/registry.js';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const info: ExternalToolInfo = {
  name: 'research',
  description: 'Looks something up',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  tags: ['search'],
};

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceFolders: ['/workspace'],
    scriptWhitelist: [],
    logger: silentLogger,
    runId: 'run-1',
    ...overrides,
  };
}

/** A tool that answers, and one that never does. */
function answering(text: string): (name: string, input: unknown) => Promise<ExternalToolResult> {
  return () => Promise.resolve({ text });
}

describe('tools from other extensions', () => {
  it('keeps the schema the tool declared rather than describing it again', () => {
    const tool = toExternalTool(info, answering('ok'));

    assert.equal(tool.name, 'research');
    assert.equal(tool.description, 'Looks something up');
    assert.deepEqual(tool.inputSchema, info.inputSchema);
    assert.deepEqual(tool.tags, ['search']);
    assert.equal(isExternalTool(tool as never), true);
  });

  it('passes the input through, because the editor validates it against that schema', () => {
    const tool = toExternalTool(info, answering('ok'));
    const input = { query: 'anything' };
    assert.equal(tool.parseInput(input), input);
  });

  it('answers the model with what the tool said', async () => {
    const tool = toExternalTool(info, answering('two open issues'));
    const output = await tool.execute({ query: 'issues' }, context());

    assert.equal(output.content, 'two open issues');
  });

  it('says when part of the answer was in a shape it cannot render', async () => {
    const tool = toExternalTool(info, () =>
      Promise.resolve({ text: 'the readable half', hadUnreadableParts: true }),
    );

    const output = await tool.execute({}, context());
    assert.match(output.content, /the readable half/);
    assert.match(output.content, /Rounds does not render/);
  });

  it('gives up on a tool that never answers, instead of holding the run open', async () => {
    // invokeTool shows a confirmation dialog for tools that ask for one, even outside chat, and a
    // scheduled run has nobody to answer it. Nothing says in advance which tools those are.
    const tool = toExternalTool(info, () => new Promise<ExternalToolResult>(() => undefined), {
      timeoutMs: 20,
    });

    const output = await tool.execute({}, context());

    assert.match(output.content, /did not answer within/);
    assert.match(output.content, /waiting for a confirmation/);
    assert.match(output.content, /Continue without it/);
  });

  it('tells a tool that the run was cancelled', async () => {
    let told = false;
    const tool = toExternalTool(info, (_name, _input, signal) => {
      told = signal.isCancelled();
      return Promise.resolve({ text: 'done' });
    });

    await tool.execute({}, context({ isCancelled: () => true }));
    assert.equal(told, true);
  });

  it('refuses to run in a workspace the user has not trusted', () => {
    const tool = toExternalTool(info, answering('ok'));
    const result = tool.checkPermission({}, context({ workspaceTrusted: false }));

    assert.equal(result.allowed, false);
    assert.match(result.allowed === false ? result.reason : '', /not trusted/);
    assert.match(result.allowed === false ? result.reason : '', /"research" off this agent/);
  });

  it('runs in a trusted workspace, and in one that never said', () => {
    const tool = toExternalTool(info, answering('ok'));
    assert.equal(tool.checkPermission({}, context({ workspaceTrusted: true })).allowed, true);
    assert.equal(tool.checkPermission({}, context()).allowed, true);
  });

  it('logs how much input it sent, never what was in it', async () => {
    const lines: string[] = [];
    const tool = toExternalTool(info, answering('ok'));

    await tool.execute(
      { query: 'a customer name that has no business in a log' },
      context({ logger: { ...silentLogger, info: (message) => lines.push(message) } }),
    );

    assert.equal(lines.length, 1);
    assert.match(lines[0] ?? '', /character\(s\) of input/);
    assert.ok(!lines[0]?.includes('customer name'));
  });

  it('goes through the registry like any other tool, denials included', async () => {
    const registry = new ToolRegistry();
    registry.register(toExternalTool(info, answering('found it')));

    const allowed = await registry.invoke('research', { query: 'x' }, context());
    assert.equal(allowed.content, 'found it');
    assert.equal(allowed.record.allowed, true);

    const denied = await registry.invoke('research', { query: 'x' }, context({ workspaceTrusted: false }));
    assert.equal(denied.record.allowed, false);
    assert.match(denied.content, /not allowed to run/);
  });

  it('names the tools this extension owns, so nothing can take one over', () => {
    assert.deepEqual([...BUILT_IN_TOOL_NAMES], ['readFile', 'listFiles', 'runScript']);
  });
});
