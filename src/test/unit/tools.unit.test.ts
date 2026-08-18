import * as assert from 'node:assert/strict';

import { createListFilesTool } from '../../tools/listFiles.js';
import { createToolRegistry } from '../../tools/index.js';
import { ToolRegistry, summarizeInput } from '../../tools/registry.js';
import type { ProcessResult, ToolContext } from '../../tools/registry.js';
import {
  argumentMatches,
  createRunScriptTool,
  entryAllows,
  findWhitelistEntry,
  scrubEnvironment,
} from '../../tools/runScript.js';
import type { ScriptWhitelistEntry } from '../../state/settings.js';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
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

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides };
}

describe('tool registry', () => {
  it('registers the three v1 tools', () => {
    assert.deepEqual(createToolRegistry().names(), ['readFile', 'listFiles', 'runScript']);
  });

  it('refuses two tools with the same name', () => {
    const registry = createToolRegistry();
    assert.throws(() => registry.register(createListFilesTool()), /already registered/);
  });

  it('declares only the tools an agent enabled', () => {
    const declarations = createToolRegistry().toChatTools(['listFiles', 'nonsense']);
    assert.deepEqual(declarations.map((declaration) => declaration.name), ['listFiles']);
    assert.equal(typeof declarations[0]?.description, 'string');
    assert.equal((declarations[0]?.inputSchema as { type?: string }).type, 'object');
  });

  it('reports an unknown tool as a result with the available names', async () => {
    const outcome = await createToolRegistry().invoke('doTheThing', {}, context());
    assert.match(outcome.content, /no tool named "doTheThing"/);
    assert.match(outcome.content, /readFile, listFiles, runScript/);
    assert.equal(outcome.record.allowed, false);
  });

  it('reports a rejected input as a result rather than throwing', async () => {
    const outcome = await createToolRegistry().invoke('listFiles', { pattern: 'wrong key' }, context());
    assert.match(outcome.content, /input for "listFiles" was rejected/);
    assert.equal(outcome.record.error, '"globPattern" must be a non-empty string.');
  });

  it('turns a crash inside a tool into a result', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'explode',
      description: 'always fails',
      inputSchema: { type: 'object' },
      parseInput: () => ({}),
      checkPermission: () => ({ allowed: true }),
      execute: () => Promise.reject(new Error('disk on fire')),
    });

    const outcome = await registry.invoke('explode', {}, context());
    assert.match(outcome.content, /failed: disk on fire/);
    assert.equal(outcome.record.allowed, true);
    assert.equal(outcome.record.error, 'disk on fire');
  });

  it('records every call for the audit trail', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'echo',
      description: 'returns its input',
      inputSchema: { type: 'object' },
      parseInput: (raw) => raw as { text: string },
      checkPermission: () => ({ allowed: true }),
      execute: (input) => Promise.resolve({ content: input.text, truncated: true }),
    });

    const outcome = await registry.invoke('echo', { text: 'hello' }, context());
    assert.equal(outcome.record.name, 'echo');
    assert.equal(outcome.record.inputSummary, '{"text":"hello"}');
    assert.equal(outcome.record.allowed, true);
    assert.equal(outcome.record.truncated, true);
    assert.equal(outcome.record.outputBytes, 5);
    assert.ok(outcome.record.durationMs >= 0);
  });

  it('keeps the input summary short', () => {
    assert.equal(summarizeInput({ a: 1 }), '{"a":1}');
    assert.equal(summarizeInput('x'.repeat(500)).length, 201);
    assert.equal(summarizeInput({ text: 'a\n  b' }), '{"text":"a\\n b"}');
  });
});

