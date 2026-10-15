import Papa from 'papaparse';

/**
 * Parser for Search Console performance exports (Performance → Export →
 * “Download CSV”: a zip with Queries.csv, Pages.csv, Dates.csv, Filters.csv,
 * … or the CSV files themselves). English and German export headers. Compare
 * exports (“Last 28 days … / Previous 28 days …”) keep both periods. Nothing
 * is estimated: a row is read exactly as Search Console wrote it.
 */

export type GscDimension = 'PAGE' | 'QUERY' | 'DATE';

export interface GscMetrics {
  clicks: number;
  impressions: number;
  /** Percent as exported (3.4 = 3.4 %). */
  ctr: number | null;
  position: number | null;
}

export interface GscRow {
  key: string;
  current: GscMetrics;
  previous: GscMetrics | null;
}

export interface GscFileInfo {
  name: string;
  kind: GscDimension | 'FILTERS' | 'IGNORED';
  rows: number;
  skipped: number;
  compare: boolean;
}

export interface GscExport {
  pages: GscRow[];
  queries: GscRow[];
  dates: GscRow[];
  filters: Record<string, string>;
  compare: boolean;
  files: GscFileInfo[];
  /** First and last day of Dates.csv (Search Console days, Pacific Time). */
  start: string | null;
  end: string | null;
  searchType: string | null;
  warnings: string[];
}

const FIRST_COLUMN: Record<string, GscDimension | 'FILTERS'> = {
  'top pages': 'PAGE',
  pages: 'PAGE',
  page: 'PAGE',
  'häufigste seiten': 'PAGE',
  'top-seiten': 'PAGE',
  seiten: 'PAGE',
  seite: 'PAGE',
  'top queries': 'QUERY',
  queries: 'QUERY',
  query: 'QUERY',
  'häufigste suchanfragen': 'QUERY',
  'top-suchanfragen': 'QUERY',
  suchanfragen: 'QUERY',
  suchanfrage: 'QUERY',
  date: 'DATE',
  datum: 'DATE',
  filter: 'FILTERS',
};

type Metric = keyof GscMetrics;

function metricOf(header: string): Metric | null {
  const h = header.toLowerCase();
  if (/\b(clicks|klicks)\b/.test(h)) return 'clicks';
  if (/\b(impressions|impressionen)\b/.test(h)) return 'impressions';
  if (/\bctr\b/.test(h)) return 'ctr';
  if (/\bposition\b/.test(h)) return 'position';
  return null;
}

/** Whole numbers: any separator is a thousands separator (1,234 / 1.234 / 1 234). */
export function parseCount(raw: string): number | null {
  const s = raw.replace(/[\s  .,']/g, '');
  return /^\d+$/.test(s) ? Number(s) : null;
}

/** Decimals in English or German notation (3.45 / 3,45 / 1,234.5 / 1.234,5), “%” ignored. */
export function parseDecimal(raw: string): number | null {
  let s = raw.replace(/[%\s  ]/g, '');
  if (!s) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lastComma >= 0) s = s.replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null;
}

function isoDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    const de = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
    if (de) m = [s, de[3], de[2].padStart(2, '0'), de[1].padStart(2, '0')] as unknown as RegExpExecArray;
  }
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? null : iso;
}

function pageUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function parseTable(text: string): string[][] {
  const res = Papa.parse<string[]>(text.replace(/^﻿/, ''), { skipEmptyLines: true });
  return res.data.filter((r) => Array.isArray(r) && r.some((c) => String(c).trim() !== ''));
}

