import { db } from '@/lib/db';
import { log } from '@/lib/log';
import { openIncident } from '@/lib/recovery';
import { RUNNING_STATUSES } from '@/lib/domain';
import { ensureArticleRun } from '@/lib/tasks/lifecycle';
import type { ChatGPTJobProgress } from '@/lib/chatgpt/jobs';

/**
 * Restart and lease recovery. Decisions depend on the job type and on whether
 * an external side effect may already have happened:
 *
 * - article jobs: local orchestration only → safe to requeue; each stage
 *   reconciles its own side effects (saved ChatGPT operation, stored post ID).
 * - chatgpt jobs: if the prompt may have been sent, requeue WITH reconcile
 *   info so the extension inspects the conversation before any resend.
 * - control jobs (login windows, session tests): interrupted, marked failed
 *   with a clear message; never silently reopened.
 */
export async function recoverOnStartup(workerId: string): Promise<{ article: number; chatgpt: number; control: number }> {
  const active = await db.queueJob.findMany({ where: { status: 'ACTIVE' } });
  let article = 0;
  let chatgpt = 0;
  let control = 0;
  for (const job of active) {
    if (job.lockedBy === workerId) continue;
    if (job.queue === 'article' || job.queue === 'humanizer' || job.queue === 'workflow' || job.queue === 'maintenance') {
      await db.queueJob.update({ where: { id: job.id }, data: { status: 'WAITING', runAt: new Date(), lockedBy: null, leaseUntil: null, attempts: { decrement: 1 } } });
      await openIncident({
        kind: 'EXPIRED_LEASE',
        severity: 'info',
        status: 'AUTO_RESOLVED',
        jobId: job.id,
        taskId: job.taskId,
        description: `Worker restart: ${job.queue} job was active under ${job.lockedBy ?? 'unknown'}; requeued to resume from its last checkpoint.`,
        resolution: 'Requeued automatically (local work is recoverable; stages reconcile external effects).',
        dedupeKey: `restart:${job.id}:${job.startedAt?.toISOString() ?? ''}`,
      });
      article++;
    } else if (job.queue === 'control') {
      await db.queueJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', finishedAt: new Date(), leaseUntil: null, error: 'Interrupted by a worker restart. Run the action again.', errorCode: 'INTERRUPTED' },
      });
      control++;
    }
    // chatgpt jobs belong to the extension; their leases are handled by sweepExpiredLeases.
  }
  chatgpt = await sweepExpiredLeases();
  if (article + chatgpt + control > 0) {
    await log({ level: 'warn', category: 'recovery', message: `Startup recovery: ${article} article/workflow job(s) requeued, ${chatgpt} ChatGPT lease(s) recovered, ${control} control job(s) marked interrupted.` });
  }
  return { article, chatgpt, control };
}

/** Requeue ChatGPT jobs whose extension tab stopped heartbeating. */
export async function sweepExpiredLeases(now = new Date()): Promise<number> {
  const expired = await db.queueJob.findMany({ where: { queue: 'chatgpt', status: 'ACTIVE', leaseUntil: { lt: now } } });
  for (const job of expired) {
    const progress = job.progress ? (JSON.parse(job.progress) as ChatGPTJobProgress) : {};
    await db.queueJob.updateMany({
      where: { id: job.id, status: 'ACTIVE' },
      data: { status: 'WAITING', runAt: now, lockedBy: null, claimedByTab: null, leaseUntil: null, attempts: { decrement: 1 }, error: 'Extension tab stopped responding; requeued.' },
    });
    if (progress.sent) {
      await openIncident({
        kind: 'UNCERTAIN_PROMPT',
        severity: 'warning',
        jobId: job.id,
        taskId: job.taskId,
        description: 'A ChatGPT prompt was sent but the tab stopped responding before the answer was saved. The next claim reconciles the saved conversation before any resend.',
        evidence: { conversationUrl: progress.conversationUrl ?? null, sentAt: progress.sentAt ?? null },
        dedupeKey: `lease:${job.id}:${progress.sentAt ?? ''}`,
      });
    }
  }
  return expired.length;
}

/**
 * Self-heal: a task in a running status with no live article job would hang
 * forever. Re-enqueue it (never silently drop a job).
 */
export async function healOrphanedTasks(): Promise<number> {
  const running = await db.articleTask.findMany({ where: { status: { in: [...RUNNING_STATUSES, 'QUEUED'] } }, select: { id: true, status: true, updatedAt: true } });
  let healed = 0;
  for (const task of running) {
    const live = await db.queueJob.count({ where: { taskId: task.id, queue: { in: ['article', 'chatgpt'] }, status: { in: ['WAITING', 'ACTIVE'] } } });
    if (live > 0) continue;
    if (Date.now() - task.updatedAt.getTime() < 30_000) continue;
    await ensureArticleRun(task.id, 'self-heal');
    await openIncident({
      kind: 'STALLED',
      severity: 'info',
      status: 'AUTO_RESOLVED',
      taskId: task.id,
      description: `Task was ${task.status} without any queued job; a new run was queued.`,
      resolution: 'Re-enqueued automatically.',
      dedupeKey: `orphan:${task.id}:${task.updatedAt.toISOString()}`,
    });
    healed++;
  }
  return healed;
}
