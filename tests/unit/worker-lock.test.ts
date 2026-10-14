import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WorkerLock, inspectLock, isPidAlive } from '@/worker/lock';

const tmpLock = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bas-lock-')), 'worker.lock');

describe('single-worker lock', () => {
  it('allows only one live owner', () => {
    const file = tmpLock();
    const a = new WorkerLock(file);
    a.acquire();
    const b = new WorkerLock(file);
    expect(() => b.acquire()).toThrow(/Another worker already owns/);
    expect(a.heartbeat()).toBe(true);
    a.release();
    expect(inspectLock(file).state).toBe('free');
    b.acquire();
    b.release();
  });

  it('recovers a stale lock whose PID is dead', () => {
    const file = tmpLock();
    const deadPid = 999_999_9;
    expect(isPidAlive(deadPid)).toBe(false);
    fs.writeFileSync(
      file,
      JSON.stringify({ workerId: 'old', pid: deadPid, hostname: os.hostname(), startedAt: new Date(0).toISOString(), heartbeatAt: new Date().toISOString(), version: 'x' }),
    );
    const lock = new WorkerLock(file);
    expect(lock.acquire().workerId).toBe(lock.workerId);
    lock.release();
  });

  it('recovers a corrupt lock file', () => {
    const file = tmpLock();
    fs.writeFileSync(file, 'not json');
    const lock = new WorkerLock(file);
    lock.acquire();
    expect(inspectLock(file).state).toBe('held');
    lock.release();
  });

  it('detects lost ownership on heartbeat', () => {
    const file = tmpLock();
    const lock = new WorkerLock(file);
    lock.acquire();
    fs.writeFileSync(file, JSON.stringify({ workerId: 'intruder', pid: process.pid, hostname: os.hostname(), startedAt: '', heartbeatAt: new Date().toISOString(), version: 'x' }));
    expect(lock.heartbeat()).toBe(false);
  });
});