describe('listFiles tool', () => {
  const tool = createListFilesTool();

  it('rejects a pattern that is not a string', () => {
    assert.throws(() => tool.parseInput({ globPattern: 42 }), /must be a non-empty string/);
  });

  it('refuses an absolute pattern or one that climbs out', () => {
    for (const globPattern of ['/etc/**', '../**/*.ts']) {
      const permission = tool.checkPermission(
        { globPattern },
        context({ findFiles: () => Promise.resolve([]) }),
      );
      assert.equal(permission.allowed, false, globPattern);
    }
  });

  it('refuses to run without a workspace or a search facility', () => {
    assert.equal(tool.checkPermission({ globPattern: '**/*' }, context({ workspaceFolders: [] })).allowed, false);
    assert.equal(tool.checkPermission({ globPattern: '**/*' }, context()).allowed, false);
  });

  it('lists matches as workspace-relative paths', async () => {
    const output = await tool.execute(
      { globPattern: '**/*.ts' },
      context({ findFiles: () => Promise.resolve(['src/a.ts', 'src/b.ts']) }),
    );
    assert.equal(output.content, '- src/a.ts\n- src/b.ts');
    assert.equal(output.meta?.matches, 2);
  });

  it('drops matches on the deny list', async () => {
    const output = await tool.execute(
      { globPattern: '**/*' },
      context({
        findFiles: () => Promise.resolve(['src/a.ts', '.env', 'node_modules/pkg/index.js', '.git/config']),
      }),
    );
    assert.equal(output.content, '- src/a.ts');
  });

  it('says so when nothing matches', async () => {
    const output = await tool.execute(
      { globPattern: '**/*.rs' },
      context({ findFiles: () => Promise.resolve([]) }),
    );
    assert.match(output.content, /No files match \*\*\/\*\.rs/);
  });

  it('caps the result count and reports the cut', async () => {
    const many = Array.from({ length: 250 }, (_, index) => `src/file-${index}.ts`);
    const output = await tool.execute(
      { globPattern: '**/*.ts' },
      context({ findFiles: () => Promise.resolve(many) }),
    );

    assert.equal(output.truncated, true);
    assert.match(output.content, /\[truncated: 200 of 250 matches shown\]/);
  });
});

describe('runScript whitelist', () => {
  const npmTest: ScriptWhitelistEntry = { command: 'npm', args: ['test'] };
  const npmRun: ScriptWhitelistEntry = { command: 'npm', args: ['run', 'lint*'] };

  it('matches an exact argument', () => {
    assert.equal(argumentMatches('test', 'test'), true);
    assert.equal(argumentMatches('test', 'tests'), false);
  });

  it('matches a suffix pattern', () => {
    assert.equal(argumentMatches('lint*', 'lint'), true);
    assert.equal(argumentMatches('lint*', 'lint:fix'), true);
    assert.equal(argumentMatches('lint*', 'build'), false);
  });

  it('allows exactly what an entry describes', () => {
    assert.equal(entryAllows(npmTest, { command: 'npm', args: ['test'] }), true);
    assert.equal(entryAllows(npmTest, { command: 'npm', args: [] }), false);
    assert.equal(entryAllows(npmTest, { command: 'npm', args: ['test', '--watch'] }), false);
    assert.equal(entryAllows(npmTest, { command: 'yarn', args: ['test'] }), false);
  });

  it('finds the entry that allows a command', () => {
    const whitelist = [npmTest, npmRun];
    assert.equal(findWhitelistEntry(whitelist, { command: 'npm', args: ['run', 'lint:fix'] }), npmRun);
    assert.equal(findWhitelistEntry(whitelist, { command: 'npm', args: ['publish'] }), undefined);
  });

  it('removes credentials from the environment', () => {
    const scrubbed = scrubEnvironment({
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'secret',
      MY_SECRET: 'secret',
      DB_PASSWORD: 'secret',
      API_KEY: 'secret',
      HOME: '/home/alex',
    });
    assert.deepEqual(scrubbed, { PATH: '/usr/bin', HOME: '/home/alex' });
  });
});

