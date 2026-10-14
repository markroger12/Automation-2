import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { browserLaunchBase } from '@/lib/browser-launch';
import { dataPaths, profileDirForSlug } from '@/lib/paths';
import { log } from '@/lib/log';
import { anyOf } from './selectors';
import { installPublishGuard } from './publish-guard';

/**
 * Persistent WordPress browser profiles (data/profiles/<slug>), one context
 * per profile at a time. Headless contexts are pooled and reused for a few
 * minutes (fewer cold starts); a visible login window closes any pooled
 * headless context first because Chrome cannot open one profile twice.
 */

export interface SiteRef {
  id: string;
  slug: string;
  name: string;
  adminUrl: string;
  publicUrl: string;
  language: string;
}

interface PoolEntry {
  context: BrowserContext;
  headed: boolean;
  idleTimer: NodeJS.Timeout | null;
}

const pool = new Map<string, PoolEntry>();
const chains = new Map<string, Promise<unknown>>();
const IDLE_CLOSE_MS = 3 * 60_000;

type ContextHook = (context: BrowserContext, site: SiteRef) => Promise<void>;
const contextHooks: ContextHook[] = [];
/** Hooks run on every new WordPress context (the publish guard installs itself here). */
export function onWordPressContext(hook: ContextHook) {
  contextHooks.push(hook);
}

async function launch(site: SiteRef, headed: boolean, options: { disableQuic?: boolean } = {}): Promise<BrowserContext> {
  const dir = profileDirForSlug(site.slug);
  fs.mkdirSync(dir, { recursive: true });
  const context = await chromium.launchPersistentContext(dir, {
    ...browserLaunchBase(),
    // BAS_FORCE_HEADLESS is for automated tests on machines without a display.
    headless: !headed || process.env.BAS_FORCE_HEADLESS === '1',
    viewport: { width: 1366, height: 900 },
    locale: site.language === 'de' ? 'de-DE' : 'en-US',
    acceptDownloads: false,
    args: ['--no-first-run', '--no-default-browser-check', ...(options.disableQuic ? ['--disable-quic'] : [])],
  });
  context.setDefaultNavigationTimeout(60_000);
  // The worker runs under tsx/esbuild, which wraps named functions in a `__name()` helper. Functions
  // passed to page.evaluate are serialized into the page, where that helper does not exist — define a
  // no-op so in-page code never fails with "__name is not defined".
  await context.addInitScript({ content: 'window.__name = window.__name || function (f) { return f; };' });
  // Every WordPress context gets the network-level publish guard before any page opens.
  await installPublishGuard(context, site.id);
  for (const hook of contextHooks) await hook(context, site);
  return context;
}

async function closeEntry(key: string) {
  const entry = pool.get(key);
  if (!entry) return;
  pool.delete(key);
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  await entry.context.close().catch(() => {});
}

/**
 * Run `fn` with exclusive use of a site's profile. Calls for the same profile
 * are serialized; different sites run independently.
 */
export async function withSiteContext<T>(site: SiteRef, options: { headed: boolean; purpose: string; disableQuic?: boolean }, fn: (context: BrowserContext) => Promise<T>): Promise<T> {
  const key = site.slug;
  const previous = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const chain = previous.then(() => mine);
  chains.set(key, chain);
  await previous.catch(() => {});
  try {
    let entry = pool.get(key);
    if (entry && entry.headed !== options.headed) {
      await closeEntry(key);
      entry = undefined;
    }
    if (entry && !isContextAlive(entry.context)) {
      await closeEntry(key);
      entry = undefined;
    }
    if (!entry) {
      entry = { context: await launch(site, options.headed, { disableQuic: options.disableQuic }), headed: options.headed, idleTimer: null };
      pool.set(key, entry);
    }
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try {
      return await fn(entry.context);
    } finally {
      if (options.headed) {
        await closeEntry(key);
      } else {
        const e = pool.get(key);
        if (e) e.idleTimer = setTimeout(() => void closeEntry(key), IDLE_CLOSE_MS);
      }
    }
  } finally {
    release();
    if (chains.get(key) === chain) chains.delete(key);
  }
}

function isContextAlive(context: BrowserContext): boolean {
  try {
    context.pages();
    return Boolean(context.browser()?.isConnected() ?? true);
  } catch {
    return false;
  }
}

// Global limit on simultaneous WordPress browser operations (Settings → workflow.wordpressConcurrency).
let wpActive = 0;
const wpWaiters: (() => void)[] = [];
export async function withWordPressSlot<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  while (wpActive >= Math.max(1, limit)) await new Promise<void>((resolve) => wpWaiters.push(resolve));
  wpActive++;
  try {
    return await fn();
  } finally {
    wpActive--;
    wpWaiters.shift()?.();
  }
}

export async function closeSiteContext(slug: string) {
  await closeEntry(slug);
}

export async function closeAllContexts() {
  for (const key of [...pool.keys()]) await closeEntry(key);
}

/** Bounded navigation: commit, then DOM readiness with a timeout. Assets may keep loading. */
export async function boundedGoto(page: Page, url: string, timeoutMs = 60_000): Promise<void> {
  await page.goto(url, { waitUntil: 'commit', timeout: timeoutMs });
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs }).catch(() => {});
}

/** Hide known host/plugin overlays only. Never touches <html> or <body>. */
export async function dismissOverlays(page: Page, overrides: Record<string, string[]> = {}): Promise<number> {
  const selector = anyOf('hostOverlays', overrides);
  return page
    .evaluate((sel) => {
      let hidden = 0;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        if (el === document.documentElement || el === document.body) continue;
        el.style.setProperty('display', 'none', 'important');
        el.setAttribute('data-bas-hidden-overlay', '1');
        hidden++;
      }
      return hidden;
    }, selector)
    .catch(() => 0);
}

/** Viewport-only screenshot saved under data/screenshots; returns the stored relative path. */
export async function captureScreenshot(page: Page, label: string, taskId?: string | null): Promise<string | null> {
  try {
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${label.replace(/[^a-z0-9-]+/gi, '-').slice(0, 40)}-${randomUUID().slice(0, 8)}.png`;
    fs.mkdirSync(dataPaths.screenshots(), { recursive: true });
    const file = path.join(dataPaths.screenshots(), name);
    await page.screenshot({ path: file, fullPage: false, timeout: 10_000 });
    await log({ level: 'warn', category: 'wordpress', taskId, message: `Screenshot captured: ${label}`, screenshotPath: `screenshots/${name}` });
    return `screenshots/${name}`;
  } catch {
    return null;
  }
}

export async function firstPage(context: BrowserContext): Promise<Page> {
  return context.pages()[0] ?? (await context.newPage());
}
