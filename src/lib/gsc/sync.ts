import { createHash } from 'node:crypto';
import { db } from '../db';
import { errorMessage, log } from '../log';
import { getValue, setValue } from '../settings';
import { readKey, searchAnalytics, inspectUrl, type AnalyticsRow } from './client';
import { resolveWebsiteProperty } from './property';
import { pendingRequestNote, queueIndexingRequest, requestIndexingAgain } from './request-indexing';
import { googleIndexCheck, indexCheckConfigured, IndexCheckError } from './google-index';
import { inspectionProperty } from '../workflow/search-console';

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

// ------------------------------------------------------------------ indexing: Search Console request + Google search

/** Wait after a verified publish before indexing is requested (owner: “30 or 40 seconds after publishing”). */
export const SUBMIT_AFTER_MS = 35_000;
const DAY_MS = 24 * 3600_000;
/** Requests and checks stop when an article is still not found this many days after publishing. */
export const INDEX_DAYS = 14;

async function requestPayload(kw: { id: string; publishedUrl: string | null }, websiteId: string) {
  const { site, property } = await websiteProperty(websiteId);
  // No property set or detected: the website's URL as a URL-prefix property (as the workflow page's link does).
  const requestProperty = property ?? inspectionProperty(null, site.publicUrl);
  // Google's own URL Inspection link for the post (the fallback when the “Inspect any URL” box does not work).
  const inspectLink = readKey() ? await inspectUrl(requestProperty, kw.publishedUrl!).then((r) => r.link).catch(() => null) : null;
  return { site, payload: { keywordId: kw.id, url: kw.publishedUrl!, property: requestProperty, websiteId: site.id, inspectLink } };
}

/**
 * Published workflow posts (owner request, 2026-11-04: “one request a day; 24 hours later check whether it is
 * indexed; if not, request again”):
 *  1. ~35 s after a verified publish, “Request indexing” is queued for Automation Chrome (workflow switch).
 *  2. 24 hours after the request (or after publishing, without the switch), Google search is asked through the search
 *     API (Serper: `site:` + the address) whether the post is on Google — not Search Console.
 *  3. Found → INDEXED. Not found → indexing is requested again (never twice within a day) and searched a day later;
 *     after 14 days without it, requests and searches stop.
 */
