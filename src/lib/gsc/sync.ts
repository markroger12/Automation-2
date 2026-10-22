import { createHash } from 'node:crypto';
import { db } from '../db';
import { log } from '../log';
import { getValue, setValue } from '../settings';
import { listSitemaps, readKey, searchAnalytics, submitSitemap, inspectUrl, type AnalyticsRow } from './client';
import { resolveWebsiteProperty } from './property';

/**
 * Live Search Console data (owner request). Every sync stores one snapshot (source GSC_API) that replaces the
 * previous API snapshot of the website, so the Search Performance analysis (trends, declining pages, articles
 * without impressions, Content Refresh evidence) works as with an imported export:
 * - DATE: the last 16 months, including fresh days Google may still change (`dataState: all`);
 * - PAGE and QUERY: the last 28 days with the 28 days before as the comparison period;
 * - HOUR: the last 3 days, hourly (`HOURLY_ALL`; the latest hours are incomplete).
 * Numbers are exactly what the API returns: nothing is estimated or filled in.
 */

export const SYNC_EVERY_MS = 2 * 3600_000;
const DAY = 86_400_000;

/** Search Console days are Pacific Time calendar days. */
function ptDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
const shift = (iso: string, days: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10);

export interface SyncState {
  at: string;
  ok: boolean;
  error?: string | null;
  firstIncompleteDate?: string | null;
  snapshotId?: string | null;
}
export const syncKey = (websiteId: string) => `gsc.sync.${websiteId}`;

/** The website's property; detected from the service account's own list when the configured one is not usable. */
export async function websiteProperty(websiteId: string): Promise<{ site: { id: string; name: string; publicUrl: string }; property: string | null }> {
  const { site, property } = await resolveWebsiteProperty(websiteId);
  return { site, property };
}

