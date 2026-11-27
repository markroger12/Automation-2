import { db } from './db';
import { enqueue } from './queue';

/** Queue a WordPress session action for the worker (only the worker opens browsers); one at a time per kind and site. */
export async function enqueueSiteAction(websiteId: string, action: string): Promise<{ jobId: string; existing: boolean }> {
  const kind = `wp.${action}`;
  const live = await db.queueJob.findFirst({ where: { queue: 'control', kind, websiteId, status: { in: ['WAITING', 'ACTIVE'] } } });
  if (live) return { jobId: live.id, existing: true };
  const count = await db.queueJob.count({ where: { queue: 'control', kind, websiteId } });
  const { job } = await enqueue({ queue: 'control', kind, websiteId, idempotencyKey: `${kind}:${websiteId}:${count + 1}`, payload: { websiteId }, maxAttempts: 1 });
  return { jobId: job.id, existing: false };
}
