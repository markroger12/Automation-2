import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient, Website } from '@prisma/client';
import type { BrowserContext } from 'playwright';
import { setupTestDb } from '../helpers/test-db';
import { startFakeWordPress, type FakeWp } from '../fixtures/fake-wordpress';
import { configureTestBrowser } from '../helpers/browser';

let client: PrismaClient;
let session: typeof import('@/wordpress/session');
let browser: typeof import('@/wordpress/browser');
let websites: typeof import('@/lib/websites');
const servers: FakeWp[] = [];

async function siteFor(wp: FakeWp, name: string, language: 'en' | 'de' = 'en'): Promise<Website> {
  const created = await websites.createWebsite({ name, publicUrl: wp.url, language, targetCountry: language === 'de' ? 'Germany' : 'United States', timezone: language === 'de' ? 'Europe/Berlin' : 'America/New_York' });
  return client.website.findUniqueOrThrow({ where: { id: created.id } });
}

/** When true, the simulated owner unticks “Remember Me” before signing in. */
let ownerUnticksRememberMe = false;

/** Simulate the owner typing credentials into the VISIBLE login window (the app itself never does this). */
function ownerLogsInWhenWindowOpens() {
  browser.onWordPressContext(async (context: BrowserContext) => {
    setTimeout(async () => {
      const page = context.pages()[0];
      if (!page || !/wp-login\.php/.test(page.url())) return;
      if (ownerUnticksRememberMe) await page.uncheck('#rememberme').catch(() => {});
      await page.fill('#user_login', 'owner').catch(() => {});
      await page.fill('#user_pass', 'owner-typed-this').catch(() => {});
      await page.click('#wp-submit').catch(() => {});
    }, 1500);
  });
}

beforeAll(async () => {
  configureTestBrowser();
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  session = await import('@/wordpress/session');
  browser = await import('@/wordpress/browser');
  websites = await import('@/lib/websites');
  ownerLogsInWhenWindowOpens();
});

afterAll(async () => {
  await browser.closeAllContexts();
  for (const s of servers) await s.close();
});

