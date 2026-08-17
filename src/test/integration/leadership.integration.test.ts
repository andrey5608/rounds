import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { LeaderLock } from '../../scheduler/leaderLock.js';

const STALE_MS = 1000;
const HEARTBEAT_MS = 250;

/**
 * Starts a separate process that takes the lock and holds it, standing in for a second
 * editor window. Two real extension hosts would prove the same thing far more slowly.
 */
function startCompetingWindow(directory: string): Promise<ChildProcess> {
  const lockModule = resolve(__dirname, '../../scheduler/leaderLock.js');
  const script = `
    const { LeaderLock } = require(${JSON.stringify(lockModule)});
    const lock = new LeaderLock({
      directory: ${JSON.stringify(directory)},
      staleMs: ${STALE_MS},
      heartbeatMs: ${HEARTBEAT_MS},
    });
    lock.acquire().then((acquired) => {
      process.stdout.write(acquired ? 'acquired\\n' : 'refused\\n');
      // Stay alive so the lock keeps being refreshed until this process is killed.
      setInterval(() => undefined, 1000);
    });
  `;

  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolveWith, rejectWith) => {
    const timer = setTimeout(() => rejectWith(new Error('the competing window never reported')), 10_000);
    child.stdout.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('acquired')) {
        clearTimeout(timer);
        resolveWith(child);
      }
    });
    child.on('error', rejectWith);
  });
}

function waitFor(condition: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolveWith, rejectWith) => {
    const check = (): void => {
      void condition().then((met) => {
        if (met) {
          resolveWith();
        } else if (Date.now() - started > timeoutMs) {
          rejectWith(new Error('condition was not met in time'));
        } else {
          setTimeout(check, 100);
        }
      });
    };
    check();
  });
}

describe('leadership across processes', () => {
  let directory: string;
  let competitor: ChildProcess | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rounds-two-windows-'));
  });

  afterEach(async () => {
    competitor?.kill('SIGKILL');
    competitor = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  it('refuses a second holder and takes over when the holder is killed', async () => {
    competitor = await startCompetingWindow(directory);

    const thisWindow = new LeaderLock({
      directory,
      staleMs: STALE_MS,
      heartbeatMs: HEARTBEAT_MS,
    });
    assert.equal(await thisWindow.acquire(), false, 'the other process holds the lock');

    // Killing without a signal handler is exactly the crash case: nothing is released.
    competitor.kill('SIGKILL');
    competitor = undefined;

    await waitFor(() => thisWindow.acquire(), 15_000);
    assert.equal(thisWindow.isHeld, true);
    await thisWindow.giveUp();
  }).timeout(30_000);
});