export async function indexingTick(now = new Date(), maxChecks = 20): Promise<{ submitted: number; checked: number; indexed: number }> {
  let submitted = 0;
  let checked = 0;
  let indexed = 0;

  // 1. Newly published: request indexing as the owner does it — URL Inspection → REQUEST INDEXING in Search Console,
  //    by Automation Chrome (owner request: not by resubmitting the sitemap) — and schedule the first search.
  const fresh = await db.workflowKeyword.findMany({
    where: { status: 'PUBLISHED', indexCheckAt: null, indexChecks: 0, publishedUrl: { not: null }, publishedAt: { lte: new Date(now.getTime() - SUBMIT_AFTER_MS) } },
    include: { workflow: { select: { requestIndexing: true, websiteId: true } } },
    take: 50,
  });
  for (const kw of fresh) {
    const publishedAt = kw.publishedAt ?? now;
    let note = 'Indexing not requested (workflow switch off); Google search is checked a day after publishing.';
    let siteName = '';
    if (kw.workflow.requestIndexing) {
      const { site, payload } = await requestPayload(kw, kw.workflow.websiteId);
      siteName = site.name;
      await queueIndexingRequest(payload, now);
      note = 'Waiting for Automation Chrome to request indexing in Search Console (URL Inspection → Request indexing). Google search is checked 24 hours after the request.';
      submitted++;
    }
    if (!indexCheckConfigured()) note += ' The Google search check needs a Serper key (SERPER_API_KEY in .env).';
    await db.workflowKeyword.update({ where: { id: kw.id }, data: { indexingStatus: note, indexCheckAt: new Date(publishedAt.getTime() + DAY_MS) } });
    await log({ category: 'search', message: `${siteName ? `${siteName}: ` : ''}“${kw.keyword}” published — ${note}` });
  }

  // 2. Due searches: is the post on Google?
  const due = await db.workflowKeyword.findMany({
    where: { status: { in: ['PUBLISHED', 'INDEXING_REQUESTED'] }, indexCheckAt: { lte: now }, publishedUrl: { not: null } },
    include: { workflow: { select: { websiteId: true, requestIndexing: true, website: { select: { name: true, language: true } } } } },
    orderBy: { indexCheckAt: 'asc' },
    take: maxChecks,
  });
  for (const kw of due) {
    const pending = await pendingRequestNote(kw.id);
    const requested = kw.status === 'INDEXING_REQUESTED' && kw.indexingRequestedAt ? `Indexing requested in Search Console at ${kw.indexingRequestedAt.toISOString()}.` : null;
    const also = pending ?? requested;
    if (!indexCheckConfigured()) {
      await db.workflowKeyword.update({ where: { id: kw.id }, data: { indexCheckAt: new Date(now.getTime() + DAY_MS), indexingStatus: `Google search not checked: add a Serper key (SERPER_API_KEY=… in .env, serper.dev) and restart the app; looked at again in a day.${also ? ` · ${also}` : ''}` } });
      continue;
    }
    const checks = kw.indexChecks + 1;
    try {
      const r = await googleIndexCheck(kw.publishedUrl!, kw.workflow.website.language);
      checked++;
      const when = now.toISOString();
      if (r.found) {
        indexed++;
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'INDEXED', indexingStatus: `Google: found in Google search (${r.query}) · checked ${when}`, indexChecks: checks, indexCheckAt: null } });
        // A request still waiting is not needed any more.
        await db.queueJob.updateMany({ where: { queue: 'gsc', idempotencyKey: `gsc-index:${kw.id}`, status: 'WAITING' }, data: { status: 'CANCELLED', finishedAt: now, error: 'Google search already shows the URL.' } });
        await log({ category: 'search', message: `${kw.workflow.website.name}: “${kw.keyword}” is on Google — found in Google search (${r.query}).` });
        continue;
      }
      const notFound = `Google: not in Google search yet (${r.query}, ${r.results} result(s), checked ${when})`;
      const publishedAt = kw.publishedAt ?? kw.updatedAt;
      if (now.getTime() - publishedAt.getTime() >= INDEX_DAYS * DAY_MS) {
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { indexChecks: checks, indexCheckAt: null, indexingStatus: `Not found in Google search ${INDEX_DAYS} days after publishing (last search ${when}). No more automatic requests or searches.` } });
        await db.queueJob.updateMany({ where: { queue: 'gsc', idempotencyKey: `gsc-index:${kw.id}`, status: 'WAITING' }, data: { status: 'CANCELLED', finishedAt: now, error: `Not on Google ${INDEX_DAYS} days after publishing; requests stopped.` } });
        continue;
      }
      if (kw.workflow.requestIndexing) {
        // Owner: not indexed → request again (one request a day), and search again a day after it.
        const { payload } = await requestPayload(kw, kw.workflow.websiteId);
        const at = await requestIndexingAgain(payload, now);
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { indexChecks: checks, indexCheckAt: new Date(at.getTime() + DAY_MS), indexingStatus: `${notFound}. Indexing is requested again ${at.getTime() <= now.getTime() ? 'now' : `at ${at.toISOString()}`} (one request a day); Google search is checked 24 hours after it.` } });
      } else {
        const next = new Date(now.getTime() + DAY_MS);
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { indexChecks: checks, indexCheckAt: next, indexingStatus: `${notFound}; next search ${next.toISOString()}.${also ? ` · ${also}` : ''}` } });
      }
    } catch (error) {
      // The search API: network or HTTP → an hour; the key or its credits → a day. The schedule does not advance.
      const code = error instanceof IndexCheckError ? error.code : 'NETWORK';
      const next = new Date(now.getTime() + (code === 'KEY' || code === 'LIMIT' ? DAY_MS : 3600_000));
      const why = error instanceof IndexCheckError ? error.message : checkError(error);
      await db.workflowKeyword.update({ where: { id: kw.id }, data: { indexCheckAt: next, indexingStatus: `Google search not checked: ${why}; asked again ${code === 'KEY' || code === 'LIMIT' ? 'in a day' : 'in an hour'}.${also ? ` · ${also}` : ''}` } });
    }
  }
  return { submitted, checked, indexed };
}

/** Node's fetch says only “fetch failed”: name the network problem behind it. */
function checkError(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } } | null)?.cause;
  if (error instanceof Error && error.message === 'fetch failed') return `Google could not be reached from this computer (${cause?.code ?? cause?.message ?? 'network error'})`;
  if (error instanceof Error && error.name === 'TimeoutError') return 'Google did not answer within a minute';
  return errorMessage(error);
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
