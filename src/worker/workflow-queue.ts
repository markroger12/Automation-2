import type { QueueJob } from '@prisma/client';
import { claimNext, completeJob, failJob, heartbeatJob, parsePayload } from '@/lib/queue';
import { getSettings } from '@/lib/settings';
import { errorMessage, log } from '@/lib/log';
import { queueCampaignRows } from '@/lib/campaigns/service';

/**
 * The workflow queue: bulk-campaign queueing and (M10b) the publishing
 * scheduler. Every handler here is safe to repeat, so a job interrupted by a
 * restart is simply requeued by startup recovery and continues.
 */
type Handler = (job: QueueJob, payload: Record<string, unknown>, heartbeat: () => Promise<unknown>) => Promise<unknown>;
const handlers = new Map<string, Handler>([['campaign.enqueue', (job, payload, heartbeat) => queueCampaignRows(String(payload.campaignId ?? job.relatedId), heartbeat)]]);

export function registerWorkflowHandler(kind: string, handler: Handler) {
  handlers.set(kind, handler);
}

let running = false;

export async function workflowTick(workerId: string, stopping: () => boolean): Promise<void> {
  if (running || stopping()) return;
  running = true;
  try {
    const settings = await getSettings();
    const leaseMs = settings.advanced.operationLeaseSeconds * 1000;
    for (let i = 0; i < 5 && !stopping(); i++) {
      const job = await claimNext({ queue: 'workflow', owner: workerId, leaseMs, kinds: [...handlers.keys()] });
      if (!job) return;
      const heartbeat = () => heartbeatJob(job.id, workerId, leaseMs);
      try {
        const result = await handlers.get(job.kind)!(job, parsePayload<Record<string, unknown>>(job), heartbeat);
        await completeJob(job.id, workerId, result ?? {});
      } catch (error) {
        const message = errorMessage(error);
        const outcome = await failJob(job.id, workerId, { error: message, retryable: true, retryAt: new Date(Date.now() + 30_000) });
        await log({ level: 'warn', category: 'workflow', message: `${job.kind} failed: ${message} (${outcome})`, details: { jobId: job.id } });
      }
    }
  } finally {
    running = false;
  }
}
