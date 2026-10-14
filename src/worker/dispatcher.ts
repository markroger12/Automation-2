import type { QueueJob } from '@prisma/client';
import { db } from '@/lib/db';
import { claimNext } from '@/lib/queue';
import { RUNNING_STATUSES } from '@/lib/domain';
import { allowedSlots } from '@/lib/chatgpt/rate';
import { getSettings } from '@/lib/settings';
import { log, errorMessage } from '@/lib/log';
import { runArticleJob, type RunOutcome } from './pipeline/engine';

/**
 * Article dispatcher.
 *
 * - "Article slots" limit how many tasks are in flight (started and running or
 *   waiting for ChatGPT) — 3 in High-Throughput mode, adapting 1–5; 1 in
 *   Quality/Conservative mode. Continuations of in-flight tasks are always
 *   claimable; NEW tasks start only when a slot is free.
 * - Fair website scheduling: among new tasks, the site with the fewest
 *   in-flight tasks goes first; paused sites and per-site quotas are honoured.
 * - Local (CPU-only) work runs in-process; browser work uses its own caps.
 */
export class ArticleDispatcher {
  private running = new Map<string, Promise<RunOutcome>>();
  /** Tasks started by this process whose status may not be "running" in the DB yet. */
  private starting = new Map<string, string>();
  private readonly maxLocalParallel = 8;

  constructor(private readonly workerId: string) {}

  get activeCount(): number {
    return this.running.size;
  }

  async tick(stopping: () => boolean): Promise<void> {
    if (stopping()) return;
    const settings = await getSettings();
    const leaseMs = settings.advanced.operationLeaseSeconds * 1000;
    const slots = await allowedSlots();
    for (let i = 0; i < this.maxLocalParallel && this.running.size < this.maxLocalParallel && !stopping(); i++) {
      const job = await this.claimOne(slots, leaseMs);
      if (!job) break;
      if (job.taskId && job.websiteId) this.starting.set(job.taskId, job.websiteId);
      const promise = runArticleJob(job, { workerId: this.workerId, leaseMs })
        .catch(async (error) => {
          await log({ level: 'error', category: 'worker', taskId: job.taskId, message: `Article job crashed: ${errorMessage(error)}` });
          return 'failed' as RunOutcome;
        })
        .finally(() => {
          this.running.delete(job.id);
          if (job.taskId) this.starting.delete(job.taskId);
        });
      this.running.set(job.id, promise);
    }
  }

  private async claimOne(slots: number, leaseMs: number): Promise<QueueJob | null> {
    const now = new Date();
    const inFlightRows = await db.articleTask.findMany({ where: { status: { in: RUNNING_STATUSES } }, select: { id: true, websiteId: true } });
    const inFlightMap = new Map(inFlightRows.map((r) => [r.id, r.websiteId]));
    for (const [taskId, websiteId] of this.starting) inFlightMap.set(taskId, websiteId);
    const inFlightTotal = inFlightMap.size;
    const siteLoad = new Map<string, number>();
    for (const websiteId of inFlightMap.values()) siteLoad.set(websiteId, (siteLoad.get(websiteId) ?? 0) + 1);
    const sites = await db.website.findMany({ select: { id: true, paused: true, active: true, queueQuota: true } });
    const blockedSites = sites.filter((s) => s.paused || !s.active || (s.queueQuota > 0 && (siteLoad.get(s.id) ?? 0) >= s.queueQuota)).map((s) => s.id);
    const candidateJobs = await db.queueJob.findMany({
      where: { queue: 'article', status: 'WAITING', runAt: { lte: now } },
      orderBy: [{ priority: 'desc' }, { runAt: 'asc' }],
      take: 100,
      select: { id: true, taskId: true, websiteId: true },
    });
    if (candidateJobs.length === 0) return null;
    const tasks = await db.articleTask.findMany({
      where: { id: { in: candidateJobs.map((j) => j.taskId).filter((x): x is string => Boolean(x)) } },
      select: { id: true, status: true, websiteId: true },
    });
    const statusById = new Map(tasks.map((t) => [t.id, t.status]));
    const isContinuation = (taskId: string | null) => (taskId ? (RUNNING_STATUSES as string[]).includes(statusById.get(taskId) ?? '') : true);
    const canStartNew = inFlightTotal < slots;
    return claimNext({
      queue: 'article',
      owner: this.workerId,
      leaseMs,
      now,
      scan: 100,
      choose: (candidates) => {
        const continuations = candidates.filter((c) => isContinuation(c.taskId));
        const fresh = canStartNew
          ? candidates
              .filter((c) => !isContinuation(c.taskId) && !(c.websiteId && blockedSites.includes(c.websiteId)))
              .sort((a, b) => {
                if (b.priority !== a.priority) return b.priority - a.priority;
                const load = (siteLoad.get(a.websiteId ?? '') ?? 0) - (siteLoad.get(b.websiteId ?? '') ?? 0);
                if (load !== 0) return load;
                return a.createdAt.getTime() - b.createdAt.getTime();
              })
          : [];
        return [...continuations, ...fresh.slice(0, 1)];
      },
    });
  }

  /** Wait for in-process jobs to reach a safe point (used on shutdown). */
  async drain(timeoutMs: number): Promise<void> {
    const all = Promise.allSettled([...this.running.values()]);
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
  }
}