describe('runScript tool', () => {
  const tool = createRunScriptTool();
  const whitelist: ScriptWhitelistEntry[] = [{ command: 'npm', args: ['test'] }];

  it('refuses to run anything in a workspace the user has not trusted', () => {
    // Opening a repository must not be enough to make it run commands, and the denial has to say
    // what to do about it: "not permitted" with no next step is where support requests come from.
    const result = tool.checkPermission(
      { command: 'npm', args: ['test'] },
      context({ scriptWhitelist: whitelist, workspaceTrusted: false }),
    );

    assert.equal(result.allowed, false);
    assert.match(result.allowed === false ? result.reason : '', /not trusted/);
    assert.match(result.allowed === false ? result.reason : '', /Manage Workspace Trust/);
    assert.match(result.allowed === false ? result.reason : '', /take runScript off this agent/);
  });

  it('runs in a trusted workspace, and in one that never said', () => {
    const input = { command: 'npm', args: ['test'] };
    assert.equal(
      tool.checkPermission(input, context({ scriptWhitelist: whitelist, workspaceTrusted: true })).allowed,
      true,
    );
    // Absent means trusted: every existing caller and test predates the flag.
    assert.equal(tool.checkPermission(input, context({ scriptWhitelist: whitelist })).allowed, true);
  });

  it('rejects malformed input', () => {
    assert.throws(() => tool.parseInput({}), /"command" must be a non-empty string/);
    assert.throws(() => tool.parseInput({ command: 'npm', args: 'test' }), /must be an array/);
    assert.throws(() => tool.parseInput({ command: 'npm', args: [1] }), /must contain strings only/);
  });

  it('refuses everything while the whitelist is empty', () => {
    const permission = tool.checkPermission({ command: 'npm', args: ['test'] }, context());
    assert.equal(permission.allowed, false);
    assert.match(permission.allowed === false ? permission.reason : '', /whitelist is empty/);
  });

  it('refuses a command that is not listed and says what is', () => {
    const permission = tool.checkPermission(
      { command: 'rm', args: ['-rf', '/'] },
      context({ scriptWhitelist: whitelist }),
    );
    assert.equal(permission.allowed, false);
    assert.match(permission.allowed === false ? permission.reason : '', /Allowed: npm test/);
  });

  it('treats shell metacharacters as ordinary text, so they match nothing', () => {
    for (const args of [['test; rm -rf /'], ['test && curl evil.invalid'], ['test`whoami`']]) {
      const permission = tool.checkPermission(
        { command: 'npm', args },
        context({ scriptWhitelist: whitelist }),
      );
      assert.equal(permission.allowed, false, args.join(' '));
    }
  });

  it('allows a whitelisted command', () => {
    assert.deepEqual(
      tool.checkPermission({ command: 'npm', args: ['test'] }, context({ scriptWhitelist: whitelist })),
      { allowed: true },
    );
  });

  it('refuses a working directory outside the workspace', () => {
    const permission = tool.checkPermission(
      { command: 'npm', args: ['test'], cwd: '../../elsewhere' },
      context({ scriptWhitelist: whitelist }),
    );
    assert.equal(permission.allowed, false);
    assert.match(permission.allowed === false ? permission.reason : '', /inside the workspace/);
  });

  it('runs the command in the workspace and reports the exit code', async () => {
    let seen: { command: string; args: string[]; cwd: string } | undefined;
    const output = await tool.execute(
      { command: 'npm', args: ['test'] },
      context({
        scriptWhitelist: whitelist,
        runProcess: (options) => {
          seen = { command: options.command, args: options.args, cwd: options.cwd };
          return Promise.resolve(processResult({ stdout: '2 passing', code: 0 }));
        },
      }),
    );

    assert.deepEqual(seen, { command: 'npm', args: ['test'], cwd: '/workspace' });
    assert.match(output.content, /npm test exited with code 0/);
    assert.match(output.content, /stdout:\n2 passing/);
    assert.equal(output.meta?.exitCode, 0);
  });

  it('reports a non-zero exit code and stderr', async () => {
    const output = await tool.execute(
      { command: 'npm', args: ['test'] },
      context({
        scriptWhitelist: whitelist,
        runProcess: () => Promise.resolve(processResult({ code: 1, stderr: '1 failing' })),
      }),
    );
    assert.match(output.content, /exited with code 1/);
    assert.match(output.content, /stderr:\n1 failing/);
  });

  it('reports a command that had to be killed', async () => {
    const output = await tool.execute(
      { command: 'npm', args: ['test'] },
      context({
        scriptWhitelist: whitelist,
        runProcess: () => Promise.resolve(processResult({ code: null, signal: 'SIGKILL', timedOut: true })),
      }),
    );
    assert.match(output.content, /timed out after 120s and was killed/);
    assert.equal(output.meta?.timedOut, true);
  });

  it('truncates enormous output', async () => {
    const output = await tool.execute(
      { command: 'npm', args: ['test'] },
      context({
        scriptWhitelist: whitelist,
        runProcess: () => Promise.resolve(processResult({ stdout: 'x'.repeat(200_000) })),
      }),
    );
    assert.equal(output.truncated, true);
    assert.match(output.content, /\[truncated: 100000 of 200000 characters shown\]/);
  });

  it('never spawns anything when the command is denied', async () => {
    const registry = createToolRegistry();
    let spawned = false;
    const outcome = await registry.invoke(
      'runScript',
      { command: 'rm', args: ['-rf', '/'] },
      context({
        scriptWhitelist: whitelist,
        runProcess: () => {
          spawned = true;
          return Promise.resolve(processResult());
        },
      }),
    );

    assert.equal(spawned, false);
    assert.equal(outcome.record.allowed, false);
    assert.match(outcome.content, /not allowed to run/);
  });
});
