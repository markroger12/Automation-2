import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient, Website } from '@prisma/client';
import type { BrowserContext } from 'playwright';
import { setupTestDb } from '../helpers/test-db';
import { configureTestBrowser } from '../helpers/browser';
import { makeDriver } from '../helpers/drive';

/**
 * End-to-end against a REAL, DISPOSABLE WordPress (spec §18). Runs only when
 *   WP_E2E_ADMIN_URL   e.g. http://127.0.0.1:8890/wp-admin/
 *   WP_E2E_USER / WP_E2E_PASSWORD   credentials of that disposable site
 * are set. The credentials are typed by THIS TEST into the visible login
 * window, simulating the owner — the app never sees or stores them.
 * Optional: WP_E2E_CLASSIC_TOGGLE_FILE — a file whose presence switches the
 * disposable site to the core Classic editor (see BUILD_STATUS.md M6).
 *
 * Never point this at a production site: it creates drafts and deliberately
 * tries (and must fail) to publish them.
 */
const ADMIN = process.env.WP_E2E_ADMIN_URL;
const USER = process.env.WP_E2E_USER ?? '';
const PASS = process.env.WP_E2E_PASSWORD ?? '';
const CLASSIC_TOGGLE = process.env.WP_E2E_CLASSIC_TOGGLE_FILE;

let client: PrismaClient;
let site: Website;
let catId: string;
let catExt: number;
let driver: ReturnType<typeof makeDriver>;
let browser: typeof import('@/wordpress/browser');
let session: typeof import('@/wordpress/session');
let wp: typeof import('@/wordpress/client');
let create: typeof import('@/lib/tasks/create');
let actions: typeof import('@/lib/tasks/actions');

async function withClient<T>(fn: (c: import('@/wordpress/client').WpClient, context: BrowserContext) => Promise<T>): Promise<T> {
  const fresh = await client.website.findUniqueOrThrow({ where: { id: site.id } });
  return browser.withSiteContext(session.siteRef(fresh), { headed: false, purpose: 'e2e' }, async (context) => fn(await wp.WpClient.connect(context, session.siteRef(fresh)), context));
}

async function setRankMathMode(mode: 'required' | 'if-installed' | 'off') {
  await client.website.update({ where: { id: site.id }, data: { settingsOverrides: JSON.stringify({ content: {}, seo: { rankMathMode: mode }, workflow: {} }) } });
}

async function newTask(key: string, keyword: string) {
  const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword, secondaryKeywords: 'Tokio Hotel, wedding', websiteId: site.id, categoryId: catId, idempotencyKey: `e2e:${key}:${Date.now()}` }, { source: 'SINGLE' });
  return task;
}

