import type { Website } from '@prisma/client';
import { db } from '@/lib/db';
import { log } from '@/lib/log';
import { getSettings } from '@/lib/settings';
import { stripTags } from '@/lib/content/text';
import { safeFetch } from '@/lib/links/net';
import { withSiteContext } from './browser';
import { siteRef } from './session';
import { WpClient } from './client';

/**
 * Per-website index of PUBLISHED posts that new articles may link to.
 * Read from the site's public REST API (no browser needed); falls back to the
 * logged-in session when anonymous REST access is blocked. Incremental by
 * modification date; a full pass at most once a day marks deleted posts as
 * REMOVED. Drafts are never link targets.
 */

interface RestPost {
  id: number;
  link: string;
  slug: string;
  title: { rendered: string };
  excerpt?: { rendered: string };
  categories?: number[];
  date_gmt?: string;
  modified_gmt?: string;
}

const FIELDS = 'id,link,slug,title,excerpt,categories,date_gmt,modified_gmt';
const decode = (s: string) =>
  stripTags(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .trim();

function restUrls(site: Website, page: number, since: Date | null): string[] {
  const base = site.publicUrl.replace(/\/?$/, '/');
  const q = new URLSearchParams({ status: 'publish', per_page: '100', page: String(page), orderby: 'modified', order: 'desc', _fields: FIELDS });
  if (since) q.set('modified_after', since.toISOString().replace(/\.\d+Z$/, ''));
  return [`${base}wp-json/wp/v2/posts?${q}`, `${base}?rest_route=${encodeURIComponent('/wp/v2/posts')}&${q}`];
}

async function viaPublicRest(site: Website, since: Date | null, timeoutMs: number): Promise<RestPost[] | null> {
  const host = new URL(site.publicUrl).hostname;
  const all: RestPost[] = [];
  let form: number | null = null;
  for (let page = 1; page <= 50; page++) {
    let items: RestPost[] | null = null;
    const urls = restUrls(site, page, since);
    for (const [i, url] of urls.entries()) {
      if (form !== null && i !== form) continue;
      try {
        const res = await safeFetch(url, { trustedHosts: [host], timeoutMs, maxBytes: 4_000_000 });
        if (res.status === 400 && page > 1) {
          items = [];
          break;
        }
        if (res.status !== 200) continue;
        const json = JSON.parse(res.body) as unknown;
        if (!Array.isArray(json)) continue;
        items = json as RestPost[];
        form = i;
        break;
      } catch {
        /* try the other URL form */
      }
    }
    if (items === null) return page === 1 ? null : all;
    all.push(...items);
    if (items.length < 100) break;
  }
  return all;
}

async function viaSession(site: Website, since: Date | null, timeoutMs: number): Promise<RestPost[] | null> {
  const profile = site.wordpressProfileId ? await db.browserProfile.findUnique({ where: { id: site.wordpressProfileId } }) : null;
  if (!profile || profile.sessionState === 'LOGIN_REQUIRED') return null;
  const settings = await getSettings();
  return withSiteContext(siteRef(site), { headed: settings.browser.mode === 'headed', purpose: 'link-index' }, async (context) => {
    const client = await WpClient.connect(context, siteRef(site), { timeoutMs });
    const all: RestPost[] = [];
    for (let page = 1; page <= 50; page++) {
      const res = await client.call<RestPost[]>('GET', '/wp/v2/posts', {
        query: { status: 'publish', per_page: 100, page, orderby: 'modified', order: 'desc', _fields: FIELDS, ...(since ? { modified_after: since.toISOString().replace(/\.\d+Z$/, '') } : {}) },
      });
      all.push(...(res.data ?? []));
      if ((res.data ?? []).length < 100 || page >= Number(res.headers['x-wp-totalpages'] ?? '1')) break;
    }
    return all;
  });
}

export interface IndexRefresh {
  refreshed: boolean;
  via: 'public-rest' | 'session' | 'cache';
  fetched: number;
  active: number;
  removed: number;
  warning?: string;
}

export async function refreshLinkIndex(site: Website, opts: { force?: boolean; maxAgeHours?: number } = {}): Promise<IndexRefresh> {
  const settings = await getSettings();
  const maxAgeMs = (opts.maxAgeHours ?? settings.seo.internalLinkIndexHours) * 3_600_000;
  const now = Date.now();
  const active = () => db.linkTarget.count({ where: { websiteId: site.id, status: 'ACTIVE' } });
  if (!opts.force && site.linkIndexSyncedAt && now - site.linkIndexSyncedAt.getTime() < maxAgeMs) return { refreshed: false, via: 'cache', fetched: 0, active: await active(), removed: 0 };
  const full = Boolean(opts.force) || !site.linkIndexFullSyncAt || now - site.linkIndexFullSyncAt.getTime() > 24 * 3_600_000;
  const since = full || !site.linkIndexSyncedAt ? null : new Date(site.linkIndexSyncedAt.getTime() - 3_600_000);
  const timeoutMs = Math.min(30_000, settings.browser.navigationTimeoutSec * 1000);
  let via: IndexRefresh['via'] = 'public-rest';
  let posts = await viaPublicRest(site, since, timeoutMs);
  if (posts === null) {
    via = 'session';
    posts = await viaSession(site, since, timeoutMs).catch(() => null);
  }
  if (posts === null) {
    const warning = `${site.name}: the internal link index could not be refreshed (REST API not reachable anonymously and no active WordPress session). Using ${await active()} cached post(s).`;
    await log({ level: 'warn', category: 'links', message: warning });
    return { refreshed: false, via: 'cache', fetched: 0, active: await active(), removed: 0, warning };
  }
  const ids = posts.map((p) => p.id);
  const keywords = new Map(
    (await db.articleTask.findMany({ where: { websiteId: site.id, wpPostId: { in: ids } }, select: { wpPostId: true, keyword: true } })).map((t) => [t.wpPostId!, t.keyword]),
  );
  for (const p of posts) {
    if (!p.link || !/^https?:\/\//.test(p.link)) continue;
    const data = {
      url: p.link,
      title: decode(p.title?.rendered ?? '') || p.slug,
      slug: p.slug || null,
      categoryIds: JSON.stringify(p.categories ?? []),
      keyword: keywords.get(p.id) ?? null,
      excerpt: decode(p.excerpt?.rendered ?? '').slice(0, 600) || null,
      publishedAt: p.date_gmt ? new Date(`${p.date_gmt}Z`) : null,
      modifiedAt: p.modified_gmt ? new Date(`${p.modified_gmt}Z`) : null,
      status: 'ACTIVE',
    };
    await db.linkTarget.upsert({ where: { websiteId_wpPostId: { websiteId: site.id, wpPostId: p.id } }, create: { websiteId: site.id, wpPostId: p.id, ...data }, update: data });
  }
  let removed = 0;
  if (full) removed = (await db.linkTarget.updateMany({ where: { websiteId: site.id, wpPostId: { notIn: ids }, status: { not: 'REMOVED' } }, data: { status: 'REMOVED', checkNote: 'No longer published' } })).count;
  await db.website.update({ where: { id: site.id }, data: { linkIndexSyncedAt: new Date(), ...(full ? { linkIndexFullSyncAt: new Date() } : {}) } });
  const count = await active();
  await log({ category: 'links', message: `${site.name}: link index ${full ? 'fully ' : ''}refreshed via ${via} (${posts.length} post(s) read, ${count} active, ${removed} removed).` });
  return { refreshed: true, via, fetched: posts.length, active: count, removed };
}
