import { claimNext, completeJob, failJob, heartbeatJob, parsePayload } from '@/lib/queue';
import { getSettings } from '@/lib/settings';
import { errorMessage, log } from '@/lib/log';
import { runPlagiarismCheck } from '@/lib/plagiarism/check';
import { failPlagiarismCheck } from '@/lib/plagiarism/service';
import { buildLedger } from '@/lib/research/ledger';
import { evaluateRefresh } from '@/lib/refresh/service';

/**
 * Evidence jobs that fetch outside pages — plagiarism checks, research
 * evidence re-checks and content refresh evaluations (workflow queue) — one
 * at a time in their own loop, so
 * slow fetches never hold up campaign queueing. A job interrupted by a
 * restart is requeued and starts over.
 */
let running = false;

export async function plagiarismTick(workerId: string, stopping: () => boolean): Promise<void> {
  if (running || stopping()) return;
  running = true;
  try {
    const settings = await getSettings();
    const leaseMs = settings.advanced.operationLeaseSeconds * 1000;
    const job = await claimNext({ queue: 'workflow', owner: workerId, leaseMs, kinds: ['plagiarism.check', 'research.recheck', 'refresh.evaluate'] });
    if (!job) return;
    if (job.kind === 'refresh.evaluate') {
      // Content refresh evaluation: read-only (fetches linked pages, records candidates).
      const websiteId = parsePayload<{ websiteId?: string }>(job).websiteId ?? job.websiteId ?? '';
      try {
        const result = await evaluateRefresh(websiteId, new Date());
        await completeJob(job.id, workerId, { ...result });
      } catch (error) {
        const outcome = await failJob(job.id, workerId, { error: errorMessage(error), retryable: true, retryAt: new Date(Date.now() + 60_000) });
        await log({ level: 'warn', category: 'refresh', message: `Refresh evaluation failed: ${errorMessage(error)} (${outcome})` });
      }
      return;
    }
    if (job.kind === 'research.recheck') {
      // Evidence re-check: fetch the cited sources again and rebuild the ledger.
      const taskId = parsePayload<{ taskId?: string }>(job).taskId ?? job.relatedId ?? '';
      try {
        const summary = await buildLedger(taskId, new Date(), { refetch: true });
        await completeJob(job.id, workerId, { claims: summary.claims, sources: summary.sources });
      } catch (error) {
        const outcome = await failJob(job.id, workerId, { error: errorMessage(error), retryable: true, retryAt: new Date(Date.now() + 30_000) });
        await log({ level: 'warn', category: 'research', taskId, message: `Evidence re-check failed: ${errorMessage(error)} (${outcome})` });
      }
      return;
    }
    const checkId = parsePayload<{ checkId?: string }>(job).checkId ?? job.relatedId ?? '';
    try {
      const result = await runPlagiarismCheck(checkId, () => heartbeatJob(job.id, workerId, leaseMs));
      await completeJob(job.id, workerId, result);
    } catch (error) {
      const message = errorMessage(error);
      const outcome = await failJob(job.id, workerId, { error: message, retryable: true, retryAt: new Date(Date.now() + 30_000) });
      if (outcome === 'failed') await failPlagiarismCheck(checkId, message);
      await log({ level: 'warn', category: 'plagiarism', message: `Plagiarism check ${checkId}: ${message} (${outcome})` });
    }
  } finally {
    running = false;
  }
}
