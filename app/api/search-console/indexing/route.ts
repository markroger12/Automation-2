import { z } from 'zod';
import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { enqueue } from '@/lib/queue';
import { indexingOverview, requestWaitingNow } from '@/lib/gsc/request-indexing';

/** “Request indexing” in Search Console by Automation Chrome: what was requested, what waits and why. */
export const GET = route({}, async () => indexingOverview());

/**
 * `signin`: open Google's sign-in (continuing to Search Console) in Automation Chrome, for the owner to sign in there.
 * `now`: make the requests that waited for the sign-in now (not the daily limit).
 */
export const POST = route({ body: z.object({ action: z.enum(['signin', 'now']) }) }, async ({ body }) => {
  if (body.action === 'now') return requestWaitingNow();
  const live = await db.queueJob.findFirst({ where: { queue: 'control', kind: 'chrome.google-signin', status: { in: ['WAITING', 'ACTIVE'] } } });
  if (live) return { jobId: live.id };
  const count = await db.queueJob.count({ where: { queue: 'control', kind: 'chrome.google-signin' } });
  const { job } = await enqueue({ queue: 'control', kind: 'chrome.google-signin', idempotencyKey: `chrome.google-signin:${count + 1}`, maxAttempts: 1 });
  return { jobId: job.id };
});
