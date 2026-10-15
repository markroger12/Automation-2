import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient, Website } from '@prisma/client';
import type { BrowserContext } from 'playwright';
import { setupTestDb } from '../helpers/test-db';
import { configureTestBrowser } from '../helpers/browser';
import { makeDriver } from '../helpers/drive';
import { cannedAnswer } from '../helpers/fake-answers';
import { startFakeWordPress, type FakeWp } from '../fixtures/fake-wordpress';

/**
 * WORDPRESS_DRAFT → RANKMATH → VERIFIED_COMPLETE with the real engine against
 * the fake WordPress fixture (its "Rank Math" uses the fixture's own rules —
 * see fakeRankMathScore). Real WordPress/Gutenberg coverage: tests/e2e.
 */
let client: PrismaClient;
let browser: typeof import('@/wordpress/browser');
let session: typeof import('@/wordpress/session');
let create: typeof import('@/lib/tasks/create');
let actions: typeof import('@/lib/tasks/actions');
let lifecycle: typeof import('@/lib/tasks/lifecycle');
const servers: FakeWp[] = [];
const seoCorrections: string[] = [];

/** Canned answers plus a SEO_CORRECTION that adds the keyword to one heading (keeps everything else). */
function answer(stageKey: string, prompt: string, language: 'en' | 'de', keyword: string): string {
  // The job is keyed by the requesting stage (RANKMATH); recognise the SEO_CORRECTION prompt by its text.
  if (/reported the following concrete issues/.test(prompt)) {
    seoCorrections.push(prompt);
    const article = prompt.split(/\nArticle:\n\n/)[1] ?? '';
    return article.replace(/^## (.+)$/m, (_m, h: string) => `## ${h} with ${keyword}`);
  }
  return cannedAnswer(stageKey, prompt, language, keyword);
}

async function loggedInSite(wp: FakeWp, name: string, language: 'en' | 'de' = 'en'): Promise<Website> {
  const websites = await import('@/lib/websites');
  const created = await websites.createWebsite({ name, publicUrl: wp.url, language, targetCountry: language === 'de' ? 'Germany' : 'United States', timezone: 'UTC' });
  const site = await client.website.findUniqueOrThrow({ where: { id: created.id } });
  expect((await session.interactiveLogin(site, async () => true, 60_000)).state).toBe('ACTIVE');
  await session.syncCategories(site);
  return client.website.findUniqueOrThrow({ where: { id: site.id } });
}

async function celebTask(site: Website, keyword: string, key: string, options: Record<string, unknown> = {}) {
  const cat = await client.category.findFirstOrThrow({ where: { websiteId: site.id, externalId: 7 } });
  const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword, secondaryKeywords: 'Tokio Hotel', websiteId: site.id, categoryId: cat.id, options, idempotencyKey: `int:${key}` }, { source: 'SINGLE' });
  return task;
}

const stageData = async (taskId: string, key: string) => JSON.parse((await client.articleStage.findFirstOrThrow({ where: { taskId, key } })).outputJson ?? 'null');

beforeAll(async () => {
  configureTestBrowser();
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  browser = await import('@/wordpress/browser');
  session = await import('@/wordpress/session');
  create = await import('@/lib/tasks/create');
  actions = await import('@/lib/tasks/actions');
  lifecycle = await import('@/lib/tasks/lifecycle');
  const { registerBuiltInPipelines } = await import('@/worker/pipelines');
  registerBuiltInPipelines();
  // Simulated owner typing into the visible login window (the app never types credentials).
  browser.onWordPressContext(async (context: BrowserContext) => {
    setTimeout(async () => {
      const page = context.pages()[0];
      if (!page || !/wp-login\.php/.test(page.url())) return;
      await page.fill('#user_login', 'owner').catch(() => {});
      await page.fill('#user_pass', 'owner-typed-this').catch(() => {});
      await page.click('#wp-submit').catch(() => {});
    }, 1200);
  });
});

afterAll(async () => {
  await browser.closeAllContexts();
  for (const s of servers) await s.close();
});

