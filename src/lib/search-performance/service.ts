import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { AppError, badRequest, notFound } from '@/lib/errors';
import { audit } from '@/lib/audit';
import { normalizeSearchConsoleProperty } from '@/lib/workflow/search-console';
import { isZip, readZip, ZipError } from '@/lib/zip';
import { pageInProperty, pageKey, parseGscExport, type GscRow } from './gsc-export';
import { addDays, trends, type DailyPoint } from './trends';

/**
 * Search Performance (upgrade 10). The only data source is what the owner
 * exported from Search Console and imported here; nothing is fetched from
 * Google and nothing is estimated. Without a property the page says NOT
 * CONNECTED; with a property but no import it says NO VERIFIED DATA.
 */

/** Search Console lists at most 1,000 rows per table in an export. */
export const EXPORT_ROW_CAP = 1000;
/** Pages younger than this (days before the report's last day) are not called “zero impressions” yet. */
export const ZERO_IMPRESSION_MIN_AGE_DAYS = 14;
/** Declining: at least this many clicks before, and at most 70 % of them now. */
export const DECLINE_MIN_PREV_CLICKS = 10;
export const DECLINE_RATIO = 0.7;

export function siteProperty(site: { searchConsoleProperty: string | null }, workflowProperty?: string | null): string | null {
  return normalizeSearchConsoleProperty(site.searchConsoleProperty) ?? normalizeSearchConsoleProperty(workflowProperty ?? null);
}

