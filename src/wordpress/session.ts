import fs from 'node:fs';
import type { BrowserContext, Page } from 'playwright';
import type { Website } from '@prisma/client';
import { db } from '@/lib/db';
import { log } from '@/lib/log';
import { getSettings } from '@/lib/settings';
import { profileDirForSlug } from '@/lib/paths';
import { audit } from '@/lib/audit';
import { resumeLoginPausedTasks } from '@/lib/tasks/lifecycle';
import { anyOf } from './selectors';
import { boundedGoto, captureScreenshot, closeSiteContext, dismissOverlays, firstPage, withSiteContext, type SiteRef } from './browser';

export type SessionCheck = { state: 'ACTIVE' | 'LOGIN_REQUIRED' | 'ERROR'; detail: string; url?: string; adminLanguage?: string | null };

export function siteRef(site: Pick<Website, 'id' | 'slug' | 'name' | 'adminUrl' | 'publicUrl' | 'language'>): SiteRef {
  return { id: site.id, slug: site.slug, name: site.name, adminUrl: site.adminUrl, publicUrl: site.publicUrl, language: site.language };
}

async function overrides(): Promise<Record<string, string[]>> {
  return (await getSettings()).advanced.selectorOverrides;
}

/** True when the page is an authenticated wp-admin page. */
export async function isLoggedIn(page: Page, sel: Record<string, string[]> = {}): Promise<boolean> {
  const url = page.url();
  if (/wp-login\.php/i.test(url)) return false;
  if (!/\/wp-admin\//i.test(url)) return false;
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
  if (/wp-login\.php/i.test(page.url()) || (await page.locator(anyOf('loginForm', sel)).count()) > 0) {
    return { state: 'LOGIN_REQUIRED', detail: 'WordPress shows the login page. Use “Log in” and sign in yourself.', url: page.url(), adminLanguage: lang };
  }
  return { state: 'ERROR', detail: `Unexpected page at ${page.url()} (no admin bar and no login form). A security plugin, maintenance page or host overlay may be in the way.`, url: page.url(), adminLanguage: lang };
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
      diagnostics: JSON.stringify({ detail: check.detail, url: check.url ?? null, adminLanguage: check.adminLanguage ?? null, ...extra, checkedAt: new Date().toISOString() }),
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
  const result = await withSiteContext(siteRef(site), { headed: settings.browser.mode === 'headed', purpose: 'test-session' }, async (context) => {
    const page = await firstPage(context);
    const check = await checkSessionOnPage(page, siteRef(site), timeout);
    if (check.state === 'ERROR' && settings.browser.screenshots) await captureScreenshot(page, `${site.slug}-session-error`);
    return check;
  });
  await recordSession(site, result);
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
  await log({ level: result.state === 'ACTIVE' ? 'info' : 'warn', category: 'wordpress', message: `${site.name}: login window finished — ${result.detail}` });
  return result;
}

/** Open a visible admin window for manual work; returns when the owner closes it (or after 30 min). */
export async function openAdminWindow(site: Website, heartbeat: () => Promise<boolean>): Promise<{ closed: boolean }> {
  const settings = await getSettings();
  return withSiteContext(siteRef(site), { headed: true, purpose: 'open-browser' }, async (context) => {
    const page = await firstPage(context);
    await boundedGoto(page, site.adminUrl, settings.browser.navigationTimeoutSec * 1000).catch(() => {});
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline && context.pages().length > 0) {
      await heartbeat();
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { closed: context.pages().length === 0 };
  });
}

export interface RemoteCategory {
  id: number;
  name: string;
  slug: string | null;
  parent: number | null;
  count: number | null;
}

/** Read categories through the authenticated REST API (nonce from admin-ajax), with admin-table fallback. */
export async function fetchCategories(page: Page, site: SiteRef, timeoutMs: number): Promise<{ categories: RemoteCategory[]; via: 'rest' | 'admin' }> {
  if (!/\/wp-admin\//.test(page.url())) await boundedGoto(page, site.adminUrl, timeoutMs);
  const adminBase = site.adminUrl;
  const siteBase = adminBase.replace(/wp-admin\/$/, '');
  const rest = await page
    .evaluate(
      async ({ adminBase, siteBase }) => {
        const nonceRes = await fetch(`${adminBase}admin-ajax.php?action=rest-nonce`, { credentials: 'same-origin' });
        const nonce = nonceRes.ok ? (await nonceRes.text()).trim() : '';
        const headers: Record<string, string> = nonce && nonce !== '0' && nonce !== '-1' ? { 'X-WP-Nonce': nonce } : {};
        const out: { id: number; name: string; slug: string; parent: number; count: number }[] = [];
        for (const root of [`${siteBase}wp-json/`, `${siteBase}?rest_route=/`]) {
          out.length = 0;
          let ok = true;
          for (let p = 1; p <= 50; p++) {
            const sep = root.includes('?') ? '&' : '?';
            const res = await fetch(`${root}wp/v2/categories${sep}per_page=100&page=${p}&_fields=id,name,slug,parent,count`, { credentials: 'same-origin', headers });
            if (res.status === 400 && p > 1) break;
            if (!res.ok) {
              ok = false;
              break;
            }
            const items = (await res.json()) as typeof out;
            if (!Array.isArray(items)) {
              ok = false;
              break;
            }
            out.push(...items);
            const total = Number(res.headers.get('X-WP-TotalPages') ?? '1');
            if (p >= total || items.length < 100) break;
          }
          if (ok && out.length) return out;
        }
        return null;
      },
      { adminBase, siteBase },
    )
    .catch(() => null);
  if (rest && rest.length) {
    return { categories: rest.map((c) => ({ id: c.id, name: decodeEntities(c.name), slug: c.slug ?? null, parent: c.parent || null, count: c.count ?? null })), via: 'rest' };
  }
  // Fallback: the categories admin table.
  const sel = await overrides();
  const categories: RemoteCategory[] = [];
  for (let paged = 1; paged <= 30; paged++) {
    await boundedGoto(page, `${adminBase}edit-tags.php?taxonomy=category&paged=${paged}`, timeoutMs);
    const rows = await page.$$eval(
      anyOf('categoryRows', sel),
      (trs, cfg) =>
        trs.map((tr) => {
          const q = (s: string) => tr.querySelector(s);
          const name = (q(cfg.name)?.textContent ?? '').replace(/^[—–-]\s*/g, '').trim();
          return { id: Number((tr.id || '').replace('tag-', '')), name, slug: (q(cfg.slug)?.textContent ?? '').trim() || null, count: Number((q(cfg.count)?.textContent ?? '').trim()) || 0 };
        }),
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
