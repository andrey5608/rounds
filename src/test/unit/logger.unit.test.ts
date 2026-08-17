import * as assert from 'node:assert/strict';

import { Logger, MemorySink, redact } from '../../state/logger.js';
import type { LogLevel } from '../../state/logger.js';
import { FixedClock } from '../../state/time.js';

function makeLogger(level: LogLevel, secrets: string[] = []): { logger: Logger; sink: MemorySink } {
  const sink = new MemorySink();
  const logger = new Logger({
    sink,
    getLevel: () => level,
    getRedactions: () => secrets,
    clock: new FixedClock(new Date('2026-08-17T06:00:00.000Z')),
  });
  return { logger, sink };
}

describe('logger', () => {
  it('writes nothing at level none', () => {
    const { logger, sink } = makeLogger('none');
    logger.error('something failed');
    logger.info('something happened');
    assert.deepEqual(sink.lines, []);
  });

  it('writes errors and warnings at level error', () => {
    const { logger, sink } = makeLogger('error');
    logger.error('failed');
    logger.warn('suspicious');
    logger.info('routine');
    logger.debug('details');

    assert.equal(sink.lines.length, 2);
    assert.ok(sink.lines[0]?.includes('[error] failed'));
    assert.ok(sink.lines[1]?.includes('[warn] suspicious'));
  });

  it('writes everything at level debug', () => {
    const { logger, sink } = makeLogger('debug');
    logger.error('failed');
    logger.info('routine');
    logger.debug('details');
    assert.equal(sink.lines.length, 3);
  });

  it('stamps every line with the time and the level', () => {
    const { logger, sink } = makeLogger('info');
    logger.info('routine');
    assert.equal(sink.lines[0], '[2026-08-17T06:00:00.000Z] [info] routine');
  });

  it('prefixes scoped lines and nests scopes', () => {
    const { logger, sink } = makeLogger('info');
    logger.scope('run:abc').info('started');
    logger.scope('run:abc').scope('tool:readFile').info('called');

    assert.ok(sink.lines[0]?.includes('[run:abc] started'));
    assert.ok(sink.lines[1]?.includes('[run:abc/tool:readFile] called'));
  });

  it('replaces known secret values', () => {
    const { logger, sink } = makeLogger('info', ['super-secret-token']);
    logger.info('calling with token super-secret-token now');
    assert.ok(sink.lines[0]?.includes('calling with token *** now'));
    assert.ok(!sink.lines[0]?.includes('super-secret-token'));
  });

  it('applies the current level and secret list on every line', () => {
    const sink = new MemorySink();
    let level: LogLevel = 'error';
    let secrets: string[] = [];
    const logger = new Logger({
      sink,
      getLevel: () => level,
      getRedactions: () => secrets,
    });

    logger.info('first');
    level = 'info';
    secrets = ['token-abcdefgh'];
    logger.info('second with token-abcdefgh');

    assert.equal(sink.lines.length, 1);
    assert.ok(sink.lines[0]?.includes('second with ***'));
  });
});

describe('redaction', () => {
  it('hides credentials embedded in a URL', () => {
    assert.equal(
      redact('GET https://user:p4ssw0rd@example.invalid/rest/api'),
      'GET https://***:***@example.invalid/rest/api',
    );
  });

  it('hides an authorization header however it is written', () => {
    assert.equal(redact('{"Authorization": "Bearer abcdefghijkl"}'), '{"Authorization": "***"}');
    assert.equal(redact('authorization=abcdefghijkl'), 'authorization=***');
  });

  it('hides a bare bearer or basic token', () => {
    assert.equal(redact('sent Bearer abcdefghijklmnop'), 'sent Bearer ***');
    assert.equal(redact('sent Basic YWxhZGRpbjpvcGVuc2VzYW1l'), 'sent Basic ***');
  });

  it('leaves ordinary text alone', () => {
    const message = 'Run finished with 3 items and 0 tool calls';
    assert.equal(redact(message), message);
  });

  it('ignores short values that would redact half the log', () => {
    assert.equal(redact('status ok', ['ok']), 'status ok');
  });
});
