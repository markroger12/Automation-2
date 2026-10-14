import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { enqueue } from '@/lib/queue';

/** Ask the worker to launch the dedicated Automation Chrome profile. */
export const POST = route({}, async () => {
  const live = await db.queueJob.findFirst({ where: { queue: 'control', kind: 'chrome.launch', status: { in: ['WAITING', 'ACTIVE'] } } });
  if (live) return { jobId: live.id };
  const count = await db.queueJob.count({ where: { queue: 'control', kind: 'chrome.launch' } });
  const { job } = await enqueue({ queue: 'control', kind: 'chrome.launch', idempotencyKey: `chrome.launch:${count + 1}`, maxAttempts: 1 });
  return { jobId: job.id };
});
