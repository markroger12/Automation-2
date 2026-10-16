import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

/** “Approve selected” on the queue (owner request): each task gets the approval it is waiting for. */
let client: PrismaClient;
let siteId: string;
let create: typeof import('@/lib/tasks/create');

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  create = await import('@/lib/tasks/create');
  const websites = await import('@/lib/websites');
  siteId = (await websites.createWebsite({ name: 'Approve Blog', publicUrl: 'https://approve.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
});

async function taskIn(status: string, key: string, data: Record<string, unknown> = {}) {
  const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword: `Approve test ${key}`, websiteId: siteId, options: { images: 'off', saveToWordPress: false }, idempotencyKey: `approve:${key}` }, { source: 'SINGLE', enqueue: false });
  return client.articleTask.update({ where: { id: task.id }, data: { status, ...data } });
}

describe('bulk approve', () => {
  it('approves the title, the article, a review and a duplicate keyword; skips tasks not waiting for approval', async () => {
    const { approveWaiting } = await import('@/lib/tasks/actions');
    const title = await taskIn('AWAITING_TITLE_APPROVAL', 'title', { recommendedTitle: 'How to Approve Many Articles at Once' });
    const article = await taskIn('AWAITING_ARTICLE_APPROVAL', 'article');
    const review = await taskIn('NEEDS_REVIEW', 'review', { reviewReasons: JSON.stringify(['SEO score 62 is below 70']) });
    const duplicate = await taskIn('NEEDS_REVIEW', 'duplicate', { reviewReasons: JSON.stringify(['Duplicate keyword on this site: “Approve test”']) });
    const running = await taskIn('WRITING_ARTICLE', 'running');

    expect(await approveWaiting(title.id, '')).toBe('title');
    expect(await client.articleTask.findUniqueOrThrow({ where: { id: title.id } })).toMatchObject({ selectedTitle: 'How to Approve Many Articles at Once', titleApprovedAt: expect.any(Date) });
    expect(await approveWaiting(article.id, '')).toBe('article');
    expect((await client.articleTask.findUniqueOrThrow({ where: { id: article.id } })).articleApprovedAt).toBeInstanceOf(Date);
    await expect(approveWaiting(review.id, '')).rejects.toThrow(/reason/i); // a review approval needs the owner's reason
    expect(await approveWaiting(review.id, 'checked the SEO notes')).toBe('review');
    const reviewed = await client.articleTask.findUniqueOrThrow({ where: { id: review.id } });
    expect(reviewed.status).toBe('QUEUED');
    expect(JSON.parse(reviewed.options)).toMatchObject({ qualityOverride: true, qualityOverrideReason: 'checked the SEO notes' });
    expect(await approveWaiting(duplicate.id, '')).toBe('duplicate');
    expect(JSON.parse((await client.articleTask.findUniqueOrThrow({ where: { id: duplicate.id } })).options)).toMatchObject({ allowDuplicate: true });
    await expect(approveWaiting(running.id, '')).rejects.toThrow(/not waiting for an approval \(writing article\)/);
    // Each approval is audited, like on the article page.
    expect(await client.auditLog.count({ where: { action: { in: ['task.approve-title', 'task.approve-article', 'task.quality-override', 'task.allow-duplicate'] }, entityId: { in: [title.id, article.id, review.id, duplicate.id] } } })).toBe(4);
  });
});
