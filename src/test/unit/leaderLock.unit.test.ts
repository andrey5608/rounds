import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LOCK_FILE_NAME, LeaderLock } from '../../scheduler/leaderLock.js';

describe('leader lock', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rounds-lock-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('is granted to the first caller only', async () => {
    const first = new LeaderLock({ directory });
    const second = new LeaderLock({ directory });

    assert.equal(await first.acquire(), true);
    assert.equal(await second.acquire(), false);
    assert.equal(first.isHeld, true);
    assert.equal(second.isHeld, false);

    await first.giveUp();
  });

  it('lets another window take over after the holder gives up', async () => {
    const first = new LeaderLock({ directory });
    const second = new LeaderLock({ directory });

    await first.acquire();
    await first.giveUp();

    assert.equal(await second.acquire(), true);
    await second.giveUp();
  });

  it('is idempotent for the window that already holds it', async () => {
    const lock = new LeaderLock({ directory });
    assert.equal(await lock.acquire(), true);
    assert.equal(await lock.acquire(), true);
    await lock.giveUp();
  });

  it('takes over a lock whose holder stopped refreshing it', async () => {
    // A very short staleness window stands in for a window that died without releasing.
    const abandoned = new LeaderLock({ directory, staleMs: 5000, heartbeatMs: 100_000 });
    await abandoned.acquire();

    const takeover = new LeaderLock({ directory, staleMs: 5000, heartbeatMs: 100_000 });
    assert.equal(await takeover.acquire(), false, 'a fresh lock is respected');

    // Move the lock's modification time far enough into the past to look abandoned. The lock is
    // the directory named by LOCK_FILE_NAME; there is nothing else on disk beside it.
    const { utimes } = await import('node:fs/promises');
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(join(directory, LOCK_FILE_NAME), longAgo, longAgo);

    assert.equal(await takeover.acquire(), true, 'a stale lock is taken over');
    await takeover.giveUp();
  });

  it('explains a refusal once and then says nothing', async () => {
    // The reported noise: the extended log records every line whatever the configured level is,
    // so logging the repeat "more quietly" still wrote one line every fifteen seconds forever.
    const lines: string[] = [];
    const logger = {
      debug: (message: string) => lines.push(message),
      info: (message: string) => lines.push(message),
      warn: (message: string) => lines.push(message),
      error: (message: string) => lines.push(message),
    };

    const holder = new LeaderLock({ directory });
    await holder.acquire();

    const refused = new LeaderLock({ directory, logger });
    assert.equal(await refused.acquire(), false);
    const afterFirst = lines.length;
    assert.ok(
      lines.some((line) => line.includes('does not schedule runs')),
      'the first refusal is explained',
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal(await refused.acquire(), false);
    }
    assert.equal(lines.length, afterFirst, 'the same refusal is not repeated');

    await holder.giveUp();
  });

  it('reports the path it locks', () => {
    const lock = new LeaderLock({ directory });
    assert.equal(lock.path, join(directory, LOCK_FILE_NAME));
  });

  it('leaves exactly one thing in the folder, named as the specification names it', async () => {
    // It used to leave two: a marker file we wrote, plus the library's directory beside it.
    const lock = new LeaderLock({ directory });
    await lock.acquire();

    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(directory), [LOCK_FILE_NAME]);
    await lock.giveUp();
  });

  it('clears the marker file an earlier version left behind', async () => {
    // What a clean shutdown of an older build leaves: the library removed its own directory, and
    // the marker file we used to write stayed. That file has to go, or the directory that now
    // takes its name cannot be created and this window could never schedule anything.
    const { readdir, writeFile } = await import('node:fs/promises');
    await writeFile(join(directory, LOCK_FILE_NAME), 'a marker an earlier version wrote\n');

    const lock = new LeaderLock({ directory });
    assert.equal(await lock.acquire(), true);
    assert.deepEqual(await readdir(directory), [LOCK_FILE_NAME]);

    await lock.giveUp();
  });

  it('clears an abandoned lock from an earlier version too', async () => {
    const { mkdir, readdir, utimes, writeFile } = await import('node:fs/promises');
    await writeFile(join(directory, LOCK_FILE_NAME), 'a marker an earlier version wrote\n');
    const legacy = join(directory, `${LOCK_FILE_NAME}.lock`);
    await mkdir(legacy, { recursive: true });
    // Nobody has refreshed it, so it is what a window that died leaves behind.
    const longAgo = new Date(Date.now() - 120_000);
    await utimes(legacy, longAgo, longAgo);

    const lock = new LeaderLock({ directory, staleMs: 5000 });
    assert.equal(await lock.acquire(), true);
    assert.deepEqual(await readdir(directory), [LOCK_FILE_NAME]);

    await lock.giveUp();
  });

  it('leaves a live lock from an earlier version alone', async () => {
    // An older window is still scheduling with it. Taking the new lock as well would mean two
    // windows scheduling at once, which is the one thing this lock exists to prevent.
    const { mkdir, writeFile } = await import('node:fs/promises');
    await writeFile(join(directory, LOCK_FILE_NAME), 'a marker an earlier version wrote\n');
    await mkdir(join(directory, `${LOCK_FILE_NAME}.lock`), { recursive: true });

    const lock = new LeaderLock({ directory, staleMs: 30_000 });
    assert.equal(await lock.acquire(), false);
  });
});
