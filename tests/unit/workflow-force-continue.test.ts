import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

/**
 * Owner report (malaak compton-rock): “Draft #1344 saved but not published: 12 % of the wording … repeats … on
 * Techeflux.” Retry could not get it out of that state (it stopped again at once), so the owner asked for “Force
 * continue”: the owner accepts the problems for that keyword, and the draft is published at the next free slot.
 */
let client: PrismaClient;
let siteId: string;
let categoryId: string;
let workflowId: string;
let create: typeof import('@/lib/tasks/create');
let service: typeof import('@/lib/workflow/service');
let scheduler: typeof import('@/lib/workflow/scheduler');

const BLOCKED = '12 % of the wording (longest identical run 68 words, 5 identical paragraph(s)) repeats “Who Is Malaak Compton-Rock? All About Chris Rock’s Ex-Wife” on Techeflux. See Duplicate Review.';

async function blockedKeyword(keyword: string, key: string) {
  const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword, websiteId: siteId, categoryId, options: { images: 'off' }, idempotencyKey: key }, { source: 'WORKFLOW' });
  await client.articleTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', wpPostId: 1344, wpVerifiedAt: new Date(), options: JSON.stringify({ images: 'off', publishBlocked: [BLOCKED] }) } });
  await client.duplicateMatch.create({ data: { taskId: task.id, otherTaskId: 'other-task', otherTitle: 'Who Is Malaak Compton-Rock?', otherWebsite: 'Techeflux', sameWebsite: false, severity: 'HIGH', wordingWords: 150, factWords: 10, longestRun: 68, nearSentences: 1, exactParagraphs: 5, wordingShare: 0.12, excerpts: '[]', status: 'OPEN' } });
  const kw = await client.workflowKeyword.create({ data: { workflowId, keyword, normalizedKeyword: keyword.toLowerCase(), position: 1, writerType: 'CELEBRITY', status: 'WRITING', taskId: task.id, scheduledAt: new Date(Date.now() + 6 * 3600_000) } });
  return { task, kw };
}

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  create = await import('@/lib/tasks/create');
  service = await import('@/lib/workflow/service');
  scheduler = await import('@/lib/workflow/scheduler');
  const websites = await import('@/lib/websites');
  siteId = (await websites.createWebsite({ name: 'Publishing Site', publicUrl: 'https://publishing.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
  await client.website.update({ where: { id: siteId }, data: { canPublish: true, canPublishAcknowledgedAt: new Date() } });
  categoryId = (await client.category.create({ data: { websiteId: siteId, externalId: 3, name: 'Celebrities' } })).id;
  workflowId = (await client.workflow.create({ data: { websiteId: siteId, name: 'wf', active: true, slots: JSON.stringify(['9:00 AM', '3:00 PM']), writeAheadHours: 0, maxRetries: 3 } })).id;
});

describe('owner request: Force continue for a draft stopped by the quality check', () => {
  it('Retry says to use Force continue (before: it stopped again at once); Force continue publishes at the next free slot, recorded', async () => {
    const { task, kw } = await blockedKeyword('malaak compton-rock', 'force-continue:1');
    await scheduler.schedulerTick();
    let row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row.status).toBe('FAILED');
    expect(row.lastError).toMatch(/^Draft #1344 saved but not published: 12 % of the wording.*use Force continue to publish it at the next free slot anyway\.$/);

    // Retry: nothing changes, and the note says what to do.
    const retried = await service.keywordAction(siteId, { keywordIds: [kw.id], action: 'retry' });
    expect(retried.changed).toBe(0);
    expect(retried.notes[0]).toMatch(/serious problems, so Retry would stop again\. Use Force continue/);
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } })).status).toBe('FAILED');

    // Force continue: the block is lifted (problems kept as a record), the duplicate match is overridden, a new slot.
    const forced = await service.keywordAction(siteId, { keywordIds: [kw.id], action: 'force' });
    expect(forced).toMatchObject({ changed: 1, notes: [] });
    const t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    const options = JSON.parse(t.options);
    expect(options.publishBlocked).toBeUndefined();
    expect(options.publishForced.problems).toEqual([BLOCKED]);
    expect(options.duplicateOverride.reason).toBe('Force continue from the workflow keyword queue');
    expect(await client.duplicateMatch.count({ where: { taskId: task.id, status: 'OVERRIDDEN' } })).toBe(1);
    expect(await client.auditLog.count({ where: { action: 'task.force-continue', entityId: task.id } })).toBe(1);
    row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row.status).toBe('WRITING');
    expect(row.scheduledAt).not.toBeNull();
    expect(await client.slotReservation.count({ where: { workflowKeywordId: kw.id } })).toBe(1);

    // The scheduler now treats it as any verified draft: READY for its slot (scheduled in WordPress before the slot).
    await scheduler.schedulerTick();
    row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row.status).toBe('READY');
    expect(row.lastError).toBeNull();
  });

  it('a keyword that is not stopped, or whose article failed for another reason, is not forced', async () => {
    const waiting = await client.workflowKeyword.create({ data: { workflowId, keyword: 'Not Started', normalizedKeyword: 'not started', position: 5, status: 'WAITING' } });
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Broken Article', websiteId: siteId, categoryId, options: { images: 'off' }, idempotencyKey: 'force-continue:2' }, { source: 'WORKFLOW' });
    await client.articleTask.update({ where: { id: task.id }, data: { status: 'FAILED', message: 'Chat composer not found' } });
    const failed = await client.workflowKeyword.create({ data: { workflowId, keyword: 'Broken Article', normalizedKeyword: 'broken article', position: 6, status: 'FAILED', taskId: task.id } });
    const r = await service.keywordAction(siteId, { keywordIds: [waiting.id, failed.id], action: 'force' });
    expect(r.changed).toBe(0);
    expect(r.notes.join(' ')).toMatch(/“Not Started” is not stopped by a problem/);
    expect(r.notes.join(' ')).toMatch(/“Broken Article”: its article failed \(Chat composer not found\)\. Use Retry\./);
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: failed.id } })).status).toBe('FAILED');
  });

  it('an article held for review continues as with “Approve despite review reasons”', async () => {
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Held Article', websiteId: siteId, categoryId, options: { images: 'off' }, idempotencyKey: 'force-continue:3' }, { source: 'WORKFLOW' });
    await client.articleTask.update({ where: { id: task.id }, data: { status: 'NEEDS_REVIEW', reviewReasons: JSON.stringify(['SEO score 61 is below 70. [SEO]']) } });
    const kw = await client.workflowKeyword.create({ data: { workflowId, keyword: 'Held Article', normalizedKeyword: 'held article', position: 7, status: 'FAILED', taskId: task.id } });
    const r = await service.keywordAction(siteId, { keywordIds: [kw.id], action: 'force' });
    expect(r.changed).toBe(1);
    const t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('QUEUED');
    expect(JSON.parse(t.options)).toMatchObject({ qualityOverride: true, qualityOverrideReason: 'Force continue from the workflow keyword queue' });
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } })).status).toBe('WRITING');
  });
});

