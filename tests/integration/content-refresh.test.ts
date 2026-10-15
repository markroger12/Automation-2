import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient, Website } from '@prisma/client';
import type { BrowserContext } from 'playwright';
import { setupTestDb } from '../helpers/test-db';
import { configureTestBrowser } from '../helpers/browser';
import { makeDriver } from '../helpers/drive';
import { startFakeWordPress, type FakeWp } from '../fixtures/fake-wordpress';

/**
 * Content refresh against the fake WordPress: an approved revision updates
 * the SAME post (content only), live posts are locked unless allowed,
 * manual WordPress edits stop it, and a rollback restores the text.
 */
let client: PrismaClient;
let browser: typeof import('@/wordpress/browser');
let session: typeof import('@/wordpress/session');
let refresh: typeof import('@/lib/refresh/service');
let apply: typeof import('@/wordpress/refresh-apply');
let net: typeof import('@/lib/links/net');
let wp: FakeWp;
let site: Website;
let web: http.Server;
let PORT = 0;

beforeAll(async () => {
  configureTestBrowser();
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  browser = await import('@/wordpress/browser');
  session = await import('@/wordpress/session');
  refresh = await import('@/lib/refresh/service');
  apply = await import('@/wordpress/refresh-apply');
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
  // A tiny outside web: one page that is gone (404).
  web = http.createServer((req, res) => {
    res.writeHead(req.headers.host?.startsWith('gone.example') ? 404 : 200, { 'content-type': 'text/html' });
    res.end('<title>x</title>');
  });
  await new Promise<void>((r) => web.listen(0, '127.0.0.1', r));
  PORT = (web.address() as AddressInfo).port;
  net = await import('@/lib/links/net');
  net.setLinkNetworkForTests(async (host) => {
    if (host === 'gone.example') return [{ address: '127.0.0.1', family: 4 }];
    throw new Error('ENOTFOUND');
  }, ['gone.example']);
  wp = await startFakeWordPress();
  const websites = await import('@/lib/websites');
  const created = await websites.createWebsite({ name: 'Refresh Blog', publicUrl: wp.url, language: 'en', targetCountry: 'United States', timezone: 'UTC' });
  site = await client.website.findUniqueOrThrow({ where: { id: created.id } });
  expect((await session.interactiveLogin(site, async () => true, 60_000)).state).toBe('ACTIVE');
  await session.syncCategories(site);
  await client.website.update({ where: { id: site.id }, data: { settingsOverrides: JSON.stringify({ content: {}, seo: { rankMathMode: 'off' }, workflow: {} }) } });
  site = await client.website.findUniqueOrThrow({ where: { id: site.id } });
});

afterAll(async () => {
  net.setLinkNetworkForTests(null);
  await browser.closeAllContexts();
  await wp.close();
  await new Promise((r) => web.close(r));
});

async function completedArticle(keyword: string) {
  const create = await import('@/lib/tasks/create');
  const cat = await client.category.findFirstOrThrow({ where: { websiteId: site.id, externalId: 7 } });
  const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword, secondaryKeywords: 'Tokio Hotel', websiteId: site.id, categoryId: cat.id, idempotencyKey: `int:refresh:${keyword}` }, { source: 'SINGLE' });
  const t = await makeDriver(client).drive(task.id);
  expect(t.status, t.reviewReasons).toBe('COMPLETED');
  return t;
}

/** The article gains an outdated heading and a dead link in the app, as if written long ago. */
async function ageArticle(taskId: string) {
  const t = await client.articleTask.findUniqueOrThrow({ where: { id: taskId } });
  const html = `${t.assembledHtml}<h2>Net worth in 2024</h2><p>According to <a href="http://gone.example:${PORT}/old">an old interview</a>, the band toured a lot.</p>`;
  // Saved to WordPress like any article text (the app's last save), so WordPress and the app agree.
  await client.articleTask.update({ where: { id: taskId }, data: { editedHtml: html } });
  const actions = await import('@/lib/tasks/actions');
  await actions.resaveToWordPress(taskId, { mode: 'resave' });
  const done = await makeDriver(client).drive(taskId);
  expect(done.status, done.reviewReasons).toBe('COMPLETED');
  return done;
}

async function approvedRevision(taskId: string, edit: (html: string) => string, ack?: string) {
  await refresh.evaluateRefresh(site.id, new Date());
  const c = await client.refreshCandidate.findFirstOrThrow({ where: { taskId, status: { in: ['OPEN', 'REVISION'] } }, orderBy: { createdAt: 'desc' } });
  const { revision } = await refresh.proposeRevision(c.id);
  await refresh.updateRevision(revision.id, edit(revision.proposedHtml));
  await refresh.approveRevision(revision.id, ack);
  return client.contentRevision.findUniqueOrThrow({ where: { id: revision.id } });
}

