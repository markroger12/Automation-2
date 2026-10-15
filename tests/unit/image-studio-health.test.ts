import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { ALT_MAX, altTextIssues, normalizeAltText } from '@/images/alt-text';
import { evaluatePermissions } from '@/wordpress/permissions';

/** Upgrade 08 alt text, upgrade 09 permission check, upload names and site health (M14). */
describe('alt text', () => {
  const ctx = { subject: 'Tom Kaulitz', keyword: 'Tom Kaulitz', title: 'Tom Kaulitz: Guitarist, Twin and Husband', language: 'en' };

  it('keeps descriptive text and only cleans it', () => {
    expect(normalizeAltText('  "Tom Kaulitz on stage with his guitar"  ', 'BODY1', ctx)).toEqual({ alt: 'Tom Kaulitz on stage with his guitar', issues: [], fallback: false });
    expect(normalizeAltText('<b>Tom</b> Kaulitz at the premiere', 'BODY1', ctx).alt).toBe('Tom Kaulitz at the premiere');
    // “Image of …” is redundant; “Photo of …” says what kind of image it is.
    const r = normalizeAltText('Image of Tom Kaulitz at the premiere', 'BODY1', ctx);
    expect(r.alt).toBe('Tom Kaulitz at the premiere');
    expect(r.fallback).toBe(false);
    expect(normalizeAltText('Photo of Zendaya', 'BODY1', { ...ctx, subject: 'Zendaya' }).alt).toBe('Photo of Zendaya');
    expect(normalizeAltText('Ein Bild von Tom Kaulitz auf der Bühne', 'BODY1', { ...ctx, language: 'de' }).alt).toBe('Tom Kaulitz auf der Bühne');
  });

  it('replaces file names, addresses, one-word labels and keyword stuffing with a neutral fallback', () => {
    const file = normalizeAltText('IMG_2041.jpg', 'FEATURED', ctx);
    expect(file).toMatchObject({ alt: ctx.title, fallback: true });
    expect(file.issues).toContain('looks like a file name');
    expect(normalizeAltText('https://example.com/tom.webp', 'BODY1', ctx)).toMatchObject({ alt: 'Tom Kaulitz: article image 2', fallback: true });
    expect(normalizeAltText('Guitar', 'BODY2', ctx)).toMatchObject({ alt: 'Tom Kaulitz: article image 3', issues: ['too short to describe the image'] });
    expect(normalizeAltText('', 'BODY2', { ...ctx, language: 'de' }).alt).toBe('Tom Kaulitz: Artikelbild 3');
    expect(normalizeAltText('Tom Kaulitz Tom Kaulitz guitarist Tom Kaulitz', 'BODY1', ctx).issues).toContain('repeats the keyword');
    expect(altTextIssues('DSC_0042')).toContain('looks like a file name');
    expect(altTextIssues('Tom Kaulitz with Heidi Klum in Los Angeles')).toEqual([]);
  });

  it('never gives two images the same text and stays within the length budget', () => {
    const first = normalizeAltText('Setup wizard steps in a browser', 'BODY1', ctx);
    const second = normalizeAltText('setup wizard steps in a browser', 'BODY2', { ...ctx, others: [first.alt] });
    expect(second).toMatchObject({ alt: 'Tom Kaulitz: article image 3', fallback: true });
    expect(second.issues).toContain('same text as another image');
    const long = normalizeAltText(`Tom Kaulitz ${'and the band on a long European tour with many stops '.repeat(5)}`, 'BODY1', ctx);
    expect(long.alt.length).toBeLessThanOrEqual(ALT_MAX);
    expect(long.alt).not.toMatch(/\s$/);
    expect(long.issues).toContain(`shortened to ${ALT_MAX} characters`);
  });
});

describe('WordPress account permissions', () => {
  const caps = (...c: string[]) => Object.fromEntries(c.map((k) => [k, true]));
  it('needs edit_posts; uploads and new tags degrade with a warning', () => {
    expect(evaluatePermissions({ name: 'Owner', roles: ['administrator'], capabilities: caps('edit_posts', 'upload_files', 'manage_categories', 'publish_posts') }, { createMissingTags: true })).toMatchObject({ status: 'OK', canPublish: true });
    expect(evaluatePermissions({ name: 'Ann', roles: ['author'], capabilities: caps('edit_posts', 'upload_files', 'publish_posts') }, { createMissingTags: true })).toMatchObject({ status: 'WARN', message: expect.stringMatching(/may not create new tags/) });
    expect(evaluatePermissions({ name: 'Ann', roles: ['author'], capabilities: caps('edit_posts', 'upload_files') }, { createMissingTags: false }).status).toBe('OK');
    expect(evaluatePermissions({ name: 'Cy', roles: ['contributor'], capabilities: caps('edit_posts') })).toMatchObject({ status: 'WARN', canUploadFiles: false, message: 'Cy (contributor) may not upload images (drafts are saved without them).' });
    expect(evaluatePermissions({ name: 'Sub', roles: ['subscriber'], capabilities: caps('read') })).toMatchObject({ status: 'FAIL', canCreatePosts: false });
  });
});

