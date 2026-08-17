import * as assert from 'node:assert/strict';

import { LIMITS } from '../../agents/truncate.js';
import type { LanguageModelGateway, ModelInfo, ModelRequest, ModelTurn } from '../../model/gateway.js';
import { IterationCapError, RunCancelledError, runAgenticLoop } from '../../model/loop.js';
import { ToolRegistry } from '../../tools/registry.js';
import type { ToolContext } from '../../tools/registry.js';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

class ScriptedGateway implements LanguageModelGateway {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly turns: (ModelTurn | Error)[]) {}

  selectModels(): Promise<ModelInfo[]> {
    return Promise.resolve([]);
  }

  sendRequest(request: ModelRequest): Promise<ModelTurn> {
    this.requests.push(structuredClone(request));
    const turn = this.turns[Math.min(this.requests.length - 1, this.turns.length - 1)];
    if (turn instanceof Error) {
      return Promise.reject(turn);
    }
    return Promise.resolve(turn ?? { text: '', toolCalls: [] });
  }
}

function context(): ToolContext {
  return {
    workspaceFolders: ['/workspace'],
    scriptWhitelist: [],
    logger: silentLogger,
    runId: 'run-1',
  };
}

function registryWith(execute: (input: unknown) => Promise<{ content: string; truncated: boolean }>): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'peek',
    description: 'returns something',
    inputSchema: { type: 'object' },
    parseInput: (raw) => raw,
    checkPermission: () => ({ allowed: true }),
    execute: (input) => execute(input),
  });
  return registry;
}