describe.skipIf(!ADMIN)('WordPress drafts against a real disposable WordPress', () => {
  beforeAll(async () => {
    configureTestBrowser();
    ({ client } = await setupTestDb());
    const { seedAll } = await import('@/lib/seed');
    await seedAll(client);
    browser = await import('@/wordpress/browser');
    session = await import('@/wordpress/session');
    wp = await import('@/wordpress/client');
    create = await import('@/lib/tasks/create');
    actions = await import('@/lib/tasks/actions');
    const { registerBuiltInPipelines } = await import('@/worker/pipelines');
    registerBuiltInPipelines();
    driver = makeDriver(client);
    const websites = await import('@/lib/websites');
    const publicUrl = ADMIN!.replace(/wp-admin\/?$/, '');
    const created = await websites.createWebsite({ name: 'Disposable WP', publicUrl, adminUrl: ADMIN, language: 'en', targetCountry: 'United States', timezone: 'UTC' });
    site = await client.website.findUniqueOrThrow({ where: { id: created.id } });
    // Simulated OWNER typing into the visible login window (the app never types credentials).
    browser.onWordPressContext(async (context: BrowserContext) => {
      setTimeout(async () => {
        const page = context.pages()[0];
        if (!page || !/wp-login\.php/.test(page.url())) return;
        // Like a person: type only once the page has finished loading (the app ticks “Remember Me” on load).
        await page.waitForFunction('document.readyState === "complete" && !!document.getElementById("rememberme") && document.getElementById("rememberme").checked', null, { timeout: 30_000 }).catch(() => {});
        await page.fill('#user_login', USER).catch(() => {});
        await page.fill('#user_pass', PASS).catch(() => {});
        await page.click('#wp-submit').catch(() => {});
      }, 1500);
    });
    const login = await session.interactiveLogin(site, async () => true, 90_000);
    expect(login.state).toBe('ACTIVE');
    const tested = await session.testSession(site);
    expect(tested.detail).toMatch(/REST API reachable/);
    // The real /wp/v2/users/me answer: the disposable admin may write drafts and upload images.
    const profile = await client.browserProfile.findFirstOrThrow({ where: { websites: { some: { id: site.id } } } });
    expect(JSON.parse(profile.diagnostics).permissions).toMatchObject({ status: 'OK', canCreatePosts: true, canUploadFiles: true, roles: ['administrator'] });
    // A dedicated category so "exactly one category" is meaningful.
    const name = `BAS E2E ${Date.now()}`;
    await withClient((c) => c.call('POST', '/wp/v2/categories', { json: { name } }));
    await session.syncCategories(site);
    const cat = await client.category.findFirstOrThrow({ where: { websiteId: site.id, name } });
    catId = cat.id;
    catExt = cat.externalId;
    site = await client.website.findUniqueOrThrow({ where: { id: site.id } });
  }, 240_000);

  afterAll(async () => {
    if (CLASSIC_TOGGLE && fs.existsSync(CLASSIC_TOGGLE)) fs.rmSync(CLASSIC_TOGGLE);
    await browser?.closeAllContexts();
  });

  it('creates exactly one verified Gutenberg draft (category, tags, slug, valid blocks); missing Rank Math is reported, never faked', async () => {
    await setRankMathMode('required');
    const task = await newTask('gb', 'Tom Kaulitz Heidi Klum');
    const t = await driver.drive(task.id);
    expect(t.wpPostId).toBeTruthy();
    expect(t.status).toBe('NEEDS_REVIEW');
    expect(t.reviewReasons).toMatch(/Rank Math is not active/);
    expect(t.rankMathScore).toBeNull();
    expect(t.verifiedCompleteAt).toBeNull();
    const post = await withClient((c) => c.getPost(t.wpPostId!));
    expect(post!.status).toBe('draft');
    expect(post!.categories).toEqual([catExt]);
    expect(post!.tags.length).toBeGreaterThan(0);
    expect(post!.slug).toBe('tom-kaulitz-heidi-klum');
    expect(post!.title.raw).toBe(t.selectedTitle);
    expect(post!.content.raw).toContain('<!-- wp:heading -->');
    expect(post!.content.raw).toContain('Frequently Asked Questions');
    const rm = await client.articleStage.findFirstOrThrow({ where: { taskId: t.id, key: 'RANKMATH' } });
    const report = JSON.parse(rm.outputJson!);
    expect(report.editor).toBe('GUTENBERG');
    expect(report.invalidBlocksFixed).toBe(0);
    const final = await client.articleStage.findFirstOrThrow({ where: { taskId: t.id, key: 'VERIFIED_COMPLETE' } });
    expect(JSON.parse(final.outputJson!).verified).toBe(true);
    // Internal link index read from the real site's public REST API: only published posts (WordPress's
    // default "Hello world!" post here), verified, and used as the latest-post fallback.
    const internal = JSON.parse((await client.articleStage.findFirstOrThrow({ where: { taskId: t.id, key: 'INTERNAL_LINKS' } })).outputJson!);
    expect(internal.index.via).toBe('public-rest');
    expect(internal.title).toBe('Hello world!');
    expect(internal.reason).toMatch(/latest post/);
    expect(post!.content.raw).toContain(`<a href="${internal.url}"`);
  });

  it('with Rank Math optional, the same draft is reopened (not duplicated) and counts as verified complete', async () => {
    const t0 = await client.articleTask.findFirstOrThrow({ where: { websiteId: site.id, keyword: 'Tom Kaulitz Heidi Klum' } });
    await setRankMathMode('if-installed');
    await actions.resaveToWordPress(t0.id, { mode: 'resave' });
    const t = await driver.drive(t0.id);
    expect(t.status, t.reviewReasons).toBe('COMPLETED');
    expect(t.wpPostId).toBe(t0.wpPostId);
    expect(t.verifiedCompleteAt).not.toBeNull();
    const same = await withClient((c) => c.findPosts({ search: t.selectedTitle! }));
    expect(same.filter((p) => p.title.raw === t.selectedTitle)).toHaveLength(1);
    const wpStage = await client.articleStage.findFirstOrThrow({ where: { taskId: t.id, key: 'WORDPRESS_DRAFT' } });
    expect(['unchanged', 'updated']).toContain(JSON.parse(wpStage.outputJson!).action);
  });

  it('a lost create acknowledgement is reconciled: the existing draft is adopted, no second post', async () => {
    const t0 = await client.articleTask.findFirstOrThrow({ where: { websiteId: site.id, keyword: 'Tom Kaulitz Heidi Klum' } });
    // Simulate "the create request reached WordPress but the answer was lost".
    await client.articleTask.update({ where: { id: t0.id }, data: { wpPostId: null, wpEditUrl: null, wpCreateMarker: JSON.stringify({ id: 'lost', at: new Date(Date.now() - 60_000).toISOString(), title: t0.selectedTitle, slug: t0.slug }) } });
    await actions.resaveToWordPress(t0.id, { mode: 'resave' });
    const t = await driver.drive(t0.id);
    expect(t.wpPostId).toBe(t0.wpPostId);
    const wpStage = await client.articleStage.findFirstOrThrow({ where: { taskId: t.id, key: 'WORDPRESS_DRAFT' } });
    expect(JSON.parse(wpStage.outputJson!).action).toBe('adopted');
    const same = await withClient((c) => c.findPosts({ search: t.selectedTitle! }));
    expect(same.filter((p) => p.title.raw === t.selectedTitle)).toHaveLength(1);
  });

  it('edits made in WordPress are never overwritten silently; the owner can choose to overwrite', async () => {
    const t0 = await client.articleTask.findFirstOrThrow({ where: { websiteId: site.id, keyword: 'Tom Kaulitz Heidi Klum' } });
    await withClient((c) => c.updatePost(t0.wpPostId!, { content: '<!-- wp:paragraph -->\n<p>The owner rewrote this draft by hand.</p>\n<!-- /wp:paragraph -->' }));
    await actions.resaveToWordPress(t0.id, { mode: 'resave' });
    let t = await driver.drive(t0.id);
    expect(t.status).toBe('NEEDS_REVIEW');
    expect(t.message).toMatch(/edited in WordPress/);
    let post = await withClient((c) => c.getPost(t0.wpPostId!));
    expect(post!.content.raw).toContain('rewrote this draft by hand');
    // The WordPress version is kept for the owner's comparison (WordPress tab → Changes made in WordPress).
    const stage = await client.articleStage.findFirstOrThrow({ where: { taskId: t0.id, key: 'WORDPRESS_DRAFT' } });
    const captured = JSON.parse(stage.privateState).remoteEdit;
    expect(captured).toMatchObject({ postId: t0.wpPostId, content: expect.stringContaining('rewrote this draft by hand') });
    const { compareVersions } = await import('@/wordpress/compare');
    const cmp = compareVersions(t.editedHtml ?? t.assembledHtml ?? '', captured.content);
    expect(cmp.onlyInWordPress).toEqual(['The owner rewrote this draft by hand.']);
    expect(cmp.onlyInApp).toContain('Frequently Asked Questions');
    await actions.resaveToWordPress(t0.id, { mode: 'overwrite-remote' });
    t = await driver.drive(t0.id);
    expect(t.status).toBe('COMPLETED');
    post = await withClient((c) => c.getPost(t0.wpPostId!));
    expect(post!.content.raw).not.toContain('rewrote this draft by hand');
    expect(post!.content.raw).toContain('Frequently Asked Questions');
  });

  it('publish guard: REST, editor Publish button, in-page fetch, Quick Edit and deletion are all blocked; the post stays a draft', async () => {
    const t = await client.articleTask.findFirstOrThrow({ where: { websiteId: site.id, keyword: 'Tom Kaulitz Heidi Klum' } });
    const id = t.wpPostId!;
    const { PublishNotAllowedError } = await import('@/wordpress/publish-guard');
    await withClient(async (c, context) => {
      await expect(c.call('POST', `/wp/v2/posts/${id}`, { json: { status: 'publish' } })).rejects.toBeInstanceOf(PublishNotAllowedError);
      await expect(c.call('POST', `/wp/v2/posts/${id}`, { json: { status: 'future', date: '2030-01-01T10:00:00' } })).rejects.toBeInstanceOf(PublishNotAllowedError);
      await expect(c.call('DELETE', `/wp/v2/posts/${id}`)).rejects.toBeInstanceOf(PublishNotAllowedError);
      // Gutenberg UI: Publish → confirm.
      const page = await context.newPage();
      await page.goto(`${ADMIN}post.php?post=${id}&action=edit`);
      await page.waitForFunction('window.wp && wp.data && wp.data.select("core/editor").getCurrentPostId()', null, { timeout: 60_000 });
      await page.evaluate(`wp.data.dispatch('core/preferences') && wp.data.dispatch('core/preferences').set('core/edit-post', 'welcomeGuide', false)`);
      const blocked = page.waitForResponse((r) => r.status() === 403 && /posts/.test(decodeURIComponent(r.url())), { timeout: 30_000 });
      await page.locator('.editor-post-publish-panel__toggle, .editor-post-publish-button__button').first().click();
      const confirm = page.locator('.editor-post-publish-panel .editor-post-publish-button__button').first();
      if (await confirm.isVisible({ timeout: 5000 }).catch(() => false)) await confirm.click();
      expect((await blocked).status()).toBe(403);
      // In-page fetch with the editor's own nonce, every publishing state.
      const statuses = await page.evaluate(`(async () => {
        const out = [];
        for (const status of ['publish', 'future', 'private', 'pending']) {
          const r = await fetch(wpApiSettings.root + 'wp/v2/posts/${id}', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-WP-Nonce': wpApiSettings.nonce }, body: JSON.stringify({ status }) });
          out.push(r.status);
        }
        const url = new URL(wpApiSettings.root + 'wp/v2/posts/${id}', location.href);
        url.searchParams.set('force', 'true');
        const d = await fetch(url, { method: 'DELETE', headers: { 'X-WP-Nonce': wpApiSettings.nonce } });
        out.push(d.status);
        return out;
      })()`);
      expect(statuses).toEqual([403, 403, 403, 403, 403]);
      // Quick Edit (admin-ajax inline-save) with _status=publish.
      const quick = await page.evaluate(`(async () => {
        const body = new URLSearchParams({ action: 'inline-save', post_ID: '${id}', _status: 'publish', post_title: 'x', _inline_edit: 'x', screen: 'edit-post' });
        const r = await fetch(ajaxurl, { method: 'POST', body });
        return r.status;
      })()`);
      expect(quick).toBe(403);
      await page.close();
    });
    const post = await withClient((c) => c.getPost(id));
    expect(post!.status).toBe('draft');
    expect(await client.auditLog.count({ where: { action: 'publish.blocked' } })).toBeGreaterThanOrEqual(8);
  });

  it('featured image: uploaded once with alt text, set as featured media, reused on the next save', async () => {
    const t0 = await client.articleTask.findFirstOrThrow({ where: { websiteId: site.id, keyword: 'Tom Kaulitz Heidi Klum' } });
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 64, height: 36, channels: 3, background: { r: 79, g: 70, b: 229 } } }).png().toBuffer();
    fs.mkdirSync(`${process.env.BAS_DATA_DIR}/media`, { recursive: true });
    fs.writeFileSync(`${process.env.BAS_DATA_DIR}/media/e2e-featured.png`, png);
    const asset = await client.mediaAsset.create({ data: { taskId: t0.id, websiteId: site.id, role: 'FEATURED', origin: 'RENDERED', filePath: 'media/e2e-featured.png', sha256: 'e2e', mime: 'image/png', altText: 'Tom Kaulitz and Heidi Klum' } });
    await actions.resaveToWordPress(t0.id, { mode: 'resave' });
    let t = await driver.drive(t0.id);
    expect(t.status, t.reviewReasons).toBe('COMPLETED');
    const uploaded = await client.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(uploaded.wpMediaId).toBeTruthy();
    expect(uploaded.status).toBe('UPLOADED');
    const post = await withClient((c) => c.getPost(t.wpPostId!));
    expect(post!.featured_media).toBe(uploaded.wpMediaId);
    const media = await withClient((c) => c.getMedia(uploaded.wpMediaId!));
    expect(media!.alt_text).toBe('Tom Kaulitz and Heidi Klum');
    await actions.resaveToWordPress(t0.id, { mode: 'resave' });
    t = await driver.drive(t0.id);
    expect(t.status).toBe('COMPLETED');
    expect((await client.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).wpMediaId).toBe(uploaded.wpMediaId);
  });

  it('media idempotency on real WordPress: an upload whose answer was lost is found by its slug, not uploaded again', async () => {
    const t0 = await client.articleTask.findFirstOrThrow({ where: { websiteId: site.id, keyword: 'Tom Kaulitz Heidi Klum' } });
    const sharp = (await import('sharp')).default;
    const webp = await sharp({ create: { width: 120, height: 68, channels: 3, background: { r: 20, g: 140, b: 90 } } }).webp().toBuffer();
    fs.mkdirSync(`${process.env.BAS_DATA_DIR}/media`, { recursive: true });
    fs.writeFileSync(`${process.env.BAS_DATA_DIR}/media/Tom Kaulitz_lost-1.webp`, webp);
    const asset = await client.mediaAsset.create({ data: { taskId: t0.id, websiteId: site.id, role: 'BODY1', origin: 'RENDERED', filePath: 'media/Tom Kaulitz_lost-1.webp', sha256: 'e2e-lost', mime: 'image/webp', altText: 'Tom Kaulitz on stage' } });
    const media = await import('@/wordpress/media');
    const { filename, slug } = media.wpUploadName(asset);
    await withClient(async (c) => {
      // The "lost" upload: WordPress stores the file, the app never sees the answer (only the marker is set).
      const lost = await c.uploadMedia({ bytes: webp, filename, mime: 'image/webp' });
      await client.mediaAsset.update({ where: { id: asset.id }, data: { uploadStartedAt: new Date() } });
      const r = await media.uploadAssetOnce(c, await client.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }));
      expect(r).toMatchObject({ id: lost.id, how: 'adopted' });
      // WordPress derived exactly the predicted slug, and only one item carries it.
      expect(await c.findMediaBySlug(slug)).toMatchObject({ id: lost.id });
      const { data } = await c.call<{ id: number }[]>('GET', '/wp/v2/media', { query: { search: slug, per_page: 20 } });
      expect(data.map((m) => m.id)).toEqual([lost.id]);
      // Missing alt text on the adopted item is filled in.
      expect((await c.getMedia(lost.id))!.alt_text).toBe('Tom Kaulitz on stage');
      const again = await media.uploadAssetOnce(c, await client.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } }));
      expect(again).toMatchObject({ id: lost.id, how: 'reused' });
    });
    expect(await client.mediaAsset.findUniqueOrThrow({ where: { id: asset.id } })).toMatchObject({ uploadStartedAt: null, status: 'UPLOADED' });
  });

  it('WordPress’s own “session expired” pop-up is recognised as logged out (real wp-auth-check markup)', async () => {
    const { chromium } = await import('playwright');
    const { browserLaunchBase } = await import('@/lib/browser-launch');
    // A throwaway browser (not the site profile): the test signs in to the disposable site, then drops the cookies.
    const b = await chromium.launch({ ...browserLaunchBase(), headless: true });
    try {
      const context = await b.newContext();
      const page = await context.newPage();
      await page.goto(`${ADMIN}`);
      await page.fill('#user_login', USER);
      await page.fill('#user_pass', PASS);
      await page.click('#wp-submit');
      await page.waitForSelector('#wpadminbar', { timeout: 60_000 });
      expect(await session.isLoggedIn(page)).toBe(true); // the hidden pop-up on every admin page does not count
      await context.clearCookies();
      await page.evaluate('window.wp && wp.heartbeat && wp.heartbeat.connectNow()');
      await page.waitForSelector('#wp-auth-check-wrap:not(.hidden) #wp-auth-check', { timeout: 60_000 });
      expect(await session.sessionExpiredPopup(page)).toBe(true);
      expect(await session.isLoggedIn(page)).toBe(false);
    } finally {
      await b.close();
    }
  });

  it.skipIf(!CLASSIC_TOGGLE)('Classic editor: detected from the editor, re-saved as plain HTML, and the Classic Publish button is blocked', async () => {
    fs.writeFileSync(CLASSIC_TOGGLE!, '1');
    const task = await newTask('classic', 'Sydney Sweeney Glen Powell');
    const t = await driver.drive(task.id);
    expect(t.status).toBe('COMPLETED');
    const fresh = await client.website.findUniqueOrThrow({ where: { id: site.id } });
    expect(fresh.detectedEditor).toBe('CLASSIC');
    const post = await withClient((c) => c.getPost(t.wpPostId!));
    expect(post!.content.raw).not.toContain('<!-- wp:');
    expect(post!.content.raw).toContain('<h2>');
    await withClient(async (_c, context) => {
      const page = await context.newPage();
      await page.goto(`${ADMIN}post.php?post=${t.wpPostId}&action=edit`);
      const res = page.waitForResponse((r) => r.request().method() === 'POST' && /post\.php/.test(r.url()), { timeout: 30_000 });
      await page.click('#publish');
      expect((await res).status()).toBe(403);
      await page.close();
    });
    expect((await withClient((c) => c.getPost(t.wpPostId!)))!.status).toBe('draft');
    fs.rmSync(CLASSIC_TOGGLE!);
  });
  it('approved workflow publishing (spec §14): the EXISTING draft is scheduled at its slot in WordPress local time, verified, then published by WordPress itself', async () => {
    const schedule = await import('@/wordpress/schedule');
    // A non-UTC WordPress clock makes "local time" meaningful (Berlin is UTC+2 in summer, UTC+1 in winter).
    await withClient((c) => c.call('POST', '/wp/v2/settings', { json: { timezone: 'Europe/Berlin' } }));
    const task = await newTask('schedule', 'Bill Kaulitz Tokio Hotel');
    const t = await driver.drive(task.id);
    expect(t.status, t.reviewReasons).toBe('COMPLETED');
    const postId = t.wpPostId!;
    const wf = await client.workflow.create({ data: { websiteId: site.id, name: 'e2e', active: false, slots: JSON.stringify(['9:00 AM']) } });
    // Slot ~3 minutes ahead (the approved path refuses anything closer than 2.5 minutes), whole second.
    const slot = new Date(Math.ceil((Date.now() + 190_000) / 1000) * 1000);
    const kw = await client.workflowKeyword.create({ data: { workflowId: wf.id, keyword: 'Bill Kaulitz Tokio Hotel', normalizedKeyword: 'bill kaulitz tokio hotel', position: 1, writerType: 'CELEBRITY', status: 'READY', taskId: t.id, scheduledAt: slot } });
    await client.slotReservation.create({ data: { websiteId: site.id, scheduledAt: slot, workflowKeywordId: kw.id } });

    // Publishing not allowed for this website: nothing happens.
    await client.website.update({ where: { id: site.id }, data: { canPublish: false, canPublishAcknowledgedAt: null } });
    expect(await schedule.scheduleKeywordPost(kw.id)).toEqual({ skipped: 'publishing not allowed' });
    expect((await withClient((c) => c.getPost(postId)))!.status).toBe('draft');

    // Allowed (switch + typed acknowledgement): the same post becomes "future" at the slot.
    await client.website.update({ where: { id: site.id }, data: { canPublish: true, canPublishAcknowledgedAt: new Date() } });
    expect(await schedule.scheduleKeywordPost(kw.id)).toMatchObject({ scheduled: true, postId });
    const future = (await withClient((c) => c.getPost(postId)))! as import('@/wordpress/client').WpPost & { date: string };
    expect(future.status).toBe('future');
    expect(future.id).toBe(postId);
    expect(Date.parse(`${future.date_gmt}Z`)).toBe(slot.getTime());
    const berlin = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(slot).replace(' ', 'T');
    expect(future.date).toBe(berlin);
    expect(await client.articleTask.count({ where: { websiteId: site.id, keyword: 'Bill Kaulitz Tokio Hotel' } })).toBe(1);
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } })).status).toBe('SCHEDULED');

    // Before the slot WordPress still shows "future"; the tool does not claim publication.
    expect(await schedule.verifyKeywordPublished(kw.id)).toEqual({ published: false, status: 'future' });
    // After the slot, WordPress's own cron publishes it; the tool reads the status back.
    await new Promise((r) => setTimeout(r, Math.max(0, slot.getTime() - Date.now()) + 5_000));
    await fetch(`${ADMIN!.replace(/wp-admin\/?$/, '')}wp-cron.php?doing_wp_cron=${Date.now() / 1000}`).catch(() => undefined);
    const verified = await schedule.verifyKeywordPublished(kw.id);
    expect(verified).toMatchObject({ published: true });
    const row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row.status).toBe('PUBLISHED');
    expect(row.publishedUrl).toBeTruthy();
    await client.website.update({ where: { id: site.id }, data: { canPublish: false, canPublishAcknowledgedAt: null } });
  }, 480_000);

  it('content refresh of the now LIVE post: locked until allowed; then only its content changes, and WordPress edits stop it', async () => {
    const refresh = await import('@/lib/refresh/service');
    const apply = await import('@/wordpress/refresh-apply');
    const t0 = await client.articleTask.findFirstOrThrow({ where: { websiteId: site.id, keyword: 'Bill Kaulitz Tokio Hotel' } });
    const postId = t0.wpPostId!;
    const before = (await withClient((c) => c.getPost(postId)))!;
    expect(before.status).toBe('publish');
    await client.linkTarget.upsert({ where: { websiteId_wpPostId: { websiteId: site.id, wpPostId: postId } }, update: { status: 'ACTIVE' }, create: { websiteId: site.id, wpPostId: postId, url: before.link, title: 'Bill Kaulitz', status: 'ACTIVE', publishedAt: new Date() } });
    const addOutdated = async (text: string) => {
      const t = await client.articleTask.findUniqueOrThrow({ where: { id: t0.id } });
      await client.articleTask.update({ where: { id: t0.id }, data: { editedHtml: `${t.editedHtml ?? t.assembledHtml}<p>${text}</p>` } });
    };
    const runApply = async (id: string) => {
      const r = await apply.applyContentRevision(id);
      await client.queueJob.updateMany({ where: { relatedId: id, kind: 'wp.refresh-apply', status: 'WAITING' }, data: { status: 'COMPLETED', finishedAt: new Date() } });
      return r;
    };
    const propose = async (from: string, to: string) => {
      await refresh.evaluateRefresh(site.id, new Date());
      const c = await client.refreshCandidate.findFirstOrThrow({ where: { taskId: t0.id, status: { in: ['OPEN', 'REVISION'] } }, orderBy: { createdAt: 'desc' } });
      expect(c.live).toBe(true);
      const { revision } = await refresh.proposeRevision(c.id);
      await refresh.updateRevision(revision.id, revision.proposedHtml.replace(from, to));
      return revision.id;
    };

    await addOutdated('Tour dates as of 2024 are listed below.');
    const first = await propose('as of 2024', 'as of 2026');
    await expect(refresh.approveRevision(first, refresh.LIVE_ACK_PHRASE)).rejects.toMatchObject({ code: 'LIVE_LOCKED' });
    await client.website.update({ where: { id: site.id }, data: { canPublish: true, canPublishAcknowledgedAt: new Date(), allowLiveUpdates: true } });
    await refresh.approveRevision(first, refresh.LIVE_ACK_PHRASE);
    expect(await runApply(first)).toMatchObject({ status: 'APPLIED', verified: true, stateUnchanged: true, postStatus: 'publish' });
    const after = (await withClient((c) => c.getPost(postId)))!;
    expect([after.status, after.date_gmt, after.slug, after.link]).toEqual([before.status, before.date_gmt, before.slug, before.link]);
    expect(after.content.raw).toContain('as of 2026');
    expect(after.content.raw).not.toContain('as of 2024');

    // Someone edits the live post in WordPress; the next refresh stops and changes nothing.
    await withClient((c) => c.updatePost(postId, { content: `${after.content.raw}\n<!-- wp:paragraph -->\n<p>Edited in WordPress by the owner.</p>\n<!-- /wp:paragraph -->` }));
    await addOutdated('Ticket prices (Stand: 2025).');
    const second = await propose('(Stand: 2025)', '(Stand: 2026)');
    await refresh.approveRevision(second, refresh.LIVE_ACK_PHRASE);
    expect(await runApply(second)).toMatchObject({ status: 'CONFLICT' });
    const untouched = (await withClient((c) => c.getPost(postId)))!;
    expect(untouched.content.raw).toContain('Edited in WordPress by the owner.');
    expect(untouched.content.raw).not.toContain('Stand: 2026');
    expect(untouched.status).toBe('publish');
    await client.website.update({ where: { id: site.id }, data: { canPublish: false, canPublishAcknowledgedAt: null, allowLiveUpdates: false } });
  }, 240_000);
});