export async function syncWebsite(websiteId: string, now = new Date()): Promise<SyncState & { days: number; pages: number; queries: number; hours: number }> {
  const { site, property, accessible } = await resolveWebsiteProperty(websiteId, { fresh: true });
  if (!property) throw new Error(`${site.name} has no Search Console property (website page → Search Console property)${accessible?.length ? `; the service account can use: ${accessible.map((p) => p.siteUrl).join(', ')}` : ''}.`);
  if (accessible && !accessible.some((p) => p.siteUrl === property && p.permissionLevel !== 'siteUnverifiedUser')) {
    const key = readKey();
    const msg = `${key?.client_email ?? 'The service account'} has no access to ${property}${accessible.length ? ` (it can use: ${accessible.map((p) => p.siteUrl).join(', ')})` : ' (it has no property yet)'}. In Search Console, open the property of ${site.publicUrl} → Settings → Users and permissions, and add ${key?.client_email ?? 'the service account'} with “Full” permission.`;
    await setValue(syncKey(websiteId), { at: now.toISOString(), ok: false, error: msg } satisfies SyncState);
    throw new Error(msg);
  }
  try {
    const today = ptDate(now);
    const curStart = shift(today, -27);
    const prevEnd = shift(curStart, -1);
    const prevStart = shift(prevEnd, -27);
    const [dates, pages, prevPages, queries, prevQueries, hours] = await Promise.all([
      searchAnalytics(property, { startDate: shift(today, -480), endDate: today, dimensions: ['date'], dataState: 'all' }),
      searchAnalytics(property, { startDate: curStart, endDate: today, dimensions: ['page'], dataState: 'all' }, 50_000),
      searchAnalytics(property, { startDate: prevStart, endDate: prevEnd, dimensions: ['page'], dataState: 'all' }, 50_000),
      searchAnalytics(property, { startDate: curStart, endDate: today, dimensions: ['query'], dataState: 'all' }, 5_000),
      searchAnalytics(property, { startDate: prevStart, endDate: prevEnd, dimensions: ['query'], dataState: 'all' }, 5_000),
      searchAnalytics(property, { startDate: shift(today, -2), endDate: today, dimensions: ['hour'], dataState: 'hourly_all' }),
    ]);
    const prevBy = (rows: AnalyticsRow[]) => new Map(rows.map((r) => [r.keys?.[0] ?? '', r]));
    const prevPage = prevBy(prevPages.rows);
    const prevQuery = prevBy(prevQueries.rows);
    const row = (dimension: string, r: AnalyticsRow, prev?: AnalyticsRow) => ({
      websiteId,
      dimension,
      key: r.keys?.[0] ?? '',
      clicks: Math.round(r.clicks),
      impressions: Math.round(r.impressions),
      ctr: r.ctr,
      position: r.position,
      prevClicks: prev ? Math.round(prev.clicks) : dimension === 'PAGE' || dimension === 'QUERY' ? 0 : null,
      prevImpressions: prev ? Math.round(prev.impressions) : dimension === 'PAGE' || dimension === 'QUERY' ? 0 : null,
      prevCtr: prev?.ctr ?? null,
      prevPosition: prev?.position ?? null,
    });
    const rows = [
      ...dates.rows.map((r) => row('DATE', r)),
      ...pages.rows.map((r) => row('PAGE', r, prevPage.get(r.keys?.[0] ?? ''))),
      ...queries.rows.map((r) => row('QUERY', r, prevQuery.get(r.keys?.[0] ?? ''))),
      ...hours.rows.map((r) => row('HOUR', r)),
    ].filter((r) => r.key);
    const firstIncompleteDate = dates.firstIncompleteDate ?? null;
    const notes = [
      `Live data from the Search Console API, synced ${now.toISOString()}.`,
      firstIncompleteDate ? `Days from ${firstIncompleteDate} are fresh data that Google may still change.` : 'Includes fresh data that Google may still change.',
    ];
    const snapshot = await db.$transaction(async (tx) => {
      const created = await tx.searchPerformanceSnapshot.create({
        data: {
          websiteId,
          property,
          source: 'GSC_API',
          fileName: 'Search Console API',
          sha256: createHash('sha256').update(`${websiteId}:${now.toISOString()}`).digest('hex'),
          startDate: curStart,
          endDate: today,
          compare: true,
          pageRows: pages.rows.length,
          queryRows: queries.rows.length,
          dateRows: dates.rows.length,
          notes: JSON.stringify(notes),
          importedAt: now,
        },
      });
      for (let i = 0; i < rows.length; i += 500) await tx.searchPerformanceRow.createMany({ data: rows.slice(i, i + 500).map((r) => ({ ...r, snapshotId: created.id })) });
      // The new sync replaces the previous one (imported exports are kept).
      await tx.searchPerformanceSnapshot.deleteMany({ where: { websiteId, source: 'GSC_API', id: { not: created.id } } });
      return created;
    }, { timeout: 120_000, maxWait: 30_000 });
    const state: SyncState = { at: now.toISOString(), ok: true, error: null, firstIncompleteDate, snapshotId: snapshot.id };
    await setValue(syncKey(websiteId), state);
    return { ...state, days: dates.rows.length, pages: pages.rows.length, queries: queries.rows.length, hours: hours.rows.length };
  } catch (error) {
    const state: SyncState = { at: now.toISOString(), ok: false, error: (error as Error).message };
    await setValue(syncKey(websiteId), state);
    await log({ level: 'warn', category: 'search', message: `${site.name}: Search Console sync failed: ${state.error}` });
    throw error;
  }
}

// ------------------------------------------------------------------ indexing: sitemap resubmit + proof

/** Wait after a verified publish before resubmitting the sitemap (owner: “30 or 40 seconds after publishing”). */
export const SUBMIT_AFTER_MS = 35_000;
/** URL-inspection checks after publishing: 1 h, 6 h, 24 h, then daily until 14 days. */
export const CHECK_OFFSETS_H = [1, 6, 24, 48, 72, 96, 120, 144, 168, 192, 216, 240, 264, 288, 312, 336];

function nextCheck(publishedAt: Date, checksDone: number): Date | null {
  const h = CHECK_OFFSETS_H[checksDone];
  return h === undefined ? null : new Date(publishedAt.getTime() + h * 3600_000);
}