describe('WordPress drafts + Rank Math (fake WordPress fixture)', () => {
  it('saves one draft, sets and verifies Rank Math fields, applies bounded local + guarded content corrections, then completes', async () => {
    const wp = await startFakeWordPress({ rankMath: true });
    servers.push(wp);
    const site = await loggedInSite(wp, 'RM Blog');
    const driver = makeDriver(client, answer);
    const task = await celebTask(site, 'Tom Kaulitz Heidi Klum', 'rm-1', { manualArticleApproval: true, rankMathTargetScore: 90 });
    let t = await driver.drive(task.id);
    expect(t.status).toBe('AWAITING_ARTICLE_APPROVAL');
    // The owner shortens the meta description (without the keyword) before approving: the panel will recommend a fix.
    await actions.saveMetadata(task.id, { metaDescription: 'A calm look at a famous couple and how their story developed over many years in public life.', baseVersion: t.version });
    await actions.approveArticle(task.id);
    t = await driver.drive(task.id);
    expect(t.status, t.reviewReasons).toBe('COMPLETED');
    expect(wp.posts.size).toBe(1);
    const post = [...wp.posts.values()][0];
    expect(post.status).toBe('draft');
    expect(post.categories).toEqual([7]);
    expect(post.slug).toBe('tom-kaulitz-heidi-klum');
    expect(post.meta.rank_math_focus_keyword).toBe('Tom Kaulitz Heidi Klum');
    expect(post.meta.rank_math_description.toLowerCase()).toContain('tom kaulitz heidi klum');
    const report = await stageData(task.id, 'RANKMATH');
    expect(report.fieldsVerified).toBe(true);
    expect(report.score).toBeGreaterThanOrEqual(90);
    expect(t.rankMathScore).toBe(report.score);
    expect(report.rounds.length).toBeLessThanOrEqual(3);
    expect(report.rounds.some((r: { kind: string; accepted: boolean }) => r.kind === 'local' && r.accepted)).toBe(true);
    // The score shown is exactly what the panel displayed — never computed by the app.
    expect(report.scoreText).toBe(`${report.score} / 100`);
    expect(t.verifiedCompleteAt).not.toBeNull();
    expect(await client.productionMetric.count({ where: { kind: 'ARTICLE_VERIFIED', taskId: task.id } })).toBe(1);
  });

  it('Rank Math still at 0 while it analyses: the real score is waited for, never reported as 0', async () => {
    // The owner's first live draft was reported as "Rank Math score 0": Rank Math shows 0 until its analysis has run.
    const wp = await startFakeWordPress({ rankMath: true, rankMathPending: 'store-zero' });
    servers.push(wp);
    const site = await loggedInSite(wp, 'RM Pending');
    const driver = makeDriver(client, answer);
    const task = await celebTask(site, 'Tom Kaulitz Heidi Klum', 'rm-pending');
    const t = await driver.drive(task.id);
    const report = await stageData(task.id, 'RANKMATH');
    expect(report.score).toBeGreaterThan(0);
    expect(t.rankMathScore).toBe(report.score);
    expect(report.scoreText).toBe(`${report.score} / 100`);
    expect(t.reviewReasons ?? '').not.toMatch(/Rank Math score 0 /);
  });

  it('Rank Math that never analyses: no score is claimed and the review reason says why', async () => {
    const wp = await startFakeWordPress({ rankMath: true, rankMathPending: 'never' });
    servers.push(wp);
    const site = await loggedInSite(wp, 'RM Never');
    const driver = makeDriver(client, answer);
    const task = await celebTask(site, 'Tom Kaulitz Heidi Klum', 'rm-never');
    const t = await driver.drive(task.id);
    expect(t.status).toBe('NEEDS_REVIEW');
    expect(t.rankMathScore).toBeNull();
    expect(t.reviewReasons).toMatch(/Rank Math showed 0 \/ 100 for the whole check/);
    expect(t.reviewReasons).not.toMatch(/below the target/);
    const report = await stageData(task.id, 'RANKMATH');
    expect(report.score).toBeNull();
  });

  it('an unreachable Rank Math target stops after the bounded rounds with specific review reasons', async () => {
    const wp = await startFakeWordPress({ rankMath: true, rankMathScoreCap: 60 });
    servers.push(wp);
    const site = await loggedInSite(wp, 'RM Capped');
    const driver = makeDriver(client, answer);
    const before = seoCorrections.length;
    const task = await celebTask(site, 'Sydney Sweeney Glen Powell', 'rm-cap');
    const t = await driver.drive(task.id);
    expect(t.status).toBe('NEEDS_REVIEW');
    expect(t.rankMathScore).toBe(60);
    expect(t.reviewReasons).toMatch(/Rank Math score 60 is below the target 75 after \d correction round/);
    const report = await stageData(task.id, 'RANKMATH');
    expect(report.rounds.length).toBeLessThanOrEqual(3);
    expect(seoCorrections.length - before).toBeLessThanOrEqual(3);
    // A guarded content correction was accepted: same headings (one gained the keyword), links kept.
    const content = report.rounds.find((r: { kind: string }) => r.kind === 'content');
    if (content) expect(content.accepted, JSON.stringify(content.reasons)).toBe(true);
    expect(wp.posts.size).toBe(1);
    expect([...wp.posts.values()][0].status).toBe('draft');
  });

  it('a lost create acknowledgement is reconciled on retry: exactly one post exists', async () => {
    const wp = await startFakeWordPress({ dropCreateAcks: 1 });
    servers.push(wp);
    const site = await loggedInSite(wp, 'Lost Ack Blog');
    await client.website.update({ where: { id: site.id }, data: { settingsOverrides: JSON.stringify({ content: {}, seo: { rankMathMode: 'if-installed' }, workflow: {} }) } });
    const driver = makeDriver(client);
    const task = await celebTask(site, 'Selena Gomez Benny Blanco', 'lost-ack');
    const t = await driver.drive(task.id);
    expect(t.status, t.reviewReasons).toBe('COMPLETED');
    expect(wp.posts.size).toBe(1);
    expect(t.wpPostId).toBe([...wp.posts.keys()][0]);
    expect((await stageData(task.id, 'WORDPRESS_DRAFT')).action).toBe('adopted');
    const creates = wp.requests.filter((r) => r.method === 'POST' && /\/wp\/v2\/posts$/.test(decodeURIComponent(r.path).split('?')[0]));
    expect(creates).toHaveLength(1);
  });

  it('ambiguous evidence pauses for review (no duplicate); the owner picks the post to use', async () => {
    const wp = await startFakeWordPress({ dropCreateAcks: 1 });
    servers.push(wp);
    const site = await loggedInSite(wp, 'Ambiguous Blog');
    await client.website.update({ where: { id: site.id }, data: { settingsOverrides: JSON.stringify({ content: {}, seo: { rankMathMode: 'off' }, workflow: {} }) } });
    const driver = makeDriver(client);
    const task = await celebTask(site, 'Zendaya Tom Holland', 'ambiguous');
    // Stop right after the dropped create, then add a second matching draft (e.g. a manual copy).
    let t = await driver.drive(task.id, () => wp.posts.size === 1 && wp.options.dropCreateAcks === 0);
    const first = [...wp.posts.values()][0];
    wp.addPost({ title: first.title, slug: first.slug, content: '<p>copy</p>', categories: [7] });
    t = await driver.drive(task.id);
    expect(t.status).toBe('NEEDS_REVIEW');
    expect(t.message).toMatch(/matching posts exist/);
    expect(wp.posts.size).toBe(2);
    const incident = await client.recoveryIncident.findFirstOrThrow({ where: { taskId: task.id, kind: 'UNCERTAIN_WP_CREATE' } });
    expect(JSON.parse(incident.evidence).candidates).toHaveLength(2);
    await actions.resaveToWordPress(task.id, { mode: 'adopt', adoptPostId: first.id });
    t = await driver.drive(task.id);
    expect(t.status, t.reviewReasons).toBe('COMPLETED');
    expect(t.wpPostId).toBe(first.id);
    expect(wp.posts.size).toBe(2);
    expect((await client.recoveryIncident.findUniqueOrThrow({ where: { id: incident.id } })).status).toBe('RESOLVED');
  });

  it('an account that may not write posts stops with a clear reason; a batch re-save finishes it once the account may (no duplicate)', async () => {
    const wp = await startFakeWordPress({ role: 'subscriber' });
    servers.push(wp);
    const site = await loggedInSite(wp, 'Read Only Blog');
    await client.website.update({ where: { id: site.id }, data: { settingsOverrides: JSON.stringify({ content: {}, seo: { rankMathMode: 'off' }, workflow: {} }) } });
    const driver = makeDriver(client);
    const task = await celebTask(site, 'Dua Lipa Callum Turner', 'no-permission');
    let t = await driver.drive(task.id);
    expect(t.status).toBe('NEEDS_REVIEW');
    expect(t.message).toMatch(/may not create or edit this post \(rest_cannot_create\)/);
    expect(wp.posts.size).toBe(0);
    const { siteHealth } = await import('@/lib/site-health');
    const health = await siteHealth(site.id);
    expect(health.latest.DRAFT_SAVE?.status).toBe('FAIL');
    expect(health.latest.PERMISSIONS?.status).toBe('FAIL');
    expect(health.overall).toBe('FAIL');
    const resave = await import('@/lib/wordpress-resave');
    const failed = await resave.failedWordPressTasks(site.id);
    expect(failed.map((f) => [f.id, f.stageKey])).toEqual([[task.id, 'WORDPRESS_DRAFT']]);
    // Not while logged out: the re-save would only stop again.
    await client.browserProfile.update({ where: { id: site.wordpressProfileId! }, data: { sessionState: 'LOGIN_REQUIRED' } });
    await expect(resave.resaveFailedWordPressTasks(site.id)).rejects.toThrow(/not logged in/);
    await client.browserProfile.update({ where: { id: site.wordpressProfileId! }, data: { sessionState: 'ACTIVE' } });
    // An ID that is not on the list is never re-saved.
    await expect(resave.resaveFailedWordPressTasks(site.id, ['not-a-listed-task'])).rejects.toThrow(/No article/);
    wp.options.role = 'author';
    const r = await resave.resaveFailedWordPressTasks(site.id, [task.id]);
    expect(r).toEqual({ requeued: [task.id], failed: [] });
    t = await driver.drive(task.id);
    expect(t.status, `${t.message} ${t.reviewReasons}`).toBe('COMPLETED');
    expect(wp.posts.size).toBe(1);
    expect(await resave.failedWordPressTasks(site.id)).toEqual([]);
    expect((await siteHealth(site.id)).latest.DRAFT_SAVE?.status).toBe('OK');
    expect(await client.auditLog.count({ where: { action: 'wordpress.batch-resave', entityId: site.id } })).toBe(1);
  });

  it('an expired WordPress login pauses the task; it resumes after the owner logs in again', async () => {
    const wp = await startFakeWordPress();
    servers.push(wp);
    const site = await loggedInSite(wp, 'Expiring Blog');
    await client.website.update({ where: { id: site.id }, data: { settingsOverrides: JSON.stringify({ content: {}, seo: { rankMathMode: 'off' }, workflow: {} }) } });
    const driver = makeDriver(client);
    const task = await celebTask(site, 'Hailey Bieber Justin Bieber', 'expired', { manualArticleApproval: true });
    expect((await driver.drive(task.id)).status).toBe('AWAITING_ARTICLE_APPROVAL');
    wp.logoutAll();
    await actions.approveArticle(task.id);
    let t = await driver.drive(task.id);
    expect(t.status).toBe('LOGIN_REQUIRED');
    expect(t.pausedFor).toBe('wordpress-login');
    expect(wp.posts.size).toBe(0);
    const profile = await client.browserProfile.findUniqueOrThrow({ where: { id: site.wordpressProfileId! } });
    expect(profile.sessionState).toBe('LOGIN_REQUIRED');
    // Owner logs in again → paused tasks resume automatically.
    const login = await session.interactiveLogin(await client.website.findUniqueOrThrow({ where: { id: site.id } }), async () => true, 60_000);
    expect(login.state).toBe('ACTIVE');
    t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).not.toBe('LOGIN_REQUIRED');
    t = await driver.drive(task.id);
    expect(t.status, t.reviewReasons).toBe('COMPLETED');
    expect(wp.posts.size).toBe(1);
    void lifecycle;
  });

  it('German Classic-editor site behind a host overlay: plain-HTML draft, German Rank Math texts, Classic save verified', async () => {
    const wp = await startFakeWordPress({ language: 'de', editor: 'classic', overlay: true, rankMath: true, categories: [{ id: 1, name: 'Allgemein', slug: 'allgemein' }, { id: 7, name: 'Promis', slug: 'promis' }] });
    servers.push(wp);
    const site = await loggedInSite(wp, 'Promi Blog', 'de');
    await session.detectEditor(site);
    const driver = makeDriver(client, answer);
    const task = await celebTask(await client.website.findUniqueOrThrow({ where: { id: site.id } }), 'Tom Kaulitz Heidi Klum', 'de-classic');
    const t = await driver.drive(task.id);
    expect(t.status, t.reviewReasons).toBe('COMPLETED');
    const post = [...wp.posts.values()][0];
    expect(post.content).not.toContain('<!-- wp:');
    expect(post.content).toContain('<h2>Kurzbiografie von Tom Kaulitz</h2>');
    expect(post.status).toBe('draft');
    const report = await stageData(task.id, 'RANKMATH');
    expect(report.editor).toBe('CLASSIC');
    expect(report.fieldsVerified).toBe(true);
    expect(report.editorSave).toMatch(/draft/);
    // The Classic "Save Draft" was posted (no publish field) and passed the guard.
    expect(wp.requests.some((r) => r.method === 'POST' && r.path.startsWith('/wp-admin/post.php') && /save=/.test(r.body) && !/(^|&)publish=/.test(r.body))).toBe(true);
  });

  it('publish guard on the fake editors: the Publish buttons and direct requests never reach WordPress', async () => {
    const wp = await startFakeWordPress();
    servers.push(wp);
    const site = await loggedInSite(wp, 'Guard Blog');
    const post = wp.addPost({ title: 'Guarded draft', content: '<!-- wp:paragraph -->\n<p>x</p>\n<!-- /wp:paragraph -->', slug: 'guarded' });
    const { PublishNotAllowedError } = await import('@/wordpress/publish-guard');
    const { WpClient } = await import('@/wordpress/client');
    await browser.withSiteContext(session.siteRef(site), { headed: false, purpose: 'test' }, async (context) => {
      const c = await WpClient.connect(context, session.siteRef(site));
      await expect(c.call('POST', `/wp/v2/posts/${post.id}`, { json: { status: 'private' } })).rejects.toBeInstanceOf(PublishNotAllowedError);
      await expect(c.call('POST', `/batch/v1`, { json: { requests: [{ method: 'POST', path: `/wp/v2/posts/${post.id}`, body: { status: 'publish' } }] } })).rejects.toBeInstanceOf(PublishNotAllowedError);
      const page = await context.newPage();
      await page.goto(`${site.adminUrl}post.php?post=${post.id}&action=edit`);
      const res = page.waitForResponse((r) => /posts/.test(r.url()) && r.request().method() === 'POST');
      await page.evaluate('window.__basPublish()');
      expect((await res).status()).toBe(403);
      await page.close();
    });
    expect(wp.posts.get(post.id)!.status).toBe('draft');
    expect(wp.requests.some((r) => /"status":"(publish|private)"/.test(r.body))).toBe(false);
  });
});
