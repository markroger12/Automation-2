import { z } from 'zod';
import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { enqueue } from '@/lib/queue';
import { promptFingerprint } from '@/lib/chatgpt/normalize';
import { getSettings } from '@/lib/settings';

/**
 * Queue a diagnostic prompt (not tied to an article) to prove the full
 * extension round trip: stored prompt → real ChatGPT answer → saved result.
 */
export const POST = route({ body: z.object({ prompt: z.string().trim().min(2).max(2000).default('Reply with exactly: Blog Automation Studio connection OK') }) }, async ({ body }) => {
  const settings = await getSettings();
  const operationId = `diag:${Date.now()}`;
  const { job } = await enqueue({
    queue: 'chatgpt',
    kind: 'chatgpt.diagnostic',
    idempotencyKey: `chatgpt:${operationId}`,
    priority: 100,
    maxAttempts: 2,
    payload: {
      operationId,
      taskId: null,
      stageKey: 'DIAGNOSTIC',
      prompt: body.prompt,
      promptHash: promptFingerprint(body.prompt),
      conversationUrl: null,
      newChat: true,
      attachments: [],
      expectImages: false,
      timeoutSec: settings.browser.generationTimeoutSec,
      language: 'en',
    },
  });
  return { jobId: job.id };
});

export const GET = route({}, async ({ searchParams }) => {
  const id = searchParams.get('jobId') ?? '';
  const job = await db.queueJob.findUnique({ where: { id }, select: { id: true, status: true, result: true, error: true, errorCode: true, claimedByTab: true, progress: true, kind: true } });
  if (!job || job.kind !== 'chatgpt.diagnostic') return { job: null };
  return { job };
});
