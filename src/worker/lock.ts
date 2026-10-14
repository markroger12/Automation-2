import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { dataPaths } from '@/lib/paths';

/**
 * Single-worker ownership of the data directory.
 *
 * The lock file is created atomically with the `wx` flag. It stores worker ID,
 * PID, hostname and a heartbeat timestamp. A lock is stale (and may be taken
 * over) only if its heartbeat is older than the TTL AND, on the same host, its
 * PID is no longer alive. The server never assumes a worker is alive merely
 * because a heartbeat row exists — see src/lib/health.ts.
 */
export interface LockInfo {
  workerId: string;
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
  version: string;
}

export const LOCK_TTL_MS = 60_000;

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readLock(file = dataPaths.workerLock()): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LockInfo;
    if (typeof parsed.workerId !== 'string' || typeof parsed.pid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

export type LockState = { state: 'free' } | { state: 'held'; info: LockInfo; alive: boolean; ageMs: number } | { state: 'corrupt' };

export function inspectLock(file = dataPaths.workerLock(), now = Date.now()): LockState {
  if (!fs.existsSync(file)) return { state: 'free' };
  const info = readLock(file);
  if (!info) return { state: 'corrupt' };
  const ageMs = now - new Date(info.heartbeatAt).getTime();
  const alive = info.hostname === os.hostname() ? isPidAlive(info.pid) : ageMs < LOCK_TTL_MS;
  return { state: 'held', info, alive, ageMs };
}

export class WorkerLock {
  readonly workerId = `worker-${randomUUID()}`;
  private info: LockInfo | null = null;

  constructor(
    private readonly file = dataPaths.workerLock(),
    private readonly version = '3.0.0',
  ) {}

  /** Acquire the lock or throw a clear error naming the current owner. */
  acquire(): LockInfo {
    for (let attempt = 0; attempt < 3; attempt++) {
      const now = new Date().toISOString();
      const info: LockInfo = { workerId: this.workerId, pid: process.pid, hostname: os.hostname(), startedAt: now, heartbeatAt: now, version: this.version };
      try {
        const fd = fs.openSync(this.file, 'wx');
        fs.writeSync(fd, JSON.stringify(info, null, 2));
        fs.closeSync(fd);
        this.info = info;
        return info;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const state = inspectLock(this.file);
        if (state.state === 'held' && (state.alive && state.ageMs < LOCK_TTL_MS)) {
          throw new Error(
            `Another worker already owns this data directory (worker ${state.info.workerId}, PID ${state.info.pid} on ${state.info.hostname}, heartbeat ${Math.round(state.ageMs / 1000)}s ago). Only one worker may run per data directory.`,
          );
        }
        if (state.state === 'held' && state.alive && state.info.hostname === os.hostname() && state.ageMs >= LOCK_TTL_MS) {
          throw new Error(
            `A worker process (PID ${state.info.pid}) still exists but its heartbeat is ${Math.round(state.ageMs / 1000)}s old. It may be hung; stop it before starting a new worker.`,
          );
        }
        // Stale (dead PID / expired foreign heartbeat) or corrupt: take over via atomic rename.
        const stale = `${this.file}.stale-${Date.now()}`;
        try {
          fs.renameSync(this.file, stale);
          fs.rmSync(stale, { force: true });
        } catch {
          /* another process raced us; retry */
        }
      }
    }
    throw new Error('Could not acquire the worker lock after recovering a stale lock. Try again.');
  }

  /** Refresh the heartbeat; returns false if ownership was lost. */
  heartbeat(): boolean {
    if (!this.info) return false;
    const current = readLock(this.file);
    if (!current || current.workerId !== this.workerId) return false;
    this.info = { ...this.info, heartbeatAt: new Date().toISOString() };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.info, null, 2));
    fs.renameSync(tmp, this.file);
    return true;
  }

  release(): void {
    const current = readLock(this.file);
    if (current && current.workerId === this.workerId) fs.rmSync(this.file, { force: true });
    this.info = null;
  }
}