describe('WordPress sessions (fake WordPress fixture)', () => {
  it('detects LOGIN_REQUIRED, completes a manual login, persists the session across restarts, syncs categories and detects Gutenberg', async () => {
    const wp = await startFakeWordPress({ language: 'en', editor: 'gutenberg' });
    servers.push(wp);
    const site = await siteFor(wp, 'English Blog');

    const before = await session.testSession(site);
    expect(before.state).toBe('LOGIN_REQUIRED');

    const login = await session.interactiveLogin(site, async () => true, 60_000);
    expect(login.state).toBe('ACTIVE');
    // The app never typed or stored the password: it only exists in this test's simulated owner action.
    const logs = await client.log.findMany();
    expect(JSON.stringify(logs)).not.toContain('owner-typed-this');

    // "Close and reopen the application": drop the pooled browser; the persistent profile keeps the cookie.
    await browser.closeAllContexts();
    const after = await session.testSession(site);
    expect(after.state).toBe('ACTIVE');
    const profile = await client.browserProfile.findUniqueOrThrow({ where: { id: site.wordpressProfileId! } });
    expect(profile.sessionState).toBe('ACTIVE');
    expect(fs.existsSync(`${process.env.BAS_DATA_DIR}/profiles/${site.slug}`)).toBe(true);

    const sync = await session.syncCategories(site);
    expect(sync.via).toBe('rest');
    expect(sync.count).toBe(3);
    const cats = await client.category.findMany({ where: { websiteId: site.id }, orderBy: { externalId: 'asc' } });
    expect(cats.map((c) => [c.externalId, c.name])).toEqual([
      [1, 'Uncategorized'],
      [7, 'Celebrities'],
      [9, 'Tech & Apps'],
    ]);
    const refreshed = await client.website.findUniqueOrThrow({ where: { id: site.id } });
    expect(refreshed.defaultCategoryId).toBe(cats[0].id);

    expect(await session.detectEditor(refreshed)).toBe('GUTENBERG');
    const nonceCalls = wp.requests.filter((r) => r.path.includes('rest-nonce'));
    expect(nonceCalls.length).toBeGreaterThan(0);
  });

  it('falls back to the admin category table when REST is disabled, detects Classic, handles German admin and hides only the overlay', async () => {
    const wp = await startFakeWordPress({ language: 'de', editor: 'classic', restDisabled: true, overlay: true });
    servers.push(wp);
    const site = await siteFor(wp, 'Deutscher Blog', 'de');
    expect(site.internalLinkLine).toBe('Das könnte Ihnen gefallen:');
    const login = await session.interactiveLogin(site, async () => true, 60_000);
    expect(login.state).toBe('ACTIVE');
    expect(login.adminLanguage).toBe('de-DE');
    const sync = await session.syncCategories(site);
    expect(sync.via).toBe('admin');
    expect(sync.count).toBe(3);
    const names = (await client.category.findMany({ where: { websiteId: site.id } })).map((c) => c.name).sort();
    expect(names).toEqual(['Allgemein', 'Celebrities', 'Tech &amp; Apps'].map((n) => n.replace('&amp;', '&')).sort());
    expect(await session.detectEditor(site)).toBe('CLASSIC');

    // Overlay handling: only the overlay is hidden, never <html>/<body>.
    await browser.withSiteContext(session.siteRef(site), { headed: false, purpose: 'test' }, async (context) => {
      const page = await browser.firstPage(context);
      await browser.boundedGoto(page, site.adminUrl);
      const hidden = await browser.dismissOverlays(page);
      expect(hidden).toBe(1);
      const state = await page.evaluate(() => ({
        body: getComputedStyle(document.body).display,
        html: getComputedStyle(document.documentElement).display,
        overlay: getComputedStyle(document.getElementById('hostinger-onboarding-overlay')!).display,
      }));
      expect(state).toEqual({ body: 'block', html: 'block', overlay: 'none' });
    });
  });

  it('reports an expired login and resets/deletes a profile only on request', async () => {
    const wp = await startFakeWordPress();
    servers.push(wp);
    const site = await siteFor(wp, 'Expiring Blog');
    await session.interactiveLogin(site, async () => true, 60_000);
    wp.logoutAll();
    const check = await session.testSession(site);
    expect(check.state).toBe('LOGIN_REQUIRED');
    const reset = await session.resetSession(site);
    expect(reset.state).toBe('LOGIN_REQUIRED');
    const audits = await client.auditLog.findMany({ where: { entityId: site.id } });
    expect(audits.map((a) => a.action)).toContain('profile.reset-session');
    const dir = `${process.env.BAS_DATA_DIR}/profiles/${site.slug}`;
    expect(fs.existsSync(dir)).toBe(true);
    await session.deleteProfile(site);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('a sign-in without “Remember Me” is not reported as an active session (it would end when the window closes)', async () => {
    const wp = await startFakeWordPress();
    servers.push(wp);
    const site = await siteFor(wp, 'Forgetful Blog');
    ownerUnticksRememberMe = true;
    try {
      const login = await session.interactiveLogin(site, async () => true, 60_000);
      expect(login.state).toBe('LOGIN_REQUIRED');
      expect(login.detail).toMatch(/Remember Me/);
    } finally {
      ownerUnticksRememberMe = false;
    }
    // Indeed, the next window is logged out.
    expect((await session.testSession(site)).state).toBe('LOGIN_REQUIRED');
    // Signing in again with “Remember Me” (ticked by the app) works.
    expect((await session.interactiveLogin(site, async () => true, 60_000)).state).toBe('ACTIVE');
    expect((await session.testSession(site)).state).toBe('ACTIVE');
  });

  it('checks the account permissions, records site health and recognises the “session expired” pop-up', async () => {
    const wp = await startFakeWordPress({ role: 'contributor' });
    servers.push(wp);
    const site = await siteFor(wp, 'Contributor Blog');
    expect((await session.interactiveLogin(site, async () => true, 60_000)).state).toBe('ACTIVE');
    const { siteHealth } = await import('@/lib/site-health');
    // Every admin page carries WordPress's hidden pop-up; hidden, it must not count as logged out.
    let check = await session.testSession(site);
    expect(check.state).toBe('ACTIVE');
    expect(check.detail).toMatch(/may not upload images/);
    const profile = await client.browserProfile.findUniqueOrThrow({ where: { id: (await client.website.findUniqueOrThrow({ where: { id: site.id } })).wordpressProfileId! } });
    expect(JSON.parse(profile.diagnostics).permissions).toMatchObject({ status: 'WARN', canCreatePosts: true, canUploadFiles: false, roles: ['contributor'] });
    let health = await siteHealth(site.id);
    expect(health.overall).toBe('WARN');
    expect(health.latest.SESSION?.status).toBe('OK');
    expect(health.latest.REST?.status).toBe('OK');
    expect(health.latest.PERMISSIONS?.status).toBe('WARN');
    expect(health.latest.RANK_MATH?.status).toBe('WARN');
    // A subscriber may not write posts at all.
    wp.options.role = 'subscriber';
    check = await session.testSession(site);
    expect(check.detail).toMatch(/may not create posts/);
    health = await siteHealth(site.id);
    expect(health.overall).toBe('FAIL');
    expect(health.reasons.join(' ')).toMatch(/Account permissions: .*may not create posts/);
    // WordPress's own pop-up after the login cookie expired → logged out, not an unexpected page.
    wp.options.role = 'administrator';
    wp.options.expiredPopup = true;
    check = await session.testSession(site);
    expect(check.state).toBe('LOGIN_REQUIRED');
    expect(check.detail).toMatch(/session expired/);
    health = await siteHealth(site.id);
    expect(health.overall).toBe('FAIL');
    expect(health.sessionState).toBe('LOGIN_REQUIRED');
    wp.options.expiredPopup = false;
    expect((await session.testSession(site)).state).toBe('ACTIVE');
    expect(await session.detectEditor(site)).toBe('GUTENBERG');
    health = await siteHealth(site.id);
    expect(health.latest.EDITOR).toMatchObject({ status: 'OK' });
    expect(health.latest.PERMISSIONS?.status).toBe('OK');
    expect(health.recent.length).toBeGreaterThanOrEqual(12);
  });

  it('rejects invalid website input with field errors and duplicate URLs', async () => {
    await expect(websites.createWebsite({ name: 'x', publicUrl: 'notaurl', language: 'en', targetCountry: 'United States', timezone: 'Mars/Base' })).rejects.toThrow();
    const wp = await startFakeWordPress();
    servers.push(wp);
    await siteFor(wp, 'Dup One');
    await expect(siteFor(wp, 'Dup Two')).rejects.toThrow(/already exists/);
    expect(websites.normalizeAdminUrl(null, 'https://example.com/blog')).toBe('https://example.com/blog/wp-admin/');
    expect(websites.normalizeSiteUrl('Example.COM/')).toBe('https://example.com');
  });
});