describe('site health and upload names (database)', () => {
  let client: PrismaClient;
  let health: typeof import('@/lib/site-health');
  let siteId: string;

  beforeAll(async () => {
    ({ client } = await setupTestDb());
    health = await import('@/lib/site-health');
    const websites = await import('@/lib/websites');
    siteId = (await websites.createWebsite({ name: 'Health Blog', publicUrl: 'https://health.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
  });

  it('a stable upload name per asset whose slug WordPress keeps', async () => {
    const { wpUploadName } = await import('@/wordpress/media');
    const a = wpUploadName({ id: 'cmv9elggv00097dav8cp5phns', filePath: 'media/t1/Tom-Kaulitz_Heidi Klum-1.webp', mime: 'image/webp' });
    expect(a).toEqual({ filename: 'tom-kaulitz-heidi-klum-1-av8cp5phns.webp', slug: 'tom-kaulitz-heidi-klum-1-av8cp5phns' });
    expect(wpUploadName({ id: 'cmv9elggv00097dav8cp5phns', filePath: 'media/t1/Tom-Kaulitz_Heidi Klum-1.webp', mime: 'image/webp' })).toEqual(a);
    expect(wpUploadName({ id: 'x1', filePath: 'media/t1/.jpg', mime: 'image/jpeg' }).filename).toBe('image-x1.jpg');
  });

  it('summarises measured observations only', async () => {
    const now = new Date();
    expect((await health.siteHealth(siteId, now)).overall).toBe('UNKNOWN');
    await health.observe(siteId, 'SESSION', 'OK', 'Logged in to wp-admin.');
    await health.observe(siteId, 'DRAFT_SAVE', 'OK', 'Draft #5 created', { durationMs: 4000 });
    await health.observe(siteId, 'DRAFT_SAVE', 'OK', 'Draft #6 created', { durationMs: 6000 });
    let h = await health.siteHealth(siteId);
    expect(h.overall).toBe('OK');
    expect(h.reasons).toEqual([]);
    expect(h.last24h).toMatchObject({ draftSaves: 2, draftFailures: 0, medianDraftSaveMs: 5000 });
    await health.observe(siteId, 'MEDIA_UPLOAD', 'FAIL', '0 uploaded, 1 failed');
    h = await health.siteHealth(siteId);
    expect(h.overall).toBe('WARN');
    expect(h.reasons).toEqual(['1 media upload(s) failed in the last 24 hours.']);
    for (let i = 0; i < 3; i++) await health.observe(siteId, 'DRAFT_SAVE', 'FAIL', 'WordPress answered 500');
    h = await health.siteHealth(siteId);
    expect(h.overall).toBe('FAIL');
    expect(h.reasons).toContain('The last 3 draft saves failed.');
    expect(h.recent[0]).toMatchObject({ kind: 'DRAFT_SAVE', status: 'FAIL' });
  });

  it('a later successful save supersedes an older session failure; observations expire after 30 days', async () => {
    const websites = await import('@/lib/websites');
    const id = (await websites.createWebsite({ name: 'Recovering Blog', publicUrl: 'https://recover.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
    await client.siteHealthObservation.create({ data: { websiteId: id, kind: 'SESSION', status: 'FAIL', message: 'old failure', createdAt: new Date(Date.now() - 31 * 24 * 3600_000) } });
    await client.siteHealthObservation.create({ data: { websiteId: id, kind: 'REST', status: 'FAIL', message: 'blocked by a plugin', createdAt: new Date(Date.now() - 3600_000) } });
    expect((await health.siteHealth(id)).overall).toBe('FAIL');
    await health.observe(id, 'DRAFT_SAVE', 'OK', 'Draft #9 updated', { durationMs: 3000 });
    const h = await health.siteHealth(id);
    expect(h.overall).toBe('OK');
    // Recording prunes the 31-day-old observation.
    expect(await client.siteHealthObservation.count({ where: { websiteId: id } })).toBe(2);
    expect(h.latest.SESSION).toBeUndefined();
  });
});

describe('WordPress version comparison', () => {
  it('lists text only in WordPress and only in the app, ignoring block markup', async () => {
    const { compareVersions, textBlocks } = await import('@/wordpress/compare');
    const app = '<h2>Early life</h2><p>Tom was born in Leipzig.</p><ul><li><p>Guitar</p></li><li>Twin</li></ul><p>He married Heidi Klum in 2019.</p>';
    const wp = '<!-- wp:heading --><h2 class="wp-block-heading">Early life</h2><!-- /wp:heading --><!-- wp:paragraph --><p>Tom was born in   Leipzig.</p><!-- /wp:paragraph --><ul><li><p>Guitar</p></li><li>Twin</li></ul><p>He married Heidi Klum on Capri in 2019.</p><p>Added by hand.</p>';
    expect(textBlocks(app)).toEqual(['Early life', 'Tom was born in Leipzig.', 'Guitar', 'Twin', 'He married Heidi Klum in 2019.']);
    expect(compareVersions(app, wp)).toEqual({ onlyInWordPress: ['He married Heidi Klum on Capri in 2019.', 'Added by hand.'], onlyInApp: ['He married Heidi Klum in 2019.'], unchanged: 4 });
    expect(compareVersions(app, app)).toEqual({ onlyInWordPress: [], onlyInApp: [], unchanged: 5 });
  });
});

describe('site health warnings', () => {
  it('a successful save clears a session failure but not a permission warning about uploads', async () => {
    const { client } = await setupTestDb();
    void client;
    const health = await import('@/lib/site-health');
    const websites = await import('@/lib/websites');
    const id = (await websites.createWebsite({ name: 'Contributor Site', publicUrl: 'https://contrib.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
    await health.observe(id, 'SESSION', 'FAIL', 'expired');
    await health.observe(id, 'PERMISSIONS', 'WARN', 'Cy (contributor) may not upload images (drafts are saved without them).');
    await new Promise((r) => setTimeout(r, 5));
    await health.observe(id, 'DRAFT_SAVE', 'OK', 'Draft #3 updated', { durationMs: 2000 });
    const h = await health.siteHealth(id);
    expect(h.overall).toBe('WARN');
    expect(h.reasons).toEqual(['Account permissions: Cy (contributor) may not upload images (drafts are saved without them).']);
  });
});