/** What the worker's control queue does for `wp.refresh-apply`: run the handler, then close the job. */
async function runApply(revisionId: string) {
  const result = await apply.applyContentRevision(revisionId);
  await client.queueJob.updateMany({ where: { relatedId: revisionId, kind: 'wp.refresh-apply', status: 'WAITING' }, data: { status: 'COMPLETED', finishedAt: new Date() } });
  return result;
}

describe('content refresh → the same WordPress post', () => {
  let taskId: string;
  let postId: number;

  it('updates only the content of the draft, keeps status/date/slug, and records it locally afterwards', async () => {
    const t = await completedArticle('Tom Kaulitz Heidi Klum Refresh');
    taskId = t.id;
    postId = t.wpPostId!;
    await ageArticle(taskId);
    const before = { ...wp.posts.get(postId)! };
    const rev = await approvedRevision(taskId, (h) => h.replace('Net worth in 2024', 'Net worth in 2026'));
    expect(rev.proposedHtml).not.toContain('gone.example');
    const result = await runApply(rev.id);
    expect(result).toMatchObject({ status: 'APPLIED', verified: true, stateUnchanged: true, postStatus: 'draft' });
    const after = wp.posts.get(postId)!;
    expect(after.content).toContain('Net worth in 2026');
    expect(after.content).not.toContain('gone.example');
    expect(after.content).toContain('an old interview');
    expect([after.status, after.date_gmt, after.slug, after.title]).toEqual([before.status, before.date_gmt, before.slug, before.title]);
    expect(wp.posts.size).toBe(1);
    const updates = wp.requests.filter((r) => r.method === 'POST' && decodeURIComponent(r.path).includes(`/wp/v2/posts/${postId}`) && r.body.includes('Net worth in 2026'));
    expect(updates).toHaveLength(1);
    expect(Object.keys(JSON.parse(updates[0].body))).toEqual(['content']);
    const local = await client.articleTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(local.editedHtml).toContain('Net worth in 2026');
    expect((await client.refreshCandidate.findFirstOrThrow({ where: { taskId }, orderBy: { createdAt: 'desc' } })).status).toBe('APPLIED');
    // A retry of the same job finds it applied and does nothing.
    expect(await runApply(rev.id)).toEqual({ skipped: 'already applied' });
  });

  it('edits made in WordPress stop the update (nothing changes); the owner can continue from the WordPress version', async () => {
    // New outdated text, saved to WordPress like any article text.
    const cur = (await client.articleTask.findUniqueOrThrow({ where: { id: taskId } })).editedHtml!;
    await client.articleTask.update({ where: { id: taskId }, data: { editedHtml: `${cur}<p>Tour news (Stand: 2024).</p>` } });
    const actions = await import('@/lib/tasks/actions');
    await actions.resaveToWordPress(taskId, { mode: 'resave' });
    expect((await makeDriver(client).drive(taskId)).status).toBe('COMPLETED');
    const rev = await approvedRevision(taskId, (h) => h.replace('(Stand: 2024)', '(Stand: 2026)'));
    // Someone edits the post in WordPress before the update runs.
    const post = wp.posts.get(postId)!;
    post.content = `${post.content}\n<!-- wp:paragraph -->\n<p>Added by the editor in WordPress.</p>\n<!-- /wp:paragraph -->`;
    const localBefore = (await client.articleTask.findUniqueOrThrow({ where: { id: taskId } })).editedHtml;
    expect(await runApply(rev.id)).toMatchObject({ status: 'CONFLICT' });
    expect(wp.posts.get(postId)!.content).toContain('Added by the editor in WordPress.');
    expect(wp.posts.get(postId)!.content).not.toContain('(Stand: 2026)');
    expect((await client.articleTask.findUniqueOrThrow({ where: { id: taskId } })).editedHtml).toBe(localBefore);
    const conflict = await client.contentRevision.findUniqueOrThrow({ where: { id: rev.id } });
    expect(conflict.remoteSnapshot).toContain('Added by the editor in WordPress.');
    const adopted = await apply.adoptWordPressVersion(rev.id);
    expect(adopted?.taskId).toBe(taskId);
    const local = await client.articleTask.findUniqueOrThrow({ where: { id: taskId } });
    expect(local.editedHtml).toContain('Added by the editor in WordPress.');
    expect(local.editedHtml).not.toContain('<!-- wp:');
    // A new revision from the WordPress version applies cleanly and keeps the editor's paragraph.
    const next = await approvedRevision(taskId, (h) => h.replace('(Stand: 2024)', '(Stand: 2026)'));
    expect(await runApply(next.id)).toMatchObject({ status: 'APPLIED', stateUnchanged: true });
    expect(wp.posts.get(postId)!.content).toContain('Added by the editor in WordPress.');
    expect(wp.posts.get(postId)!.content).toContain('(Stand: 2026)');
  });

  it('a post that went live meanwhile is not touched without the site permission; with it, status and date stay', async () => {
    const cur = (await client.articleTask.findUniqueOrThrow({ where: { id: taskId } })).editedHtml!;
    await client.articleTask.update({ where: { id: taskId }, data: { editedHtml: `${cur}<p>Tour dates as of 2024 are below.</p>` } });
    // Approved while the post was a draft...
    const rev = await approvedRevision(taskId, (h) => h.replace('as of 2024', 'as of 2026'));
    // ...then it was published in WordPress.
    wp.posts.get(postId)!.status = 'publish';
    const contentBefore = wp.posts.get(postId)!.content;
    expect(await runApply(rev.id)).toMatchObject({ status: 'BLOCKED' });
    expect(wp.posts.get(postId)!.content).toBe(contentBefore);
    // The owner allows approved updates to live posts; approving again needs the typed acknowledgement.
    await client.website.update({ where: { id: site.id }, data: { canPublish: true, canPublishAcknowledgedAt: new Date(), allowLiveUpdates: true } });
    await client.linkTarget.upsert({ where: { websiteId_wpPostId: { websiteId: site.id, wpPostId: postId } }, update: { status: 'ACTIVE' }, create: { websiteId: site.id, wpPostId: postId, url: `${wp.url}/?p=${postId}`, title: 'x', status: 'ACTIVE' } });
    await refresh.rejectRevision(rev.id);
    const dateBefore = wp.posts.get(postId)!.date_gmt;
    await expect(approvedRevision(taskId, (h) => h.replace('as of 2024', 'as of 2026'))).rejects.toMatchObject({ code: 'ACK_REQUIRED' });
    const pending = await client.contentRevision.findFirstOrThrow({ where: { taskId, status: 'PROPOSED' } });
    await refresh.approveRevision(pending.id, refresh.LIVE_ACK_PHRASE);
    expect(await runApply(pending.id)).toMatchObject({ status: 'APPLIED', stateUnchanged: true, postStatus: 'publish' });
    expect(wp.posts.get(postId)!).toMatchObject({ status: 'publish', date_gmt: dateBefore });
    expect(wp.posts.get(postId)!.content).toContain('as of 2026');
  });

  it('a rollback restores the previous text through the same approval and apply path', async () => {
    const applied = await client.contentRevision.findFirstOrThrow({ where: { taskId, status: 'APPLIED' }, orderBy: { appliedAt: 'desc' } });
    const { revision } = await refresh.rollbackRevision(applied.id);
    expect(revision.kind).toBe('ROLLBACK');
    await refresh.approveRevision(revision.id, refresh.LIVE_ACK_PHRASE);
    expect(await runApply(revision.id)).toMatchObject({ status: 'APPLIED' });
    expect(wp.posts.get(postId)!.content).toContain('as of 2024');
    expect(wp.posts.get(postId)!.status).toBe('publish');
    expect(await client.auditLog.count({ where: { action: 'refresh.apply' } })).toBe(4);
    expect(await client.recoveryIncident.count({ where: { dedupeKey: { startsWith: 'refresh-state:' } } })).toBe(0);
  });

  it('an update that cannot run (logged out) goes back to approved with the reason, and runs after the owner logs in', async () => {
    const cur = (await client.articleTask.findUniqueOrThrow({ where: { id: taskId } })).editedHtml!;
    await client.articleTask.update({ where: { id: taskId }, data: { editedHtml: `${cur}<p>Merch shop (Stand: 2023).</p>` } });
    const rev = await approvedRevision(taskId, (h) => h.replace('(Stand: 2023)', '(Stand: 2026)'), refresh.LIVE_ACK_PHRASE);
    wp.logoutAll();
    await expect(runApply(rev.id)).rejects.toThrow();
    const waiting = await client.contentRevision.findUniqueOrThrow({ where: { id: rev.id } });
    expect(waiting.status).toBe('APPROVED');
    expect(JSON.parse(waiting.result).waiting ?? JSON.parse(waiting.result).error).toMatch(/Log in|did not run/);
    expect(wp.posts.get(postId)!.content).not.toContain('Merch shop (Stand: 2026)');
    // The queued job retries by itself; approving again meanwhile is refused.
    await expect(refresh.approveRevision(rev.id, refresh.LIVE_ACK_PHRASE)).rejects.toMatchObject({ code: 'BUSY' });
    expect((await session.interactiveLogin(await client.website.findUniqueOrThrow({ where: { id: site.id } }), async () => true, 60_000)).state).toBe('ACTIVE');
    expect(await runApply(rev.id)).toMatchObject({ status: 'APPLIED', postStatus: 'publish' });
    expect(wp.posts.get(postId)!.content).toContain('Merch shop (Stand: 2026)');
  });
});