describe('owner report: an article published today showed on tomorrow’s slot in the calendar', () => {
  it('the data migration moves published keywords to their real publish time and frees the slot; on-slot ones stay', async () => {
    const tomorrow = new Date('2026-10-23T12:00:00.000Z'); // 5:00 PM in Pakistan
    const today = new Date('2026-10-22T09:13:00.000Z');
    const off = await client.workflowKeyword.create({ data: { workflowId, keyword: 'malaak compton-rock (published)', normalizedKeyword: 'malaak published', position: 20, status: 'PUBLISHED', scheduledAt: tomorrow, publishedAt: today, publishedUrl: 'https://publishing.example/malaak/' } });
    await client.slotReservation.create({ data: { websiteId: siteId, scheduledAt: tomorrow, workflowKeywordId: off.id } });
    const onSlot = new Date('2026-10-22T12:30:00.000Z');
    const normal = await client.workflowKeyword.create({ data: { workflowId, keyword: 'Andi Rock', normalizedKeyword: 'andi rock', position: 21, status: 'INDEXING_REQUESTED', scheduledAt: onSlot, publishedAt: onSlot } });
    await client.slotReservation.create({ data: { websiteId: siteId, scheduledAt: onSlot, workflowKeywordId: normal.id } });

    // Registered (it ran once when this test database was set up, before these rows existed).
    const { runDataMigrations } = await import('@/lib/data-migrations');
    expect((await runDataMigrations(client)).join(' ')).toMatch(/2026-10-22-published-at-real-time: already applied/);
    const { publishedAtRealTime } = await import('@/lib/published-slot-migration');
    const report = await publishedAtRealTime(client);
    expect(report).toMatchObject({ moved: [{ keyword: 'malaak compton-rock (published)', from: tomorrow.toISOString(), to: today.toISOString() }], backupFile: expect.stringContaining('2026-10-22-published-at-real-time.json') });

    const moved = await client.workflowKeyword.findUniqueOrThrow({ where: { id: off.id } });
    expect(moved.scheduledAt?.toISOString()).toBe(today.toISOString());
    expect(await client.slotReservation.count({ where: { workflowKeywordId: off.id } })).toBe(0);
    // The keyword published at its slot keeps it.
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: normal.id } })).scheduledAt?.toISOString()).toBe(onSlot.toISOString());
    expect(await client.slotReservation.count({ where: { workflowKeywordId: normal.id } })).toBe(1);
    // Nothing left to move.
    expect(await publishedAtRealTime(client)).toMatchObject({ moved: [] });
  });
});
