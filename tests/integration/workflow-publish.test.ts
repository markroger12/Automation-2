import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient, Website } from '@prisma/client';
import type { BrowserContext } from 'playwright';
import { setupTestDb } from '../helpers/test-db';
import { configureTestBrowser } from '../helpers/browser';
import { makeDriver } from '../helpers/drive';
import { startFakeWordPress, type FakeWp } from '../fixtures/fake-wordpress';

/**
 * The approved publishing path against the fake WordPress: a verified draft
 * of a READY workflow keyword is scheduled for its slot only when the site
 * allows publishing, through withPublishPermit, and read back; after the
 * slot, publication is verified. Real WordPress coverage: tests/e2e.
 */
let client: PrismaClient;
let browser: typeof import('@/wordpress/browser');
let session: typeof import('@/wordpress/session');
let schedule: typeof import('@/wordpress/schedule');
let wp: FakeWp;
let site: Website;
let workflowId: string;

async function draftTask(keyword: string, key: string) {
  const create = await import('@/lib/tasks/create');
  const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword, websiteId: site.id, options: { images: 'off', externalLinks: false, internalLinks: false }, idempotencyKey: key }, { source: 'WORKFLOW' });
  const t = await makeDriver(client).drive(task.id);
  expect(t.status, t.reviewReasons).toBe('COMPLETED');
  return t;
}

async function readyKeyword(keyword: string, taskId: string, scheduledAt: Date) {
  const kw = await client.workflowKeyword.create({ data: { workflowId, keyword, normalizedKeyword: keyword.toLowerCase(), position: Math.floor(Math.random() * 1e6), writerType: 'TIGRAM', status: 'READY', taskId, scheduledAt } });
  await client.slotReservation.create({ data: { websiteId: site.id, scheduledAt, workflowKeywordId: kw.id } });
  return kw;
}

beforeAll(async () => {
  configureTestBrowser();
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  browser = await import('@/wordpress/browser');
  session = await import('@/wordpress/session');
  schedule = await import('@/wordpress/schedule');
  const { registerBuiltInPipelines } = await import('@/worker/pipelines');
  registerBuiltInPipelines();
  browser.onWordPressContext(async (context: BrowserContext) => {
    setTimeout(async () => {
      const page = context.pages()[0];
      if (!page || !/wp-login\.php/.test(page.url())) return;
      await page.fill('#user_login', 'owner').catch(() => {});
      await page.fill('#user_pass', 'owner-typed-this').catch(() => {});
      await page.click('#wp-submit').catch(() => {});
    }, 1200);
  });
  wp = await startFakeWordPress();
  const websites = await import('@/lib/websites');
  const created = await websites.createWebsite({ name: 'Publish Site', publicUrl: wp.url, language: 'en', targetCountry: 'United States', timezone: 'UTC' });
  site = await client.website.findUniqueOrThrow({ where: { id: created.id } });
  expect((await session.interactiveLogin(site, async () => true, 60_000)).state).toBe('ACTIVE');
  await session.syncCategories(site);
  await client.website.update({ where: { id: site.id }, data: { settingsOverrides: JSON.stringify({ content: {}, seo: { rankMathMode: 'off' }, workflow: {} }) } });
  site = await client.website.findUniqueOrThrow({ where: { id: site.id } });
  workflowId = (await client.workflow.create({ data: { websiteId: site.id, name: 'wf', active: true, slots: JSON.stringify(['9:00 AM', '3:00 PM']), writeAheadHours: 0, maxRetries: 3 } })).id;
});

afterAll(async () => {
  await browser.closeAllContexts();
  await wp.close();
});

