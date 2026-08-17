import * as assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileLogSink, LOG_FILE_PREFIX } from '../../state/fileSink.js';
import { Logger, MemorySink } from '../../state/logger.js';

describe('extended log file', () => {
  let directory: string;

  beforeEach(async () => {
    directory = join(await mkdtemp(join(tmpdir(), 'rounds-log-')), 'logs');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('creates the folder and appends lines', async () => {
    const sink = new FileLogSink({ directory, now: () => new Date('2026-08-17T09:00:00.000Z') });

    sink.append('first');
    sink.append('second');

    const content = await readFile(join(directory, `${LOG_FILE_PREFIX}20260817.log`), 'utf8');
    assert.equal(content, 'first\nsecond\n');
  });

  it('starts a new file each day', async () => {
    let now = new Date('2026-08-17T23:59:00.000Z');
    const sink = new FileLogSink({ directory, now: () => now });

    sink.append('yesterday');
    now = new Date('2026-08-18T00:01:00.000Z');
    sink.append('today');

    assert.deepEqual((await readdir(directory)).sort(), [
      `${LOG_FILE_PREFIX}20260817.log`,
      `${LOG_FILE_PREFIX}20260818.log`,
    ]);
  });

  it('keeps only the newest files', async () => {
    let day = 17;
    const sink = new FileLogSink({
      directory,
      maxFiles: 3,
      now: () => new Date(`2026-08-${String(day).padStart(2, '0')}T09:00:00.000Z`),
    });

    for (; day <= 23; day += 1) {
      sink.append(`day ${day}`);
    }

    const files = (await readdir(directory)).sort();
    assert.equal(files.length, 3, `expected three files, found ${files.join(', ')}`);
    assert.equal(files.at(-1), `${LOG_FILE_PREFIX}20260823.log`);
  });

  it('stops growing at the size limit and says so once', async () => {
    const sink = new FileLogSink({
      directory,
      maxFileBytes: 40,
      now: () => new Date('2026-08-17T09:00:00.000Z'),
    });

    for (let index = 0; index < 20; index += 1) {
      sink.append(`line ${index} with some padding`);
    }

    const content = await readFile(join(directory, `${LOG_FILE_PREFIX}20260817.log`), 'utf8');
    assert.match(content, /reached 40 bytes/);
    assert.equal(content.match(/reached 40 bytes/g)?.length, 1, 'the notice appears once');
    assert.ok(content.length < 200);
  });

  it('reports its own failure instead of breaking a run', async () => {
    const failures: unknown[] = [];
    // A path whose parent is a real file cannot become a directory.
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(directory, { recursive: true });
    const blocker = join(directory, 'blocker');
    await writeFile(blocker, 'not a directory', 'utf8');

    const sink = new FileLogSink({
      directory: join(blocker, 'logs'),
      now: () => new Date('2026-08-17T09:00:00.000Z'),
      onError: (error) => failures.push(error),
    });

    assert.doesNotThrow(() => sink.append('anything'));
    assert.equal(failures.length, 1);
  });

  it('records everything the channel level would have discarded', async () => {
    const channel = new MemorySink();
    const file = new FileLogSink({ directory, now: () => new Date('2026-08-17T09:00:00.000Z') });
    const logger = new Logger({
      sink: channel,
      verboseSink: file,
      getLevel: () => 'error',
    });

    logger.debug('a detail');
    logger.info('a fact');
    logger.error('a failure');

    assert.deepEqual(
      channel.lines.map((line) => line.replace(/^\[[^\]]+\] /, '')),
      ['[error] a failure'],
    );
    const content = await readFile(join(directory, `${LOG_FILE_PREFIX}20260817.log`), 'utf8');
    assert.match(content, /a detail/);
    assert.match(content, /a fact/);
    assert.match(content, /a failure/);
  });

  it('redacts before writing, so the file is as safe to share as the channel', async () => {
    const file = new FileLogSink({ directory, now: () => new Date('2026-08-17T09:00:00.000Z') });
    const logger = new Logger({
      sink: new MemorySink(),
      verboseSink: file,
      getLevel: () => 'none',
      getRedactions: () => ['super-secret-token'],
    });

    logger.debug('using super-secret-token now');

    const content = await readFile(join(directory, `${LOG_FILE_PREFIX}20260817.log`), 'utf8');
    assert.ok(!content.includes('super-secret-token'));
    assert.match(content, /using \*\*\* now/);
  });
});