describe('agentic loop', () => {
  it('returns the answer when the model needs no tools', async () => {
    const gateway = new ScriptedGateway([{ text: 'All quiet.', toolCalls: [] }]);
    const result = await runAgenticLoop({
      gateway,
      registry: new ToolRegistry(),
      modelId: 'model-a',
      prompt: 'Report the state.',
      enabledTools: [],
      toolContext: context(),
      logger: silentLogger,
    });

    assert.equal(result.text, 'All quiet.');
    assert.equal(result.iterations, 1);
    assert.deepEqual(result.toolCalls, []);
    assert.equal(gateway.requests.length, 1);
    assert.deepEqual(gateway.requests[0]?.messages, [{ role: 'user', text: 'Report the state.' }]);
  });

  it('declares only the tools the agent enabled', async () => {
    const registry = registryWith(() => Promise.resolve({ content: 'ok', truncated: false }));
    const gateway = new ScriptedGateway([{ text: 'done', toolCalls: [] }]);

    await runAgenticLoop({
      gateway,
      registry,
      modelId: 'model-a',
      prompt: 'go',
      enabledTools: ['peek'],
      toolContext: context(),
      logger: silentLogger,
    });

    assert.deepEqual(gateway.requests[0]?.tools.map((tool) => tool.name), ['peek']);
  });

  it('executes a tool call and feeds the result back', async () => {
    const gateway = new ScriptedGateway([
      { text: '', toolCalls: [{ callId: 'call-1', name: 'peek', input: { path: 'notes.md' } }] },
      { text: 'The notes say all is well.', toolCalls: [] },
    ]);
    const registry = registryWith(() => Promise.resolve({ content: 'all is well', truncated: false }));

    const result = await runAgenticLoop({
      gateway,
      registry,
      modelId: 'model-a',
      prompt: 'Read the notes.',
      enabledTools: ['peek'],
      toolContext: context(),
      logger: silentLogger,
    });

    assert.equal(result.text, 'The notes say all is well.');
    assert.equal(result.iterations, 2);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]?.name, 'peek');
    assert.equal(result.toolCalls[0]?.allowed, true);

    // The conversation carries the call and its result, so the second turn has context.
    const second = gateway.requests[1];
    assert.equal(second?.messages[1]?.role, 'assistant');
    assert.equal(second?.messages[1]?.toolCalls?.[0]?.callId, 'call-1');
    assert.deepEqual(second?.messages[2]?.toolResults, [{ callId: 'call-1', content: 'all is well' }]);
  });

  it('handles several tool calls in one round', async () => {
    const gateway = new ScriptedGateway([
      {
        text: '',
        toolCalls: [
          { callId: 'a', name: 'peek', input: {} },
          { callId: 'b', name: 'peek', input: {} },
        ],
      },
      { text: 'done', toolCalls: [] },
    ]);
    const registry = registryWith(() => Promise.resolve({ content: 'value', truncated: false }));

    const result = await runAgenticLoop({
      gateway,
      registry,
      modelId: 'model-a',
      prompt: 'go',
      enabledTools: ['peek'],
      toolContext: context(),
      logger: silentLogger,
    });

    assert.equal(result.toolCalls.length, 2);
    assert.equal(gateway.requests[1]?.messages[2]?.toolResults?.length, 2);
  });

  it('runs three rounds of tools before the answer', async () => {
    const toolTurn: ModelTurn = {
      text: '',
      toolCalls: [{ callId: 'call', name: 'peek', input: {} }],
    };
    const gateway = new ScriptedGateway([toolTurn, toolTurn, toolTurn, { text: 'finally', toolCalls: [] }]);
    const registry = registryWith(() => Promise.resolve({ content: 'value', truncated: false }));

    const result = await runAgenticLoop({
      gateway,
      registry,
      modelId: 'model-a',
      prompt: 'go',
      enabledTools: ['peek'],
      toolContext: context(),
      logger: silentLogger,
    });

    assert.equal(result.iterations, 4);
    assert.equal(result.toolCalls.length, 3);
  });

  it('stops at the iteration cap with an explicit failure', async () => {
    const gateway = new ScriptedGateway([
      { text: '', toolCalls: [{ callId: 'call', name: 'peek', input: {} }] },
    ]);
    const registry = registryWith(() => Promise.resolve({ content: 'again', truncated: false }));

    await assert.rejects(
      runAgenticLoop({
        gateway,
        registry,
        modelId: 'model-a',
        prompt: 'go',
        enabledTools: ['peek'],
        toolContext: context(),
        logger: silentLogger,
        maxIterations: 3,
      }),
      (error: unknown) => {
        assert.ok(error instanceof IterationCapError);
        assert.equal(error.code, 'model.iterationCap');
        assert.match(error.message, /3 rounds/);
        return true;
      },
    );
    assert.equal(gateway.requests.length, 3, 'the cap limits requests, not just the answer');
  });

  it('feeds a denial back so the model can try something else', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'peek',
      description: 'denied',
      inputSchema: { type: 'object' },
      parseInput: (raw) => raw,
      checkPermission: () => ({ allowed: false, reason: 'that path is outside the workspace' }),
      execute: () => Promise.resolve({ content: 'never', truncated: false }),
    });
    const gateway = new ScriptedGateway([
      { text: '', toolCalls: [{ callId: 'call', name: 'peek', input: {} }] },
      { text: 'I will do without it.', toolCalls: [] },
    ]);

    const result = await runAgenticLoop({
      gateway,
      registry,
      modelId: 'model-a',
      prompt: 'go',
      enabledTools: ['peek'],
      toolContext: context(),
      logger: silentLogger,
    });

    assert.equal(result.text, 'I will do without it.');
    assert.equal(result.toolCalls[0]?.allowed, false);
    assert.match(
      gateway.requests[1]?.messages[2]?.toolResults?.[0]?.content ?? '',
      /outside the workspace/,
    );
  });

  it('caps an enormous tool result before sending it back', async () => {
    const registry = registryWith(() =>
      Promise.resolve({ content: 'x'.repeat(LIMITS.toolResult + 500), truncated: false }),
    );
    const gateway = new ScriptedGateway([
      { text: '', toolCalls: [{ callId: 'call', name: 'peek', input: {} }] },
      { text: 'done', toolCalls: [] },
    ]);

    await runAgenticLoop({
      gateway,
      registry,
      modelId: 'model-a',
      prompt: 'go',
      enabledTools: ['peek'],
      toolContext: context(),
      logger: silentLogger,
    });

    const sent = gateway.requests[1]?.messages[2]?.toolResults?.[0]?.content ?? '';
    assert.ok(sent.length < LIMITS.toolResult + 200);
    assert.match(sent, /\[truncated: \d+ of \d+ characters shown\]/);
  });

  it('propagates a model failure instead of swallowing it', async () => {
    const gateway = new ScriptedGateway([new Error('quota exceeded')]);
    await assert.rejects(
      runAgenticLoop({
        gateway,
        registry: new ToolRegistry(),
        modelId: 'model-a',
        prompt: 'go',
        enabledTools: [],
        toolContext: context(),
        logger: silentLogger,
      }),
      /quota exceeded/,
    );
  });

  it('stops when the run was cancelled', async () => {
    const gateway = new ScriptedGateway([{ text: 'never asked', toolCalls: [] }]);
    await assert.rejects(
      runAgenticLoop({
        gateway,
        registry: new ToolRegistry(),
        modelId: 'model-a',
        prompt: 'go',
        enabledTools: [],
        toolContext: context(),
        logger: silentLogger,
        isCancelled: () => true,
      }),
      RunCancelledError,
    );
    assert.equal(gateway.requests.length, 0);
  });

  it('stops between tool calls when cancelled mid-round', async () => {
    let cancelled = false;
    const registry = registryWith(() => {
      cancelled = true;
      return Promise.resolve({ content: 'value', truncated: false });
    });
    const gateway = new ScriptedGateway([
      {
        text: '',
        toolCalls: [
          { callId: 'a', name: 'peek', input: {} },
          { callId: 'b', name: 'peek', input: {} },
        ],
      },
    ]);

    await assert.rejects(
      runAgenticLoop({
        gateway,
        registry,
        modelId: 'model-a',
        prompt: 'go',
        enabledTools: ['peek'],
        toolContext: context(),
        logger: silentLogger,
        isCancelled: () => cancelled,
      }),
      RunCancelledError,
    );
  });
});