export function parseGscExport(files: { name: string; text: string }[]): GscExport {
  const out: GscExport = { pages: [], queries: [], dates: [], filters: {}, compare: false, files: [], start: null, end: null, searchType: null, warnings: [] };
  for (const f of files) {
    const table = parseTable(f.text);
    const header = (table[0] ?? []).map((h) => String(h).trim());
    const kind = FIRST_COLUMN[(header[0] ?? '').toLowerCase()] ?? null;
    if (!kind) {
      out.files.push({ name: f.name, kind: 'IGNORED', rows: Math.max(0, table.length - 1), skipped: 0, compare: false });
      continue;
    }
    if (kind === 'FILTERS') {
      for (const r of table.slice(1)) if (r[0]) out.filters[String(r[0]).trim().toLowerCase()] = String(r[1] ?? '').trim();
      out.files.push({ name: f.name, kind, rows: table.length - 1, skipped: 0, compare: false });
      continue;
    }
    // First occurrence of a metric = the report period; a second one = the comparison period.
    const columns: { index: number; metric: Metric; previous: boolean }[] = [];
    header.forEach((h, i) => {
      if (i === 0) return;
      const metric = metricOf(h);
      if (!metric) return;
      columns.push({ index: i, metric, previous: columns.some((c) => c.metric === metric) });
    });
    const compare = columns.some((c) => c.previous);
    if (!columns.some((c) => c.metric === 'clicks' && !c.previous) || !columns.some((c) => c.metric === 'impressions' && !c.previous)) {
      out.warnings.push(`${f.name}: no Clicks/Impressions columns; the file was not used.`);
      out.files.push({ name: f.name, kind: 'IGNORED', rows: table.length - 1, skipped: table.length - 1, compare });
      continue;
    }
    const rows: GscRow[] = [];
    let skipped = 0;
    for (const r of table.slice(1)) {
      const rawKey = String(r[0] ?? '').trim();
      const key = kind === 'DATE' ? isoDate(rawKey) : kind === 'PAGE' ? pageUrl(rawKey) : rawKey || null;
      const cur: Partial<Record<Metric, number | null>> = {};
      const prev: Partial<Record<Metric, number | null>> = {};
      for (const c of columns) {
        const cell = String(r[c.index] ?? '');
        const v = c.metric === 'clicks' || c.metric === 'impressions' ? parseCount(cell) : parseDecimal(cell);
        (c.previous ? prev : cur)[c.metric] = v;
      }
      if (!key || cur.clicks == null || cur.impressions == null) {
        skipped++;
        continue;
      }
      rows.push({
        key,
        current: { clicks: cur.clicks, impressions: cur.impressions, ctr: cur.ctr ?? null, position: cur.position ?? null },
        previous: compare && prev.clicks != null && prev.impressions != null ? { clicks: prev.clicks, impressions: prev.impressions, ctr: prev.ctr ?? null, position: prev.position ?? null } : null,
      });
    }
    if (skipped) out.warnings.push(`${f.name}: ${skipped} row(s) could not be read and were skipped.`);
    if (kind === 'PAGE') out.pages.push(...rows);
    else if (kind === 'QUERY') out.queries.push(...rows);
    else out.dates.push(...rows);
    out.compare ||= compare;
    out.files.push({ name: f.name, kind, rows: rows.length, skipped, compare });
  }
  if (out.dates.length) {
    const days = out.dates.map((d) => d.key).sort();
    out.start = days[0];
    out.end = days[days.length - 1];
  }
  out.searchType = out.filters['search type'] ?? out.filters['suchtyp'] ?? out.filters['art der suche'] ?? null;
  return out;
}

/** Does a page URL belong to the Search Console property (domain or URL-prefix)? */
export function pageInProperty(url: string, property: string): boolean {
  try {
    const u = new URL(url);
    if (property.startsWith('sc-domain:')) {
      const host = property.slice('sc-domain:'.length);
      const h = u.hostname.toLowerCase();
      return h === host || h.endsWith(`.${host}`);
    }
    return url.toLowerCase().startsWith(property.toLowerCase());
  } catch {
    return false;
  }
}

/** Comparable form of a page URL: host without www, path without trailing slash, no query/hash. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname).replace(/\/+$/, '') || '/';
    return `${u.hostname.toLowerCase().replace(/^www\./, '')}${path.toLowerCase()}`;
  } catch {
    return url.trim().toLowerCase();
  }
}
