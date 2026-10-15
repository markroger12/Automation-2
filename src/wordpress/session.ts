import fs from 'node:fs';
import type { BrowserContext, Page } from 'playwright';
import type { Website } from '@prisma/client';
import { db } from '@/lib/db';
import { log } from '@/lib/log';
import { getSettings } from '@/lib/settings';
import { profileDirForSlug } from '@/lib/paths';
import { audit } from '@/lib/audit';
import { resumeLoginPausedTasks } from '@/lib/tasks/lifecycle';
import { anyOf, selectorsFor } from './selectors';
import { boundedGoto, captureScreenshot, closeSiteContext, dismissOverlays, firstPage, withSiteContext, type SiteRef } from './browser';
import { withOwnerWindowPermit } from './publish-guard';
import { WpClient } from './client';
import { LoginRequiredError } from '@/lib/pipeline-errors';
import { parseJson } from '@/lib/json';
import { observe } from '@/lib/site-health';
import { evaluatePermissions } from './permissions';

export type SessionCheck = { state: 'ACTIVE' | 'LOGIN_REQUIRED' | 'ERROR'; detail: string; url?: string; adminLanguage?: string | null };

export function siteRef(site: Pick<Website, 'id' | 'slug' | 'name' | 'adminUrl' | 'publicUrl' | 'language'>): SiteRef {
  return { id: site.id, slug: site.slug, name: site.name, adminUrl: site.adminUrl, publicUrl: site.publicUrl, language: site.language };
}

async function overrides(): Promise<Record<string, string[]>> {
  return (await getSettings()).advanced.selectorOverrides;
}

/**
 * WordPress's own “Your session has expired” pop-up (wp-auth-check) is
 * showing. Each selector is checked on its own: the pop-up's wrapper has no
 * size of its own in real WordPress (its children are fixed-position), so
 * only the dialog box inside it counts as visible.
 */
