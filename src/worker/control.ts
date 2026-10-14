import type { QueueJob } from '@prisma/client';
import { db } from '@/lib/db';
import { claimNext, completeJob, failJob, heartbeatJob, parsePayload } from '@/lib/queue';
import { log, errorMessage } from '@/lib/log';
import { getSettings } from '@/lib/settings';

/**
 * Control queue: owner-triggered actions that need the worker (opening a
 * visible WordPress login window, session tests, category sync, launching
 * Automation Chrome). Handlers are registered by later milestones.
 */
export type ControlHandler = (job: QueueJob, payload: Record<string, unknown>, helpers: { heartbeat: () => Promise<boolean>; workerId: string }) => Promise<unknown>;

const handlers = new Map<string, ControlHandler>();
export function registerControlHandler(kind: string, handler: ControlHandler) {
  handlers.set(kind, handler);
}
export function controlKinds(): string[] {
  return [...handlers.keys()];
}

/** Profile-scoped mutual exclusion: never run two browser actions on one persistent profile. */
const busyProfiles = new Set<string>();
const running = new Set<string>();

export async function controlTick(workerId: string, stopping: () => boolean): Promise<void> {
  if (stopping() || running.size >= 3) return;
  const settings = await getSettings();
  const leaseMs = settings.advanced.operationLeaseSeconds * 1000;
  const job = await claimNext({
    queue: 'control',
    owner: workerId,
    leaseMs,
    kinds: handlers.size ? [...handlers.keys()] : ['__none__'],
    choose: (candidates) => candidates.filter((c) => !busyProfiles.has(profileKey(c))),
  });
  if (!job) return;
  const key = profileKey(job);
  busyProfiles.add(key);
  running.add(job.id);
  void (async () => {
    const hb = setInterval(() => void heartbeatJob(job.id, workerId, leaseMs), Math.floor(leaseMs / 3));
    try {
      const handler = handlers.get(job.kind);
      if (!handler) throw new Error(`No handler for control job ${job.kind}`);
      const result = await handler(job, parsePayload<Record<string, unknown>>(job), { heartbeat: () => heartbeatJob(job.id, workerId, leaseMs), workerId });
      await completeJob(job.id, workerId, result ?? {});
    } catch (error) {
      const message = errorMessage(error);
      await failJob(job.id, workerId, { error: message, retryable: false, errorCode: 'CONTROL_FAILED' });
      await log({ level: 'error', category: 'control', message: `${job.kind} failed: ${message}`, details: { jobId: job.id } });
    } finally {
      clearInterval(hb);
      busyProfiles.delete(key);
      running.delete(job.id);
    }
  })();
}

function profileKey(job: Pick<QueueJob, 'websiteId' | 'kind'>): string {
  return job.websiteId ? `site:${job.websiteId}` : `kind:${job.kind}`;
}

export function isProfileBusy(websiteId: string): boolean {
  return busyProfiles.has(`site:${websiteId}`);
}

/** Wait until a control job finishes (used by API routes that offer "wait for result"). */
export async function controlJobState(jobId: string) {
  return db.queueJob.findUnique({ where: { id: jobId }, select: { status: true, result: true, error: true, finishedAt: true } });
}