async function propertyFor(websiteId: string): Promise<{ site: { id: string; name: string; publicUrl: string }; property: string | null }> {
  const site = await db.website.findUnique({ where: { id: websiteId }, select: { id: true, name: true, publicUrl: true, searchConsoleProperty: true, workflows: { select: { searchConsoleProperty: true }, take: 1 } } });
  if (!site) throw notFound('Website');
  return { site, property: siteProperty(site, site.workflows[0]?.searchConsoleProperty) };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function importSearchExport(websiteId: string, files: { name: string; bytes: Buffer }[], opts: { start?: string | null; end?: string | null } = {}) {
  const { site, property } = await propertyFor(websiteId);
  if (!property) throw new AppError(409, 'NOT_CONNECTED', `${site.name} has no Search Console property. Add it on the website page (e.g. “sc-domain:example.com” or “https://example.com/”) first.`);
  if (!files.length) throw badRequest('Choose the Search Console export (the .zip from “Export → Download CSV”, or its CSV files).');
  const texts: { name: string; text: string }[] = [];
  for (const f of files) {
    if (isZip(f.bytes)) {
      try {
        for (const e of readZip(f.bytes)) if (/\.csv$/i.test(e.name)) texts.push({ name: e.name.split('/').pop() ?? e.name, text: e.data.toString('utf8') });
      } catch (error) {
        throw badRequest(`${f.name}: ${error instanceof ZipError ? error.message : 'the archive could not be read.'}`);
      }
    } else if (/\.csv$/i.test(f.name) || /^[\s\S]{0,200}(clicks|klicks)/i.test(f.bytes.subarray(0, 400).toString('utf8'))) texts.push({ name: f.name, text: f.bytes.toString('utf8') });
    else throw badRequest(`${f.name} is not a Search Console CSV or zip export.`);
  }
  const parsed = parseGscExport(texts);
  if (!parsed.pages.length && !parsed.queries.length && !parsed.dates.length) {
    throw badRequest('No Search Console performance table was found (expected Pages.csv, Queries.csv or Dates.csv from Performance → Export).');
  }
  const searchType = (parsed.searchType ?? 'Web').trim();
  if (!/^(web|websuche|web search)$/i.test(searchType)) {
    throw new AppError(400, 'UNSUPPORTED_SEARCH_TYPE', `This export is for the search type “${searchType}”. Import the Web search report (Search type: Web).`);
  }
  const foreign = parsed.pages.filter((p) => !pageInProperty(p.key, property));
  if (foreign.length) {
    throw new AppError(400, 'WRONG_PROPERTY', `${foreign.length} page(s) in this export do not belong to ${property} (e.g. ${foreign.slice(0, 2).map((p) => p.key).join(', ')}). Export the report of this website's property.`);
  }
  const start = parsed.start ?? opts.start ?? null;
  const end = parsed.end ?? opts.end ?? null;
  if (!start || !end || !ISO.test(start) || !ISO.test(end) || start > end) {
    throw new AppError(400, 'PERIOD_REQUIRED', 'The export has no Dates.csv: enter the report period (first and last day as shown in Search Console).', { start: ['Required'], end: ['Required'] });
  }
  const sha256 = createHash('sha256')
    .update(
      texts
        .map((t) => `${t.name}\n${t.text}`)
        .sort()
        .join('\n\u0000'),
    )
    .digest('hex');
  if (await db.searchPerformanceSnapshot.findUnique({ where: { websiteId_sha256: { websiteId, sha256 } } })) {
    throw new AppError(409, 'ALREADY_IMPORTED', 'This export was already imported for this website.');
  }
  const snapshot = await db.searchPerformanceSnapshot.create({
    data: {
      websiteId,
      property,
      searchType: 'web',
      fileName: files.map((f) => f.name).join(', ').slice(0, 300),
      sha256,
      startDate: start,
      endDate: end,
      compare: parsed.compare,
      dateFilter: parsed.filters.date ?? parsed.filters.datum ?? null,
      pageRows: parsed.pages.length,
      queryRows: parsed.queries.length,
      dateRows: parsed.dates.length,
      notes: JSON.stringify(parsed.warnings),
    },
  });
  const rows = [
    ...parsed.pages.map((r) => toRow(r, 'PAGE')),
    ...parsed.queries.map((r) => toRow(r, 'QUERY')),
    ...parsed.dates.map((r) => toRow(r, 'DATE')),
  ].map((r) => ({ ...r, snapshotId: snapshot.id, websiteId }));
  for (let i = 0; i < rows.length; i += 500) await db.searchPerformanceRow.createMany({ data: rows.slice(i, i + 500) });
  await audit('search.import', 'Website', websiteId, { snapshotId: snapshot.id, start, end, pages: parsed.pages.length, queries: parsed.queries.length, dates: parsed.dates.length, compare: parsed.compare });
  return { snapshot, files: parsed.files, warnings: parsed.warnings };
}

function toRow(r: GscRow, dimension: 'PAGE' | 'QUERY' | 'DATE') {
  return {
    dimension,
    key: r.key.slice(0, 2000),
    clicks: r.current.clicks,
    impressions: r.current.impressions,
    ctr: r.current.ctr,
    position: r.current.position,
    prevClicks: r.previous?.clicks ?? null,
    prevImpressions: r.previous?.impressions ?? null,
    prevCtr: r.previous?.ctr ?? null,
    prevPosition: r.previous?.position ?? null,
  };
}

export async function deleteSearchSnapshot(id: string) {
  const s = await db.searchPerformanceSnapshot.findUnique({ where: { id } });
  if (!s) throw notFound('Import');
  await db.searchPerformanceSnapshot.delete({ where: { id } });
  await audit('search.import.delete', 'Website', s.websiteId, { snapshotId: id, start: s.startDate, end: s.endDate });
  return { ok: true };
}

/** App articles of a website with a WordPress post, keyed by comparable URL. */
async function siteArticles(websiteId: string) {
  const targets = await db.linkTarget.findMany({ where: { websiteId }, select: { wpPostId: true, url: true, title: true, status: true, publishedAt: true } });
  const tasks = await db.articleTask.findMany({ where: { websiteId, wpPostId: { not: null }, legacy: false }, select: { id: true, keyword: true, selectedTitle: true, wpPostId: true, status: true } });
  const keywords = await db.workflowKeyword.findMany({ where: { workflow: { websiteId }, taskId: { not: null } }, select: { taskId: true, status: true, publishedUrl: true, publishedAt: true, indexingRequestedAt: true } });
  const byPost = new Map(targets.map((t) => [t.wpPostId, t]));
  const byTask = new Map(keywords.map((k) => [k.taskId!, k]));
  return tasks.map((t) => {
    const target = byPost.get(t.wpPostId!);
    const kw = byTask.get(t.id);
    const url = target?.url ?? kw?.publishedUrl ?? null;
    return {
      taskId: t.id,
      title: t.selectedTitle ?? t.keyword,
      wpPostId: t.wpPostId!,
      url,
      key: url ? pageKey(url) : null,
      published: target?.status === 'ACTIVE' || kw?.status === 'PUBLISHED' || kw?.status === 'INDEXING_REQUESTED' || kw?.status === 'INDEXED',
      publishedAt: target?.publishedAt ?? kw?.publishedAt ?? null,
      indexingRequested: Boolean(kw?.indexingRequestedAt) || kw?.status === 'INDEXING_REQUESTED',
      indexedByOwner: kw?.status === 'INDEXED',
    };
  });
}

type RowLite = { key: string; clicks: number; impressions: number; ctr: number | null; position: number | null; prevClicks: number | null; prevImpressions: number | null; prevPosition: number | null };

export interface DecliningPage {
  url: string;
  clicks: number;
  prevClicks: number;
  impressions: number;
  prevImpressions: number | null;
  changePct: number;
  basis: string;
  taskId: string | null;
  title: string | null;
}

function days(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
}

export async function searchPerformance(websiteId: string) {
  const { site, property } = await propertyFor(websiteId);
  const snapshots = await db.searchPerformanceSnapshot.findMany({ where: { websiteId }, orderBy: [{ endDate: 'desc' }, { importedAt: 'desc' }] });
  const base = { site, property, snapshots: snapshots.map((s) => ({ ...s, notes: JSON.parse(s.notes || '[]') as string[] })) };
  if (!property) return { ...base, state: 'NOT_CONNECTED' as const };
  if (!snapshots.length) return { ...base, state: 'NO_DATA' as const };

  // Daily totals: one value per day, from the most recently imported report that has it.
  const dateRows = await db.searchPerformanceRow.findMany({ where: { websiteId, dimension: 'DATE' }, select: { key: true, clicks: true, impressions: true, position: true, snapshot: { select: { importedAt: true } } } });
  const daily = new Map<string, DailyPoint & { at: number }>();
  for (const r of dateRows) {
    const at = r.snapshot.importedAt.getTime();
    const prev = daily.get(r.key);
    if (!prev || prev.at < at) daily.set(r.key, { date: r.key, clicks: r.clicks, impressions: r.impressions, position: r.position, at });
  }
  const trend = trends([...daily.values()]);

  const latestPages = snapshots.find((s) => s.pageRows > 0) ?? null;
  const latestQueries = snapshots.find((s) => s.queryRows > 0) ?? null;
  const pageRows: RowLite[] = latestPages ? await db.searchPerformanceRow.findMany({ where: { snapshotId: latestPages.id, dimension: 'PAGE' }, orderBy: { clicks: 'desc' } }) : [];
  const queryRows: RowLite[] = latestQueries ? await db.searchPerformanceRow.findMany({ where: { snapshotId: latestQueries.id, dimension: 'QUERY' }, orderBy: { clicks: 'desc' }, take: 200 }) : [];

  const articles = await siteArticles(websiteId);
  const articleByKey = new Map(articles.filter((a) => a.key).map((a) => [a.key!, a]));
  const pages = pageRows.map((r) => {
    const a = articleByKey.get(pageKey(r.key));
    return { ...r, taskId: a?.taskId ?? null, title: a?.title ?? null };
  });

  // Declining pages: the export's own comparison period, else the previous report of the same length right before it.
  const declining: DecliningPage[] = [];
  if (latestPages) {
    let previous: Map<string, RowLite> | null = null;
    let basis = 'comparison period in the same export';
    if (!latestPages.compare) {
      const len = days(latestPages.startDate, latestPages.endDate);
      const before = snapshots.find((s) => s.id !== latestPages.id && s.pageRows > 0 && s.endDate < latestPages.startDate && days(s.startDate, s.endDate) === len);
      if (before) {
        previous = new Map((await db.searchPerformanceRow.findMany({ where: { snapshotId: before.id, dimension: 'PAGE' } })).map((r) => [pageKey(r.key), r]));
        basis = `report ${before.startDate} – ${before.endDate}`;
      }
    }
    for (const p of pages) {
      const prevClicks = latestPages.compare ? p.prevClicks : (previous?.get(pageKey(p.key))?.clicks ?? null);
      const prevImpressions = latestPages.compare ? p.prevImpressions : (previous?.get(pageKey(p.key))?.impressions ?? null);
      if (prevClicks == null || prevClicks < DECLINE_MIN_PREV_CLICKS || p.clicks > prevClicks * DECLINE_RATIO) continue;
      declining.push({ url: p.key, clicks: p.clicks, prevClicks, impressions: p.impressions, prevImpressions, changePct: Math.round(((p.clicks - prevClicks) / prevClicks) * 1000) / 10, basis, taskId: p.taskId, title: p.title });
    }
    declining.sort((a, b) => a.changePct - b.changePct);
  }

  // Zero impressions: published app articles old enough, absent from (or at 0 in) the latest page report.
  const zero: { taskId: string; title: string; url: string; publishedAt: Date | null; detail: string }[] = [];
  if (latestPages) {
    const shown = new Map(pageRows.map((r) => [pageKey(r.key), r]));
    const capped = latestPages.pageRows >= EXPORT_ROW_CAP;
    const cutoff = addDays(latestPages.endDate, -ZERO_IMPRESSION_MIN_AGE_DAYS);
    for (const a of articles) {
      if (!a.published || !a.key || !a.url) continue;
      if (a.publishedAt && a.publishedAt.toISOString().slice(0, 10) > cutoff) continue;
      const row = shown.get(a.key);
      if (row && row.impressions > 0) continue;
      if (!row && capped) continue; // a capped export proves nothing about pages it does not list
      zero.push({ taskId: a.taskId, title: a.title, url: a.url, publishedAt: a.publishedAt, detail: row ? `0 impressions in ${latestPages.startDate} – ${latestPages.endDate}` : `not in the page report ${latestPages.startDate} – ${latestPages.endDate}` });
    }
  }

  // Indexing: requests and the owner's own confirmations are kept apart from evidence in the imported data.
  const seen = new Set<string>();
  const anyPages = await db.searchPerformanceRow.findMany({ where: { websiteId, dimension: 'PAGE', impressions: { gt: 0 } }, select: { key: true } });
  for (const r of anyPages) seen.add(pageKey(r.key));
  const published = articles.filter((a) => a.published);
  const indexing = {
    published: published.length,
    requested: published.filter((a) => a.indexingRequested).length,
    confirmedByOwner: published.filter((a) => a.indexedByOwner).length,
    seenInSearch: published.filter((a) => a.key && seen.has(a.key)).length,
  };

  return {
    ...base,
    state: 'DATA' as const,
    timezoneNote: 'Search Console days are calendar days in Pacific Time; periods are shown exactly as exported.',
    trend,
    pagesReport: latestPages ? { id: latestPages.id, start: latestPages.startDate, end: latestPages.endDate, compare: latestPages.compare, capped: latestPages.pageRows >= EXPORT_ROW_CAP } : null,
    queriesReport: latestQueries ? { id: latestQueries.id, start: latestQueries.startDate, end: latestQueries.endDate } : null,
    pages: pages.slice(0, 200),
    queries: queryRows,
    declining,
    zero,
    indexing,
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};

export async function exportSearchCsv(websiteId: string, view: 'pages' | 'queries' | 'declining' | 'zero'): Promise<string> {
  const data = await searchPerformance(websiteId);
  if (data.state !== 'DATA') throw new AppError(409, data.state, data.state === 'NOT_CONNECTED' ? 'No Search Console property is set for this website.' : 'No Search Console data has been imported for this website.');
  const lines: unknown[][] = [];
  if (view === 'pages') {
    lines.push(['page', 'clicks', 'impressions', 'ctr_percent', 'position', 'previous_clicks', 'previous_impressions', 'article_task_id', 'period']);
    for (const p of data.pages) lines.push([p.key, p.clicks, p.impressions, p.ctr, p.position, p.prevClicks, p.prevImpressions, p.taskId, `${data.pagesReport?.start} – ${data.pagesReport?.end}`]);
  } else if (view === 'queries') {
    lines.push(['query', 'clicks', 'impressions', 'ctr_percent', 'position', 'period']);
    for (const q of data.queries) lines.push([q.key, q.clicks, q.impressions, q.ctr, q.position, `${data.queriesReport?.start} – ${data.queriesReport?.end}`]);
  } else if (view === 'declining') {
    lines.push(['page', 'clicks', 'previous_clicks', 'change_percent', 'impressions', 'previous_impressions', 'compared_with', 'article_task_id']);
    for (const d of data.declining) lines.push([d.url, d.clicks, d.prevClicks, d.changePct, d.impressions, d.prevImpressions, d.basis, d.taskId]);
  } else {
    lines.push(['article_task_id', 'title', 'url', 'published_at', 'detail']);
    for (const z of data.zero) lines.push([z.taskId, z.title, z.url, z.publishedAt?.toISOString() ?? '', z.detail]);
  }
  return lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
