import { claimNext, completeJob, failJob, parsePayload, releaseJob } from '@/lib/queue';
import { getSettings } from '@/lib/settings';
import { errorMessage, log } from '@/lib/log';
import { processPostUpdate } from '@/lib/posts/service';
import { failUpdate } from '@/wordpress/post-updates';

/**
 * “Update to latest”: waits for ChatGPT's answer to a post update (woken when it arrives, with a slow fallback poll),
 * then checks it (lib/posts/service.ts). Waiting never uses up retry attempts.
 */
export async function postUpdateTick(workerId: string, stopping: () => boolean): Promise<void> {
  const settings = await getSettings();
  const leaseMs = settings.advanced.operationLeaseSeconds * 1000;
  for (let i = 0; i < 5 && !stopping(); i++) {
    const job = await claimNext({ queue: 'post-update', owner: workerId, leaseMs });
    if (!job) return;
    const updateId = parsePayload<{ updateId?: string }>(job).updateId ?? job.relatedId ?? '';
    try {
      const result = await processPostUpdate(updateId);
      if (result.state === 'waiting') await releaseJob(job.id, workerId, { runAt: new Date(Date.now() + 60_000), countAttempt: false, progress: result.message });
      else await completeJob(job.id, workerId, { message: result.message });
    } catch (error) {
      const message = errorMessage(error);
      const outcome = await failJob(job.id, workerId, { error: message, retryable: true, retryAt: new Date(Date.now() + 30_000) });
      if (outcome === 'failed') await failUpdate(updateId, `The answer could not be checked: ${message}`);
      await log({ level: 'warn', category: 'wordpress', message: `Post update ${updateId}: ${message} (${outcome})` });
    }
  }
}
