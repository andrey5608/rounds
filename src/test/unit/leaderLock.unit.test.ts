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

    // Move the lock file's modification time far enough into the past to look abandoned.
    const { utimes } = await import('node:fs/promises');
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(join(directory, `${LOCK_FILE_NAME}.lock`), longAgo, longAgo);

    assert.equal(await takeover.acquire(), true, 'a stale lock is taken over');
    await takeover.giveUp();
  });

  it('reports the path it locks', () => {
    const lock = new LeaderLock({ directory });
    assert.equal(lock.path, join(directory, LOCK_FILE_NAME));
  });
});
