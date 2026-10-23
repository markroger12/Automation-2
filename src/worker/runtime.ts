import os from 'node:os';
import { db, ensurePragmas } from '@/lib/db';
import { ensureDataDirs } from '@/lib/paths';
import { log, errorMessage } from '@/lib/log';
import { WORKER_HEARTBEAT_MS } from '@/lib/health';
import { WorkerLock } from './lock';

export const WORKER_VERSION = '3.0.0';

export interface WorkerContext {
  workerId: string;
  stopping: () => boolean;
}

type Loop = { name: string; intervalMs: number; run: (ctx: WorkerContext) => Promise<void> };

const loops: Loop[] = [];
let stopping = false;

/** Later milestones register queue processors, scheduler ticks, etc. */
export function registerLoop(loop: Loop) {
  loops.push(loop);
}

async function writeHeartbeat(lock: WorkerLock, status: 'RUNNING' | 'STOPPED', diagnostics: Record<string, unknown> = {}) {
  await db.workerStatus.upsert({
    where: { id: 'worker' },
    create: {
      id: 'worker',
      kind: 'WORKER',
      version: WORKER_VERSION,
      status,
      pid: process.pid,
      startedAt: new Date(),
      lastSeenAt: new Date(),
      capabilities: JSON.stringify({ loops: loops.map((l) => l.name) }),
      diagnostics: JSON.stringify({ workerId: lock.workerId, hostname: os.hostname(), ...diagnostics }),
    },
    update: {
      version: WORKER_VERSION,
      status,
      pid: process.pid,
      lastSeenAt: new Date(),
      capabilities: JSON.stringify({ loops: loops.map((l) => l.name) }),
      diagnostics: JSON.stringify({ workerId: lock.workerId, hostname: os.hostname(), ...diagnostics }),
    },
  });
}

export async function startWorker(): Promise<void> {
  ensureDataDirs();
  await ensurePragmas();
  const lock = new WorkerLock(undefined, WORKER_VERSION);
  lock.acquire();
  const ctx: WorkerContext = { workerId: lock.workerId, stopping: () => stopping };

  await db.workerStatus.upsert({
    where: { id: 'worker' },
    create: { id: 'worker', kind: 'WORKER', version: WORKER_VERSION, status: 'RUNNING', pid: process.pid, startedAt: new Date(), lastSeenAt: new Date() },
    update: { status: 'RUNNING', pid: process.pid, startedAt: new Date(), lastSeenAt: new Date(), version: WORKER_VERSION },
  });
  await log({ category: 'worker', message: `Worker ${lock.workerId} started (PID ${process.pid}, Node ${process.versions.node}).` });

  const { registerBuiltInLoops } = await import('./loops');
  await registerBuiltInLoops(ctx);

  const heartbeat = setInterval(() => {
    if (!lock.heartbeat()) {
      void log({ level: 'error', category: 'worker', message: 'Worker lost ownership of data/worker.lock — stopping to avoid two workers sharing the queue.' });
      void shutdown('lock lost', 2);
      return;
    }
    writeHeartbeat(lock, 'RUNNING').catch((error) => console.error('Heartbeat write failed:', errorMessage(error)));
  }, WORKER_HEARTBEAT_MS);

  const timers = loops.map((loop) => {
    let running = false;
    const tick = async () => {
      if (running || stopping) return;
      running = true;
      try {
        await loop.run(ctx);
      } catch (error) {
        await log({ level: 'error', category: 'worker', message: `Loop "${loop.name}" failed: ${errorMessage(error)}` });
      } finally {
        running = false;
      }
    };
    void tick();
    return setInterval(tick, loop.intervalMs);
  });

  let shuttingDown = false;
  async function shutdown(reason: string, code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    stopping = true;
    clearInterval(heartbeat);
    for (const t of timers) clearInterval(t);
    try {
      const { onShutdown } = await import('./loops');
      await onShutdown();
    } catch (error) {
      console.error('Shutdown hook failed:', errorMessage(error));
    }
    try {
      await writeHeartbeat(lock, 'STOPPED', { stopReason: reason });
      await log({ category: 'worker', message: `Worker stopped (${reason}).` });
    } catch {
      /* database may be gone */
    }
    lock.release();
    await db.$disconnect().catch(() => {});
    process.exit(code);
  }

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK'));
  // The desktop app (Windows has no signals for child processes) asks over its IPC channel; if the app itself goes
  // away, the channel closes and the worker stops the same safe way.
  if (process.send) {
    process.on('message', (m: unknown) => {
      if ((m as { type?: string } | null)?.type === 'shutdown') void shutdown('desktop app');
    });
    process.on('disconnect', () => void shutdown('desktop app closed'));
  }
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception in worker:', error);
    void log({ level: 'error', category: 'worker', message: `Uncaught exception: ${errorMessage(error)}` }).finally(() => shutdown('uncaught exception', 1));
  });
  process.on('unhandledRejection', (error) => {
    void log({ level: 'error', category: 'worker', message: `Unhandled rejection: ${errorMessage(error)}` });
  });

  console.log(`✔ Worker ${lock.workerId} running (PID ${process.pid}). Press Ctrl+C to stop.`);
}
