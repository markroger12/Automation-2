import fs from 'node:fs';
import os from 'node:os';
import { db } from './db';
import { dataPaths } from './paths';
import { getExtensionHealth, getWorkerHealth } from './health';
import { inspectLock } from '@/worker/lock';
import { detectBrowsers } from './browsers';
import { listBackups } from './backup';
import { getSettings } from './settings';
import { redact } from './redact';

/** Collect a diagnostic snapshot. Secrets, cookies and profile contents are never included. */
export async function collectDiagnostics() {
  const now = new Date();
  const [worker, extension, settings, jobCounts, activeJobs, logLevels, recentErrors, migrations, profiles] = await Promise.all([
    getWorkerHealth(now),
    getExtensionHealth(now),
    getSettings(),
    db.queueJob.groupBy({ by: ['queue', 'status'], _count: { _all: true } }),
    db.queueJob.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { startedAt: 'asc' },
      take: 50,
      select: { id: true, queue: true, kind: true, taskId: true, lockedBy: true, leaseUntil: true, heartbeatAt: true, attempts: true, claimedByTab: true, startedAt: true },
    }),
    db.log.groupBy({ by: ['level'], _count: { _all: true }, where: { createdAt: { gte: new Date(now.getTime() - 24 * 3600 * 1000) } } }),
    db.log.findMany({ where: { level: 'error' }, orderBy: { createdAt: 'desc' }, take: 20, select: { createdAt: true, category: true, message: true, taskId: true, stage: true } }),
    db.$queryRawUnsafe<{ migration_name: string; finished_at: string | null }[]>('SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at').catch(() => []),
    db.browserProfile.findMany({ select: { id: true, name: true, kind: true, sessionState: true, lastCheckedAt: true, lastLoginAt: true, profileDir: true } }),
  ]);
  let dbSizeBytes = 0;
  try {
    dbSizeBytes = fs.statSync(dataPaths.db()).size;
  } catch {
    dbSizeBytes = 0;
  }
  const lock = inspectLock();
  return redact({
    generatedAt: now.toISOString(),
    app: { version: '3.0.0', node: process.versions.node, platform: `${process.platform} ${os.release()}`, arch: process.arch },
    worker,
    lock: lock.state === 'held' ? { state: lock.state, workerId: lock.info.workerId, pid: lock.info.pid, hostname: lock.info.hostname, pidAlive: lock.alive, heartbeatAgeSec: Math.round(lock.ageMs / 1000) } : lock,
    extension,
    database: { sizeBytes: dbSizeBytes, migrations },
    queue: { counts: jobCounts.map((c) => ({ queue: c.queue, status: c.status, count: c._count._all })), activeLeases: activeJobs },
    profiles,
    browsers: detectBrowsers(),
    backups: listBackups().slice(0, 10),
    logs: { last24hByLevel: logLevels.map((l) => ({ level: l.level, count: l._count._all })), recentErrors },
    settings,
  });
}