/** The sitemaps Search Console already knows for the property, else the site's Rank Math/Yoast sitemap index. */
async function resubmitSitemaps(property: string, publicUrl: string): Promise<string[]> {
  const known = (await listSitemaps(property)).map((s) => s.path).filter((p) => /^https?:\/\//.test(p));
  const targets = known.length ? known : [`${publicUrl.replace(/\/+$/, '')}/sitemap_index.xml`];
  for (const t of targets) await submitSitemap(property, t);
  return targets;
}

/**
 * Published workflow posts: resubmit the sitemap ~35 s after a verified publish (workflow switch “request
 * indexing”), then ask Google's URL Inspection for proof. INDEXED only when Google says the URL is on Google.
 */
export async function indexingTick(now = new Date(), maxInspections = 20): Promise<{ submitted: number; inspected: number; indexed: number }> {
  if (!readKey()) return { submitted: 0, inspected: 0, indexed: 0 };
  let submitted = 0;
  let inspected = 0;
  let indexed = 0;

  // 1. Newly published: request (sitemap) and schedule the first check.
  const fresh = await db.workflowKeyword.findMany({
    where: { status: 'PUBLISHED', indexCheckAt: null, indexChecks: 0, publishedUrl: { not: null }, publishedAt: { lte: new Date(now.getTime() - SUBMIT_AFTER_MS) } },
    include: { workflow: { select: { requestIndexing: true, websiteId: true, searchConsoleProperty: true } } },
    take: 50,
  });
  const submittedFor = new Map<string, string>();
  for (const kw of fresh) {
    const { site, property } = await websiteProperty(kw.workflow.websiteId);
    if (!property) continue;
    const publishedAt = kw.publishedAt ?? now;
    let status = kw.status;
    let note = 'Indexing not requested (workflow switch off); Google’s index status is checked.';
    let requestedAt: Date | null = null;
    if (kw.workflow.requestIndexing) {
      try {
        if (!submittedFor.has(site.id)) submittedFor.set(site.id, (await resubmitSitemaps(property, site.publicUrl)).join(', '));
        requestedAt = now;
        status = 'INDEXING_REQUESTED';
        note = `Sitemap resubmitted to Google (${submittedFor.get(site.id)}) at ${now.toISOString()}. A request is not proof of indexing; Google is asked for the index status next.`;
        submitted++;
      } catch (error) {
        note = `Sitemap could not be resubmitted: ${(error as Error).message}`;
      }
    }
    await db.workflowKeyword.update({ where: { id: kw.id }, data: { status, indexingRequestedAt: requestedAt ?? kw.indexingRequestedAt, indexingStatus: note, indexCheckAt: nextCheck(publishedAt, 0) ?? now } });
    await log({ category: 'search', message: `${site.name}: “${kw.keyword}” published — ${note}` });
  }

  // 2. Proof: URL Inspection when a check is due.
  const due = await db.workflowKeyword.findMany({
    where: { status: { in: ['PUBLISHED', 'INDEXING_REQUESTED'] }, indexCheckAt: { lte: now }, publishedUrl: { not: null } },
    include: { workflow: { select: { websiteId: true } } },
    orderBy: { indexCheckAt: 'asc' },
    take: maxInspections,
  });
  for (const kw of due) {
    const { site, property } = await websiteProperty(kw.workflow.websiteId);
    if (!property) continue;
    const checks = kw.indexChecks + 1;
    try {
      const { result } = await inspectUrl(property, kw.publishedUrl!);
      inspected++;
      const what = `${result.coverageState ?? result.verdict ?? 'no answer'}${result.lastCrawlTime ? ` · last crawl ${result.lastCrawlTime}` : ''} · checked ${now.toISOString()}`;
      if (result.verdict === 'PASS') {
        indexed++;
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'INDEXED', indexingStatus: `Google: URL is on Google (${what})`, indexChecks: checks, indexCheckAt: null } });
        await log({ category: 'search', message: `${site.name}: “${kw.keyword}” is indexed — Google: ${what}` });
        continue;
      }
      const next = nextCheck(kw.publishedAt ?? now, checks);
      await db.workflowKeyword.update({
        where: { id: kw.id },
        data: { indexChecks: checks, indexCheckAt: next, indexingStatus: next ? `Google: not on Google yet (${what}); next check ${next.toISOString()}` : `Not indexed 14 days after publishing (Google: ${what}). No more automatic checks.` },
      });
    } catch (error) {
      // Quota or permission: try again in an hour, the schedule does not advance.
      await db.workflowKeyword.update({ where: { id: kw.id }, data: { indexCheckAt: new Date(now.getTime() + 3600_000), indexingStatus: `Index status not checked: ${(error as Error).message}` } });
    }
  }
  return { submitted, inspected, indexed };
}

/** Websites whose live data is due (connected key, a property, last sync older than SYNC_EVERY_MS). */
export async function syncDue(now = new Date()): Promise<string[]> {
  if (!readKey()) return [];
  const sites = await db.website.findMany({ where: { active: true }, select: { id: true } });
  const due: string[] = [];
  for (const s of sites) {
    const { property } = await websiteProperty(s.id);
    if (!property) continue;
    const last = await getValue<SyncState | null>(syncKey(s.id), null);
    if (!last || now.getTime() - Date.parse(last.at) >= (last.ok ? SYNC_EVERY_MS : 30 * 60_000)) due.push(s.id);
  }
  return due;
}
