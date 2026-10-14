import { claimNext, completeJob, failJob, parsePayload, releaseJob } from '@/lib/queue';
import { getSettings } from '@/lib/settings';
import { errorMessage, log } from '@/lib/log';
import { failHumanizerRun, processHumanizerRun } from '@/lib/humanizer/runs';

/**
 * Humanizer page runs. A pass sends missing batch prompts or finishes the
 * run; while ChatGPT works the job waits (woken when an answer arrives, with a
 * slow fallback poll). Waiting never uses up retry attempts.
 */
export async function humanizerTick(workerId: string, stopping: () => boolean): Promise<void> {
  const settings = await getSettings();
  const leaseMs = settings.advanced.operationLeaseSeconds * 1000;
  for (let i = 0; i < 5 && !stopping(); i++) {
    const job = await claimNext({ queue: 'humanizer', owner: workerId, leaseMs });
    if (!job) return;
    const runId = parsePayload<{ runId?: string }>(job).runId ?? job.relatedId ?? '';
    try {
      const result = await processHumanizerRun(runId);
      if (result.state === 'waiting') await releaseJob(job.id, workerId, { runAt: new Date(Date.now() + 60_000), countAttempt: false, progress: result.message });
      else await completeJob(job.id, workerId, { message: result.message });
    } catch (error) {
      const message = errorMessage(error);
      const outcome = await failJob(job.id, workerId, { error: message, retryable: true, retryAt: new Date(Date.now() + 30_000) });
      if (outcome === 'failed') await failHumanizerRun(runId, message);
      await log({ level: 'warn', category: 'humanizer', message: `Humanizer run ${runId}: ${message} (${outcome})` });
    }
  }
}
