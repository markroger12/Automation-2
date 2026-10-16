import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

/** Owner report: Resume on a task paused for a ChatGPT usage limit did nothing until the limit window passed. */
let client: PrismaClient;
let siteId: string;

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  const websites = await import('@/lib/websites');
  siteId = (await websites.createWebsite({ name: 'Promizeiten', publicUrl: 'https://promizeiten.example', language: 'de', targetCountry: 'Germany', timezone: 'UTC' })).id;
});

describe('Resume after a ChatGPT usage limit', () => {
  it('Resume tries ChatGPT again now instead of waiting for the limit window', async () => {
    const create = await import('@/lib/tasks/create');
    const jobs = await import('@/lib/chatgpt/jobs');
    const { inBackoff } = await import('@/lib/chatgpt/rate');
    const { resumeTask } = await import('@/lib/tasks/lifecycle');
    const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword: 'Daphne Govers', websiteId: siteId, options: { images: 'off', saveToWordPress: false }, idempotencyKey: 'resume:limit' }, { source: 'SINGLE' });
    await jobs.createChatGPTRequest({ task, stageKey: 'QUICK_BIO', attempt: 1, operationId: `${task.id}:QUICK_BIO:a1`, prompt: 'Quick bio please', newChat: false, timeoutSec: 600 });
    const first = await jobs.claimChatGPTJob({ installId: 'test', tabId: 't1' });
    expect('job' in first).toBe(true);
    if (!('job' in first)) return;
    await jobs.failChatGPTJob({ jobId: first.job.id, tabId: 't1', code: 'USAGE_LIMIT', message: "You've reached our limit of messages per hour. Please try again later." });
    const paused = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(paused).toMatchObject({ status: 'PAUSED', pausedFor: 'usage-limit' });
    expect(paused.nextAction).toMatch(/press Resume to try ChatGPT now/);
    expect(await inBackoff()).not.toBeNull();
    expect(await jobs.claimChatGPTJob({ installId: 'test', tabId: 't2' })).toMatchObject({ reason: 'backoff' });

    // The owner presses Resume: the wait is skipped and the prompt can be claimed at once.
    await resumeTask(task.id, 'owner-resume');
    expect(await inBackoff()).toBeNull();
    const resumed = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(resumed.status).not.toBe('PAUSED');
    expect(resumed.message).toMatch(/trying ChatGPT again now/);
    const again = await jobs.claimChatGPTJob({ installId: 'test', tabId: 't3' });
    expect('job' in again && again.job.id).toBe(first.job.id);
    expect(await client.log.count({ where: { taskId: task.id, message: { contains: 'usage-limit wait was skipped' } } })).toBe(1);
  });
});
