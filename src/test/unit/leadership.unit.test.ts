import * as assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LeaderLock } from '../../scheduler/leaderLock.js';
import { Leadership } from '../../scheduler/leadership.js';
import type { LeaderLockLike } from '../../scheduler/leadership.js';
import { Emitter } from '../../state/emitter.js';
import type { Disposable } from '../../state/emitter.js';

/** A lock whose loss can be triggered on demand, which the real one cannot. */
class FakeLock implements LeaderLockLike {
  private held = false;
  private readonly lostEmitter = new Emitter<void>();
  grantNext = true;

  get isHeld(): boolean {
    return this.held;
  }

  acquire(): Promise<boolean> {
    this.held = this.grantNext;
    return Promise.resolve(this.held);
  }

  giveUp(): Promise<void> {
    this.held = false;
    return Promise.resolve();
  }

  onLost(listener: () => void): Disposable {
    return this.lostEmitter.event(listener);
  }

  /** Simulates the file system reporting that the lock was compromised. */
  loseIt(): void {
    this.held = false;
    this.lostEmitter.fire(undefined);
  }
}

function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = (): void => {
      if (condition()) {
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        reject(new Error('condition was not met in time'));
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });
}

describe('leadership', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rounds-leader-'));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('gives every window its own identifier', () => {
    const first = new Leadership({ lock: new LeaderLock({ directory }) });
    const second = new Leadership({ lock: new LeaderLock({ directory }) });
    assert.notEqual(first.windowId, second.windowId);
  });

  it('elects exactly one leader among two windows', async () => {
    const windowA = new Leadership({ lock: new LeaderLock({ directory }) });
    const windowB = new Leadership({ lock: new LeaderLock({ directory }) });

    const first = await windowA.tryAcquire();
    const second = await windowB.tryAcquire();

    assert.deepEqual([first, second], [true, false]);
    assert.equal(windowA.isLeader, true);
    assert.equal(windowB.isLeader, false);

    await windowA.stop();
    await windowB.stop();
  });

  it('announces leadership changes', async () => {
    const leadership = new Leadership({ lock: new LeaderLock({ directory }) });
    const seen: boolean[] = [];
    leadership.onDidChange((isLeader) => seen.push(isLeader));

    await leadership.tryAcquire();
    await leadership.stop();

    assert.deepEqual(seen, [true, false]);
  });

  it('keeps retrying until the leader releases the lock', async () => {
    const leader = new Leadership({ lock: new LeaderLock({ directory }) });
    await leader.tryAcquire();

    const follower = new Leadership({
      lock: new LeaderLock({ directory }),
      retryMs: 20,
      retryJitterMs: 0,
    });
    follower.start();
    await waitFor(() => !follower.isLeader);
    assert.equal(follower.isLeader, false);

    await leader.stop();
    await waitFor(() => follower.isLeader);
    assert.equal(follower.isLeader, true);

    await follower.stop();
  });

  it('stops trying once it has been stopped', async () => {
    const leader = new Leadership({ lock: new LeaderLock({ directory }) });
    await leader.tryAcquire();

    const follower = new Leadership({
      lock: new LeaderLock({ directory }),
      retryMs: 10,
      retryJitterMs: 0,
    });
    follower.start();
    await follower.stop();
    await leader.stop();

    // The lock is free now, but a stopped manager must not grab it behind our back.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(follower.isLeader, false);
    assert.equal(await follower.tryAcquire(), false);
  });

  it('reports a lost lock and goes back to trying', async () => {
    const lock = new FakeLock();
    const leadership = new Leadership({ lock, retryMs: 10, retryJitterMs: 0 });
    const seen: boolean[] = [];
    leadership.onDidChange((isLeader) => seen.push(isLeader));

    leadership.start();
    await waitFor(() => leadership.isLeader);

    // The lock disappears without this window releasing it.
    lock.grantNext = false;
    lock.loseIt();
    assert.equal(leadership.isLeader, false);
    assert.deepEqual(seen, [true, false]);

    // Once the lock is available again the window takes it back on its own.
    lock.grantNext = true;
    await waitFor(() => leadership.isLeader);
    assert.deepEqual(seen, [true, false, true]);

    await leadership.stop();
  });

  it('spreads retries out with a random offset', async () => {
    const leader = new Leadership({ lock: new LeaderLock({ directory }) });
    await leader.tryAcquire();

    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((_callback: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      return { unref: () => undefined } as unknown as NodeJS.Timeout;
    }) as unknown as typeof globalThis.setTimeout;

    try {
      const follower = new Leadership({
        lock: new LeaderLock({ directory }),
        retryMs: 1000,
        retryJitterMs: 500,
        random: () => 0.5,
      });
      // The attempt fails, which is what schedules the retry.
      assert.equal(await follower.tryAcquire(), false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }

    assert.deepEqual(delays, [1250], 'base delay plus half of the jitter range');
    await leader.stop();
  });
});