describe('approved publishing path', () => {
  it('without publishing permission nothing is opened or changed: the draft waits', async () => {
    const t = await draftTask('How to Install WordPress', 'pub:draft-1');
    const kw = await readyKeyword('How to Install WordPress', t.id, new Date(Date.now() + 3 * 3_600_000));
    expect(await schedule.scheduleKeywordPost(kw.id)).toEqual({ skipped: 'publishing not allowed' });
    expect(wp.posts.get(t.wpPostId!)!.status).toBe('draft');
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } })).lastError).toMatch(/Publishing is off/);
  });

  it('the guard refuses a future status from anywhere except inside a publish permit', async () => {
    const t = await client.articleTask.findFirstOrThrow({ where: { idempotencyKey: 'pub:draft-1' } });
    const { WpClient } = await import('@/wordpress/client');
    const { PublishNotAllowedError } = await import('@/wordpress/publish-guard');
    const err = await browser.withSiteContext(session.siteRef(site), { headed: false, purpose: 'test' }, async (context) => {
      const c = await WpClient.connect(context, session.siteRef(site));
      return c.scheduleFuture(t.wpPostId!, new Date(Date.now() + 3_600_000)).then(() => null, (e: unknown) => e);
    });
    expect(err).toBeInstanceOf(PublishNotAllowedError);
    expect(wp.posts.get(t.wpPostId!)!.status).toBe('draft');
    expect(await client.auditLog.count({ where: { action: 'publish.blocked' } })).toBeGreaterThan(0);
  });

  it('with permission (switch + acknowledgement) the draft is scheduled for its slot and verified; repeating changes nothing', async () => {
    await client.website.update({ where: { id: site.id }, data: { canPublish: true, canPublishAcknowledgedAt: new Date() } });
    const t = await client.articleTask.findFirstOrThrow({ where: { idempotencyKey: 'pub:draft-1' } });
    const kw = await client.workflowKeyword.findFirstOrThrow({ where: { taskId: t.id } });
    const res = await schedule.scheduleKeywordPost(kw.id);
    expect(res).toMatchObject({ scheduled: true, postId: t.wpPostId });
    const post = wp.posts.get(t.wpPostId!)!;
    expect(post.status).toBe('future');
    expect(Date.parse(`${post.date_gmt}Z`)).toBe(Math.floor(kw.scheduledAt!.getTime() / 1000) * 1000);
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } })).status).toBe('SCHEDULED');
    expect(await client.auditLog.count({ where: { action: 'publish.permit', entityId: site.id } })).toBe(1);
    expect(await client.auditLog.count({ where: { action: 'workflow.scheduled', entityId: kw.id } })).toBe(1);
    // A second job for the same keyword is a no-op.
    expect(await schedule.scheduleKeywordPost(kw.id)).toEqual({ skipped: 'keyword is SCHEDULED' });
  });

  it('after the slot, publication is verified from WordPress (status read back), never assumed', async () => {
    const t = await client.articleTask.findFirstOrThrow({ where: { idempotencyKey: 'pub:draft-1' } });
    const kw = await client.workflowKeyword.findFirstOrThrow({ where: { taskId: t.id } });
    expect(await schedule.verifyKeywordPublished(kw.id)).toEqual({ published: false, status: 'future' });
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } })).lastError).toMatch(/still shows “future”/);
    // WordPress's own scheduler publishes when the time comes (the fixture mimics WP-Cron).
    wp.posts.get(t.wpPostId!)!.date_gmt = new Date(Date.now() - 60_000).toISOString().slice(0, 19);
    const res = await schedule.verifyKeywordPublished(kw.id);
    expect(res).toMatchObject({ published: true });
    const after = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(after.status).toBe('PUBLISHED');
    expect(after.publishedUrl).toContain(`?p=${t.wpPostId}`);
  });

  it('a scheduled post trashed in WordPress is left alone: the keyword fails with the reason and checks stop', async () => {
    const t = await draftTask('How to Change a WordPress Theme', 'pub:draft-3');
    const kw = await readyKeyword('How to Change a WordPress Theme', t.id, new Date(Date.now() + 3 * 3_600_000));
    expect(await schedule.scheduleKeywordPost(kw.id)).toMatchObject({ scheduled: true });
    wp.posts.get(t.wpPostId!)!.status = 'trash';
    expect(await schedule.verifyKeywordPublished(kw.id)).toEqual({ published: false, status: 'trash' });
    const row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row.status).toBe('FAILED');
    expect(row.lastError).toMatch(/changed to “trash” in WordPress; it was left alone/);
    expect(wp.posts.get(t.wpPostId!)!.status).toBe('trash');
    expect(await schedule.verifyKeywordPublished(kw.id)).toEqual({ skipped: 'not scheduled' });
  });

  it('owner report: a draft the owner published in WordPress (not at its slot) shows on the day it was published, and its slot is free again', async () => {
    const t = await draftTask('How to Speed Up WordPress', 'pub:draft-4');
    const slot = new Date(Date.now() + 27 * 3_600_000);
    const kw = await readyKeyword('How to Speed Up WordPress', t.id, slot);
    // The owner published the draft themselves today (the keyword said “publish it yourself”).
    const publishedAt = new Date(Math.floor((Date.now() - 2 * 3_600_000) / 1000) * 1000);
    Object.assign(wp.posts.get(t.wpPostId!)!, { status: 'publish', date_gmt: publishedAt.toISOString().slice(0, 19) });
    expect(await schedule.scheduleKeywordPost(kw.id)).toEqual({ published: true });
    const row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row.status).toBe('PUBLISHED');
    expect(row.publishedAt?.toISOString()).toBe(publishedAt.toISOString());
    // Before: it stayed on tomorrow's slot in the calendar, and that slot stayed reserved.
    expect(row.scheduledAt?.toISOString()).toBe(publishedAt.toISOString());
    expect(await client.slotReservation.count({ where: { workflowKeywordId: kw.id } })).toBe(0);
    const { calendar } = await import('@/lib/workflow/service');
    const cal = await calendar(new Date(Date.now() - 86_400_000).toISOString(), 3);
    expect(cal.entries.find((e) => e.keywordId === kw.id)?.at).toBe(publishedAt.toISOString());
    expect(await client.auditLog.count({ where: { action: 'publish.permit', details: { contains: 'Speed Up' } } })).toBe(0); // nothing was published by the tool
  });

  it('owner report: “Regenerate images” on a post the workflow scheduled updates it and keeps it scheduled (before: “already future”, stopped)', async () => {
    const { regenerateStage } = await import('@/lib/tasks/actions');
    await client.website.update({ where: { id: site.id }, data: { canPublish: true, canPublishAcknowledgedAt: new Date() } });
    const t = await draftTask('How to Add a WordPress Logo', 'pub:regen-1');
    const slot = new Date(Date.now() + 5 * 3_600_000);
    const kw = await readyKeyword('How to Add a WordPress Logo', t.id, slot);
    expect(await schedule.scheduleKeywordPost(kw.id)).toMatchObject({ scheduled: true });
    const dateBefore = wp.posts.get(t.wpPostId!)!.date_gmt;
    // The owner regenerates; the article changes (here its title), so the scheduled post must be updated.
    await regenerateStage(t.id, 'IMAGES');
    await client.articleTask.update({ where: { id: t.id }, data: { selectedTitle: 'How to Add a Logo in WordPress' } });
    const after = await makeDriver(client).drive(t.id);
    expect(after.status, `${after.message} ${after.reviewReasons}`).toBe('COMPLETED');
    const post = wp.posts.get(t.wpPostId!)!;
    expect(post.title).toBe('How to Add a Logo in WordPress');
    // Still scheduled for its slot: no status was sent, nothing published early.
    expect(post.status).toBe('future');
    expect(post.date_gmt).toBe(dateBefore);
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } })).status).toBe('SCHEDULED');
    expect(await client.auditLog.count({ where: { action: 'publish.permit', details: { contains: 'Add a WordPress Logo' } } })).toBe(1); // only the scheduling itself

    // A post scheduled in WordPress by someone else (no workflow keyword scheduled it) is still left alone.
    const other = await draftTask('How to Add a WordPress Favicon', 'pub:regen-2');
    Object.assign(wp.posts.get(other.wpPostId!)!, { status: 'future', date_gmt: new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 19) });
    const titleBefore = wp.posts.get(other.wpPostId!)!.title;
    await regenerateStage(other.id, 'IMAGES');
    await client.articleTask.update({ where: { id: other.id }, data: { selectedTitle: 'How to Add a Favicon in WordPress' } });
    const stopped = await makeDriver(client).drive(other.id);
    expect(stopped.status).toBe('NEEDS_REVIEW');
    expect(stopped.message).toMatch(/already “future”/);
    expect(wp.posts.get(other.wpPostId!)!.title).toBe(titleBefore);
  });

  it('a slot too close to schedule safely moves to the next free slot instead of publishing early', async () => {
    const t = await draftTask('How to Back Up WordPress', 'pub:draft-2');
    const kw = await readyKeyword('How to Back Up WordPress', t.id, new Date(Date.now() + 60_000));
    expect(await schedule.scheduleKeywordPost(kw.id)).toEqual({ moved: true });
    const row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row.scheduledAt!.getTime()).toBeGreaterThan(Date.now() + 2 * 60_000);
    expect(row.retries).toBe(1);
    expect(wp.posts.get(t.wpPostId!)!.status).toBe('draft');
    // The scheduler tick then queues exactly one schedule job for the new slot.
    const { schedulerTick } = await import('@/lib/workflow/scheduler');
    const r = await schedulerTick(new Date());
    expect(r.scheduleJobs).toBe(1);
  });

  it('owner request: a post scheduled in WordPress moved to another day gets its new time in WordPress (approved path, read back)', async () => {
    await client.website.update({ where: { id: site.id }, data: { canPublish: true, canPublishAcknowledgedAt: new Date() } });
    const t = await draftTask('How to Move a WordPress Site', 'pub:move-1');
    const first = new Date(Math.floor((Date.now() + 3 * 3_600_000) / 60_000) * 60_000);
    const kw = await readyKeyword('How to Move a WordPress Site', t.id, first);
    expect(await schedule.scheduleKeywordPost(kw.id)).toMatchObject({ scheduled: true });
    expect(wp.posts.get(t.wpPostId!)!.status).toBe('future');

    // Move it to the day after tomorrow (Pakistan time): the first slot of that day, 9:00 AM = 04:00 UTC.
    const day = new Date(Date.now() + 5 * 3_600_000 + 2 * 86_400_000).toISOString().slice(0, 10);
    const service = await import('@/lib/workflow/service');
    const moved = await service.keywordAction(site.id, { keywordIds: [kw.id], action: 'move', date: day });
    expect(moved.changed).toBe(1);
    const row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row.status).toBe('READY');
    expect(row.scheduledAt!.toISOString()).toBe(`${day}T04:00:00.000Z`);
    expect(await client.queueJob.count({ where: { kind: 'wp.schedule', relatedId: kw.id, status: 'WAITING' } })).toBe(1);

    // The worker's schedule job: the post's time in WordPress changes, and it is read back.
    expect(await schedule.scheduleKeywordPost(kw.id)).toMatchObject({ scheduled: true, at: `${day}T04:00:00.000Z` });
    const post = wp.posts.get(t.wpPostId!)!;
    expect(post.status).toBe('future');
    expect(post.date_gmt).toBe(`${day}T04:00:00`);
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } })).status).toBe('SCHEDULED');
  });
});