export async function sessionExpiredPopup(page: Page, sel: Record<string, string[]> = {}): Promise<boolean> {
  for (const s of selectorsFor('sessionExpired', sel)) {
    if (await page.locator(s).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

/** True when the page is an authenticated wp-admin page. */
export async function isLoggedIn(page: Page, sel: Record<string, string[]> = {}): Promise<boolean> {
  const url = page.url();
  if (/wp-login\.php/i.test(url)) return false;
  if (!/\/wp-admin\//i.test(url)) return false;
  // WordPress keeps the admin page but shows its “session expired” pop-up when the login cookie is gone.
  if (await sessionExpiredPopup(page, sel)) return false;
  return (await page.locator(anyOf('loggedIn', sel)).count().catch(() => 0)) > 0;
}

export async function checkSessionOnPage(page: Page, site: SiteRef, timeoutMs: number): Promise<SessionCheck> {
  const sel = await overrides();
  try {
    await boundedGoto(page, site.adminUrl, timeoutMs);
  } catch (error) {
    return { state: 'ERROR', detail: `Could not open ${site.adminUrl}: ${(error as Error).message.split('\n')[0]}` };
  }
  await page.waitForSelector(`${anyOf('loggedIn', sel)}, ${anyOf('loginForm', sel)}`, { timeout: Math.min(timeoutMs, 20_000) }).catch(() => {});
  const lang = await page.evaluate(() => document.documentElement.getAttribute('lang')).catch(() => null);
  if (await isLoggedIn(page, sel)) return { state: 'ACTIVE', detail: 'Logged in to wp-admin.', url: page.url(), adminLanguage: lang };
  if (await sessionExpiredPopup(page, sel)) {
    return { state: 'LOGIN_REQUIRED', detail: 'WordPress shows its “session expired” pop-up. Use “Log in” and sign in yourself.', url: page.url(), adminLanguage: lang };
  }
  if (/wp-login\.php/i.test(page.url()) || (await page.locator(anyOf('loginForm', sel)).count()) > 0) {
    return { state: 'LOGIN_REQUIRED', detail: 'WordPress shows the login page. Use “Log in” and sign in yourself.', url: page.url(), adminLanguage: lang };
  }
  return { state: 'ERROR', detail: `Unexpected page at ${page.url()} (no admin bar and no login form). A security plugin, maintenance page or host overlay may be in the way.`, url: page.url(), adminLanguage: lang };
}

function pickCapabilities(raw: string | null | undefined): Record<string, unknown> {
  const d = parseJson<Record<string, unknown>>(raw, {});
  return Object.fromEntries(Object.entries(d).filter(([k]) => ['rest', 'rankMath', 'restError', 'permissions'].includes(k)));
}

async function recordSession(site: Website, check: SessionCheck, extra: Record<string, unknown> = {}) {
  if (!site.wordpressProfileId) return;
  const before = await db.browserProfile.findUnique({ where: { id: site.wordpressProfileId } });
  await db.browserProfile.update({
    where: { id: site.wordpressProfileId },
    data: {
      sessionState: check.state,
      lastCheckedAt: new Date(),
      ...(check.state === 'ACTIVE' && before?.sessionState !== 'ACTIVE' ? { lastLoginAt: new Date() } : {}),
      // Keep the last REST/Rank Math capability result unless this check measured it again.
      diagnostics: JSON.stringify({ ...pickCapabilities(before?.diagnostics), detail: check.detail, url: check.url ?? null, adminLanguage: check.adminLanguage ?? null, ...extra, checkedAt: new Date().toISOString() }),
    },
  });
  if (check.state === 'ACTIVE' && before?.sessionState !== 'ACTIVE') {
    const resumed = await resumeLoginPausedTasks({ websiteId: site.id });
    if (resumed) await log({ category: 'wordpress', message: `${site.name}: session active again; resumed ${resumed} paused task(s).` });
  }
}

/** Headless session test. Never types credentials. */
export async function testSession(site: Website): Promise<SessionCheck> {
  const settings = await getSettings();
  const timeout = settings.browser.navigationTimeoutSec * 1000;
  let capabilities: Record<string, unknown> = {};
  const result = await withSiteContext(siteRef(site), { headed: settings.browser.mode === 'headed', purpose: 'test-session' }, async (context) => {
    const page = await firstPage(context);
    const check = await checkSessionOnPage(page, siteRef(site), timeout);
    if (check.state === 'ERROR' && settings.browser.screenshots) await captureScreenshot(page, `${site.slug}-session-error`);
    if (check.state === 'ACTIVE') {
      // Can the logged-in session reach the REST API the drafts use? Is Rank Math active?
      try {
        const client = await WpClient.connect(context, siteRef(site), { timeoutMs: timeout });
        capabilities = { rest: true, rankMath: client.hasRankMath };
        try {
          capabilities.permissions = evaluatePermissions(await client.currentUser(), { createMissingTags: settings.workflow.createMissingTags });
        } catch (error) {
          capabilities.permissions = { status: 'WARN', message: `Could not read the account's permissions: ${(error as Error).message}` };
        }
      } catch (error) {
        capabilities = { rest: false, restError: (error as Error).message };
      }
    }
    return check;
  });
  const permissions = capabilities.permissions as { status: 'OK' | 'WARN' | 'FAIL'; message: string } | undefined;
  if (result.state === 'ACTIVE' && capabilities.rest === false) result.detail += ` But the REST API is not reachable: ${String(capabilities.restError)}`;
  else if (result.state === 'ACTIVE') {
    result.detail += capabilities.rankMath ? ' REST API reachable; Rank Math detected.' : ' REST API reachable; Rank Math NOT detected.';
    if (permissions && permissions.status !== 'OK') result.detail += ` ${permissions.message}`;
  }
  await recordSession(site, result, capabilities);
  await observe(site.id, 'SESSION', result.state === 'ACTIVE' ? 'OK' : 'FAIL', result.state === 'ACTIVE' ? 'Logged in to wp-admin.' : result.detail);
  if (result.state === 'ACTIVE') {
    await observe(site.id, 'REST', capabilities.rest === false ? 'FAIL' : 'OK', capabilities.rest === false ? `Not reachable: ${String(capabilities.restError)}` : 'Reachable for the logged-in account.');
    if (capabilities.rest !== false) await observe(site.id, 'RANK_MATH', capabilities.rankMath ? 'OK' : 'WARN', capabilities.rankMath ? 'Rank Math detected.' : 'Rank Math not detected (Rank Math steps are skipped).');
    if (permissions) await observe(site.id, 'PERMISSIONS', permissions.status, permissions.message);
  }
  await log({ level: result.state === 'ACTIVE' ? 'info' : 'warn', category: 'wordpress', message: `${site.name}: session ${result.state} — ${result.detail}` });
  return result;
}

/**
 * Open a VISIBLE window on the login page and wait for the owner to sign in
 * manually. The app never sees or stores the password.
 */
export async function interactiveLogin(site: Website, heartbeat: () => Promise<boolean>, timeoutMs = 10 * 60_000): Promise<SessionCheck> {
  const settings = await getSettings();
  const sel = settings.advanced.selectorOverrides;
  const ref = siteRef(site);
  const result = await withSiteContext(ref, { headed: true, purpose: 'login' }, async (context) => {
    const page = await firstPage(context);
    await boundedGoto(page, site.adminUrl, settings.browser.navigationTimeoutSec * 1000).catch(() => {});
    await page.bringToFront().catch(() => {});
    // Convenience only: tick "Remember Me" so the session survives browser restarts.
    // Credentials are never typed, read or stored by the app.
    await page.locator('#rememberme').check({ timeout: 3000 }).catch(() => {});
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      for (const p of context.pages()) {
        if (!p.isClosed() && (await isLoggedIn(p, sel))) {
          // Without "Remember Me" WordPress issues a session-only sign-in cookie, which the browser drops when this
          // window closes: the next job would find the login page. Say so instead of reporting a session that won't last.
          const auth = (await context.cookies(site.adminUrl).catch(() => [])).filter((c) => c.name.startsWith('wordpress_logged_in_'));
          if (auth.length && auth.every((c) => c.expires === -1)) {
            return { state: 'LOGIN_REQUIRED', detail: 'Signed in without “Remember Me”, so WordPress gave a sign-in that ends when the window closes. Log in again and leave “Remember Me” ticked.' } as SessionCheck;
          }
          const lang = await p.evaluate(() => document.documentElement.getAttribute('lang')).catch(() => null);
          return { state: 'ACTIVE', detail: 'Signed in manually in the visible window.', url: p.url(), adminLanguage: lang } as SessionCheck;
        }
      }
      if (context.pages().length === 0) return { state: 'LOGIN_REQUIRED', detail: 'The login window was closed before sign-in finished.' } as SessionCheck;
      await heartbeat();
      await new Promise((r) => setTimeout(r, 1500));
    }
    return { state: 'LOGIN_REQUIRED', detail: `No sign-in detected within ${Math.round(timeoutMs / 60000)} minutes.` } as SessionCheck;
  });
  await recordSession(site, result, { via: 'interactive-login' });
  await observe(site.id, 'SESSION', result.state === 'ACTIVE' ? 'OK' : 'FAIL', result.state === 'ACTIVE' ? 'Signed in manually in the login window.' : result.detail);
  await log({ level: result.state === 'ACTIVE' ? 'info' : 'warn', category: 'wordpress', message: `${site.name}: login window finished — ${result.detail}` });
  return result;
}

/**
 * Open a visible admin window for manual work; returns when the owner closes
 * it (or after 30 min). The publish guard stays active: publishing by hand is
 * only possible here when the site allows publishing.
 */
export async function openAdminWindow(site: Website, heartbeat: () => Promise<boolean>): Promise<{ closed: boolean; publishingAllowed: boolean }> {
  const settings = await getSettings();
  const { result, publishingAllowed } = await withOwnerWindowPermit(site.id, () =>
    withSiteContext(siteRef(site), { headed: true, purpose: 'open-browser' }, async (context) => {
      const page = await firstPage(context);
      await boundedGoto(page, site.adminUrl, settings.browser.navigationTimeoutSec * 1000).catch(() => {});
      const deadline = Date.now() + 30 * 60_000;
      while (Date.now() < deadline && context.pages().length > 0) {
        await heartbeat();
        await new Promise((r) => setTimeout(r, 2000));
      }
      return { closed: context.pages().length === 0 };
    }),
  );
  return { ...result, publishingAllowed };
}

export interface RemoteCategory {
  id: number;
  name: string;
  slug: string | null;
  parent: number | null;
  count: number | null;
}

/** Read categories through the authenticated REST API (logged-in session + nonce), with admin-table fallback. */
export async function fetchCategories(page: Page, site: SiteRef, timeoutMs: number): Promise<{ categories: RemoteCategory[]; via: 'rest' | 'admin' }> {
  if (!/\/wp-admin\//.test(page.url())) await boundedGoto(page, site.adminUrl, timeoutMs);
  const adminBase = site.adminUrl;
  try {
    const client = await WpClient.connect(page.context(), site, { timeoutMs });
    const out: RemoteCategory[] = [];
    for (let p = 1; p <= 50; p++) {
      const res = await client.call<{ id: number; name: string; slug: string; parent: number; count: number }[]>('GET', '/wp/v2/categories', {
        query: { per_page: 100, page: p, _fields: 'id,name,slug,parent,count' },
      });
      const items = Array.isArray(res.data) ? res.data : [];
      out.push(...items.map((c) => ({ id: c.id, name: decodeEntities(c.name), slug: c.slug ?? null, parent: c.parent || null, count: c.count ?? null })));
      const total = Number(res.headers['x-wp-totalpages'] ?? '1');
      if (p >= total || items.length < 100) break;
    }
    if (out.length) return { categories: out, via: 'rest' };
  } catch (error) {
    if (error instanceof LoginRequiredError) throw error;
    // REST blocked or unusual: fall back to the admin table below.
  }
  // Fallback: the categories admin table.
  const sel = await overrides();
  const categories: RemoteCategory[] = [];
  for (let paged = 1; paged <= 30; paged++) {
    await boundedGoto(page, `${adminBase}edit-tags.php?taxonomy=category&paged=${paged}`, timeoutMs);
    const rows = await page.$$eval(
      anyOf('categoryRows', sel),
      (trs, cfg) =>
        // No named inner functions here: this runs inside the page (see browser.ts about __name).
        trs.map((tr) => ({
          id: Number((tr.id || '').replace('tag-', '')),
          name: (tr.querySelector(cfg.name)?.textContent ?? '').replace(/^[—–-]\s*/g, '').trim(),
          slug: (tr.querySelector(cfg.slug)?.textContent ?? '').trim() || null,
          count: Number((tr.querySelector(cfg.count)?.textContent ?? '').trim()) || 0,
        })),
      { name: anyOf('categoryRowName', sel), slug: anyOf('categoryRowSlug', sel), count: anyOf('categoryRowCount', sel) },
    );
    const fresh = rows.filter((r) => r.id > 0 && r.name && !categories.some((c) => c.id === r.id));
    for (const r of fresh) categories.push({ id: r.id, name: r.name, slug: r.slug, parent: null, count: r.count });
    if (fresh.length === 0 || rows.length < 20) break;
  }
  return { categories, via: 'admin' };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?38;/g, '&')
    .replace(/&#8217;/g, '’')
    .replace(/&#8211;/g, '–')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/** Replace the synced category cache for a site (real WordPress IDs only). */
export async function saveCategories(siteId: string, categories: RemoteCategory[]): Promise<{ added: number; updated: number; removed: number }> {
  let added = 0;
  let updated = 0;
  const now = new Date();
  for (const c of categories) {
    const existing = await db.category.findUnique({ where: { websiteId_externalId: { websiteId: siteId, externalId: c.id } } });
    if (existing) {
      await db.category.update({ where: { id: existing.id }, data: { name: c.name, slug: c.slug, parentExternalId: c.parent, postCount: c.count, syncedAt: now } });
      updated++;
    } else {
      await db.category.create({ data: { websiteId: siteId, externalId: c.id, name: c.name, slug: c.slug, parentExternalId: c.parent, postCount: c.count, syncedAt: now } });
      added++;
    }
  }
  let removed = 0;
  if (categories.length > 0) {
    const stale = await db.category.findMany({ where: { websiteId: siteId, externalId: { notIn: categories.map((c) => c.id) } } });
    for (const s of stale) {
      await db.website.updateMany({ where: { id: siteId, defaultCategoryId: s.id }, data: { defaultCategoryId: null } });
      await db.category.delete({ where: { id: s.id } });
      removed++;
    }
  }
  return { added, updated, removed };
}

export async function syncCategories(site: Website): Promise<{ count: number; via: string; added: number; updated: number; removed: number }> {
  const settings = await getSettings();
  const timeout = settings.browser.navigationTimeoutSec * 1000;
  const result = await withSiteContext(siteRef(site), { headed: settings.browser.mode === 'headed', purpose: 'sync-categories' }, async (context) => {
    const page = await firstPage(context);
    const check = await checkSessionOnPage(page, siteRef(site), timeout);
    await recordSession(site, check);
    if (check.state !== 'ACTIVE') throw new Error(check.state === 'LOGIN_REQUIRED' ? 'Log in first: WordPress shows the login page.' : check.detail);
    return fetchCategories(page, siteRef(site), timeout);
  });
  if (result.categories.length === 0) throw new Error('WordPress returned no categories. Check that the user can view categories.');
  const saved = await saveCategories(site.id, result.categories);
  if (!site.defaultCategoryId) {
    const uncategorized = await db.category.findFirst({ where: { websiteId: site.id, externalId: 1 } });
    const first = uncategorized ?? (await db.category.findFirst({ where: { websiteId: site.id }, orderBy: { name: 'asc' } }));
    if (first) await db.website.update({ where: { id: site.id }, data: { defaultCategoryId: first.id } });
  }
  await log({ category: 'wordpress', message: `${site.name}: synced ${result.categories.length} categories via ${result.via} (+${saved.added} / ~${saved.updated} / -${saved.removed}).` });
  return { count: result.categories.length, via: result.via, ...saved };
}

/** Detect Gutenberg vs Classic on post-new.php (WordPress may create a hidden auto-draft; it is never published). */
export async function detectEditor(site: Website): Promise<'GUTENBERG' | 'CLASSIC' | 'UNKNOWN'> {
  const settings = await getSettings();
  const sel = settings.advanced.selectorOverrides;
  const timeout = settings.browser.navigationTimeoutSec * 1000;
  const editor = await withSiteContext(siteRef(site), { headed: settings.browser.mode === 'headed', purpose: 'detect-editor' }, async (context) => {
    const page = await firstPage(context);
    await boundedGoto(page, `${site.adminUrl}post-new.php`, timeout);
    if (!(await isLoggedIn(page, sel))) throw new Error('Not logged in — use “Log in” first.');
    await dismissOverlays(page, sel);
    await page.waitForSelector(`${anyOf('gutenbergRoot', sel)}, ${anyOf('classicEditor', sel)}`, { timeout: Math.min(timeout, 45_000) }).catch(() => {});
    if ((await page.locator(anyOf('gutenbergRoot', sel)).count()) > 0) return 'GUTENBERG' as const;
    if ((await page.locator(anyOf('classicEditor', sel)).count()) > 0) return 'CLASSIC' as const;
    if (settings.browser.screenshots) await captureScreenshot(page, `${site.slug}-editor-unknown`);
    return 'UNKNOWN' as const;
  });
  await db.website.update({ where: { id: site.id }, data: { detectedEditor: editor } });
  await observe(site.id, 'EDITOR', editor === 'UNKNOWN' ? 'WARN' : 'OK', editor === 'UNKNOWN' ? 'Neither the block editor nor the Classic editor was found on post-new.php.' : `${editor === 'GUTENBERG' ? 'Block editor (Gutenberg)' : 'Classic editor'} detected.`);
  await log({ category: 'wordpress', message: `${site.name}: editor detected as ${editor}.` });
  return editor;
}

/** Clear cookies/storage of the profile (requires explicit confirmation in the UI). Folder is kept. */
export async function resetSession(site: Website): Promise<SessionCheck> {
  const settings = await getSettings();
  const check = await withSiteContext(siteRef(site), { headed: false, purpose: 'reset-session' }, async (context: BrowserContext) => {
    await context.clearCookies();
    const page = await firstPage(context);
    await page.evaluate(() => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        /* ignore */
      }
    }).catch(() => {});
    return checkSessionOnPage(page, siteRef(site), settings.browser.navigationTimeoutSec * 1000);
  });
  await recordSession(site, check, { via: 'reset' });
  await audit('profile.reset-session', 'Website', site.id, { result: check.state });
  return check;
}

/** Delete the profile folder (explicit typed confirmation only; never automatic). */
export async function deleteProfile(site: Website): Promise<{ deleted: boolean }> {
  await closeSiteContext(site.slug);
  const dir = profileDirForSlug(site.slug);
  const existed = fs.existsSync(dir);
  if (existed) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  if (site.wordpressProfileId) {
    await db.browserProfile.update({ where: { id: site.wordpressProfileId }, data: { sessionState: 'LOGIN_REQUIRED', diagnostics: JSON.stringify({ detail: 'Profile folder deleted by the owner.' }), lastCheckedAt: new Date() } });
  }
  await audit('profile.delete', 'Website', site.id, { slug: site.slug, existed });
  return { deleted: existed };
}
