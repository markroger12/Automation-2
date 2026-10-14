import type { PrismaClient } from '@prisma/client';
import { cannedAnswer } from './fake-answers';

/**
 * Drives the REAL engine for a task: claims article jobs, runs them, and
 * answers ChatGPT jobs with scripted canned text through the same bridge the
 * extension uses (no live ChatGPT).
 */
/** A text answer, an answer with generated images, or a permanent failure of that prompt (no retries left). */
export type ScriptedAnswer = string | { text: string; images?: Buffer[] } | { fail: string };

export function makeDriver(client: PrismaClient, answer: (stageKey: string, prompt: string, language: 'en' | 'de', keyword: string) => ScriptedAnswer = cannedAnswer) {
  const respond = async () => {
    const jobs = await import('@/lib/chatgpt/jobs');
    let answered = 0;
    for (;;) {
      const claim = await jobs.claimChatGPTJob({ installId: 'test', tabId: `t${answered}` });
      if (!('job' in claim)) break;
      const p = claim.payload;
      // Article prompts belong to a task; standalone Humanizer prompts belong to a run.
      const owner = p.taskId ? await client.articleTask.findUniqueOrThrow({ where: { id: p.taskId } }) : await client.humanizerRun.findUniqueOrThrow({ where: { id: p.runId! } });
      const a = answer(p.stageKey, p.prompt, owner.language === 'de' ? 'de' : 'en', owner.keyword);
      if (typeof a !== 'string' && 'fail' in a) {
        await client.queueJob.update({ where: { id: claim.job.id }, data: { maxAttempts: claim.job.attempts } });
        await jobs.failChatGPTJob({ jobId: claim.job.id, tabId: `t${answered}`, code: 'ERROR', message: a.fail });
        answered++;
        continue;
      }
      const text = typeof a === 'string' ? a : a.text;
      // Generated images arrive like the extension uploads them: stored and linked to the response.
      const images: { mediaAssetId: string }[] = [];
      if (typeof a !== 'string' && 'images' in a && a.images?.length && 'websiteId' in owner) {
        const { storeImage } = await import('@/images/store');
        for (const buffer of a.images) {
          const { asset } = await storeImage({ buffer, taskId: p.taskId, websiteId: owner.websiteId, role: 'GALLERY', origin: 'CHATGPT', responseId: claim.job.relatedId, sourceUrl: 'https://chatgpt.com/backend-api/estuary/content?id=file_test' });
          images.push({ mediaAssetId: asset.id });
        }
      }
      await jobs.completeChatGPTJob({
        jobId: claim.job.id,
        tabId: `t${answered}`,
        text,
        images,
        conversationUrl: 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555',
      });
      answered++;
    }
    return answered;
  };

  const SETTLED = ['COMPLETED', 'NEEDS_REVIEW', 'FAILED', 'CANCELLED', 'AWAITING_TITLE_APPROVAL', 'AWAITING_ARTICLE_APPROVAL', 'LOGIN_REQUIRED'];

  const drive = async (taskId: string, stopWhen?: (status: string, stage: string | null) => boolean, maxSteps = 120) => {
    const queue = await import('@/lib/queue');
    const engine = await import('@/worker/pipeline/engine');
    for (let i = 0; i < maxSteps; i++) {
      const t = await client.articleTask.findUniqueOrThrow({ where: { id: taskId } });
      if (stopWhen?.(t.status, t.stage)) return t;
      if (SETTLED.includes(t.status) && !(await client.queueJob.count({ where: { taskId, status: { in: ['WAITING', 'ACTIVE'] } } }))) return t;
      await client.queueJob.updateMany({ where: { taskId, queue: 'article', status: 'WAITING' }, data: { runAt: new Date(0) } });
      const job = await queue.claimNext({ queue: 'article', owner: 'test-worker', leaseMs: 120_000 });
      if (job) await engine.runArticleJob(job, { workerId: 'test-worker', leaseMs: 120_000, random: () => 0.5 });
      await respond();
    }
    throw new Error('pipeline did not settle');
  };

  return { drive, respond };
}
