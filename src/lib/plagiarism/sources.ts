import { load } from 'cheerio';
import { db } from '../db';
import { safeFetch, LinkFetchError } from '../links/net';
import { buildTextModel, htmlSegments, type TextModel } from './text';

/**
 * Where the Plagiarism Evidence Checker looks (spec §15): the owner's saved
 * articles, pages linked from the article, URLs the owner adds, Wikipedia
 * extracts and, only when a key is configured, a licensed search API
 * (Serper). Search-engine result pages are never scraped. Every page fetch
 * goes through the SSRF-safe fetcher (public addresses only, re-checked on
 * each redirect, size and time caps, no cookies or credentials).
 */

export type SourceKind = 'OWNER_ARTICLE' | 'LINKED_PAGE' | 'USER_URL' | 'WIKIPEDIA' | 'SEARCH_RESULT';

export interface SourceDoc {
  kind: SourceKind;
  title: string;
  url: string | null;
  taskId: string | null;
  model: TextModel;
  /** Search query (passage) that found this page. */
  query?: string;
}

export const LIMITS = { linkedPages: 10, userUrls: 10, ownerArticles: 500, searchQueries: 5, searchResults: 8, wikipediaPages: 3, pageBytes: 3_000_000, timeoutMs: 20_000 };

const PAGE_HEADERS = { accept: 'text/html,application/xhtml+xml,text/plain;q=0.8', userAgent: 'BlogAutomationStudio/3.0 (plagiarism evidence check; local tool)' };

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};

export class SourceError extends Error {}

/** Fetch one public page and turn it into a text model (HTML or plain text only). */
export async function fetchPageDoc(url: string, kind: SourceKind, query?: string): Promise<SourceDoc> {
  let page;
  try {
    page = await safeFetch(url, { timeoutMs: LIMITS.timeoutMs, maxBytes: LIMITS.pageBytes, ...PAGE_HEADERS });
  } catch (error) {
    throw new SourceError(error instanceof LinkFetchError ? error.message : `could not fetch (${(error as Error).message})`);
  }
  if (page.status >= 400) throw new SourceError(`HTTP ${page.status}`);
  const type = page.contentType.toLowerCase();
  if (!/html|text\/plain/.test(type)) throw new SourceError(`not an HTML page (${type || 'unknown type'})`);
  const isHtml = /html/.test(type);
  const title = isHtml ? load(page.body)('title').first().text().replace(/\s+/g, ' ').trim() : '';
  const model = buildTextModel(isHtml ? htmlSegments(page.body, { page: true }) : page.body.split(/\n\s*\n/).map((t) => ({ text: t.replace(/\s+/g, ' ').trim(), quote: false })).filter((s) => s.text));
  if (model.tokens.length < 20) throw new SourceError('almost no readable text (the page may need JavaScript or a login)');
  return { kind, title: title || page.finalUrl, url: page.finalUrl, taskId: null, model, query };
}

/** External links of the article (not the website's own pages), first `limit`, de-duplicated. */
export function linkedUrls(html: string, ownHosts: string[], limit = LIMITS.linkedPages): string[] {
  const $ = load(html);
  const out: string[] = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    if (!/^https?:\/\//i.test(href)) return;
    const h = hostOf(href);
    if (!h || ownHosts.includes(h)) return;
    const clean = href.replace(/#.*$/, '');
    if (!out.includes(clean) && out.length < limit) out.push(clean);
  });
  return out;
}

const articleHtml = (t: { editedHtml: string | null; assembledHtml: string | null; bodyHtml: string | null }) => t.editedHtml ?? t.assembledHtml ?? t.bodyHtml ?? '';

/** The owner's saved articles (all websites), newest first, excluding the one being checked. */
export async function ownerArticleDocs(exceptTaskId: string | null): Promise<{ docs: SourceDoc[]; total: number; websiteOf: Map<string, string> }> {
  const rows = await db.articleTask.findMany({
    where: { id: exceptTaskId ? { not: exceptTaskId } : undefined, OR: [{ editedHtml: { not: null } }, { assembledHtml: { not: null } }, { bodyHtml: { not: null } }] },
    orderBy: { createdAt: 'desc' },
    take: LIMITS.ownerArticles,
    select: { id: true, keyword: true, selectedTitle: true, websiteId: true, editedHtml: true, assembledHtml: true, bodyHtml: true, website: { select: { name: true } } },
  });
  const websiteOf = new Map<string, string>();
  const docs = rows.map((r) => {
    websiteOf.set(r.id, r.websiteId);
    return { kind: 'OWNER_ARTICLE' as const, title: `${r.selectedTitle ?? r.keyword} (${r.website.name})`, url: null, taskId: r.id, model: buildTextModel(htmlSegments(articleHtml(r))) };
  });
  return { docs, total: rows.length, websiteOf };
}

// ------------------------------------------------------------- Wikipedia

let wikipediaBase: ((lang: string) => string) | null = null;
/** Tests only: point the Wikipedia API at a local fake. */
export function setWikipediaApiBaseForTests(fn: ((lang: string) => string) | null) {
  wikipediaBase = fn;
}
const wikiApi = (lang: string) => (wikipediaBase ? wikipediaBase(lang) : `https://${lang}.wikipedia.org/w/api.php`);

/** Plain-text extracts of the top Wikipedia articles for the topic (MediaWiki API, not page scraping). */
export async function wikipediaDocs(topic: string, language: string): Promise<SourceDoc[]> {
  const lang = /^[a-z]{2,3}$/.test(language) ? language : 'en';
  const search = new URL(wikiApi(lang));
  search.search = new URLSearchParams({ action: 'query', list: 'search', srsearch: topic, srlimit: String(LIMITS.wikipediaPages), format: 'json', formatversion: '2' }).toString();
  const res = await safeFetch(search.toString(), { timeoutMs: LIMITS.timeoutMs, maxBytes: 500_000, accept: 'application/json', userAgent: PAGE_HEADERS.userAgent });
  if (res.status >= 400) throw new SourceError(`Wikipedia search HTTP ${res.status}`);
  const hits = ((JSON.parse(res.body) as { query?: { search?: { pageid: number; title: string }[] } }).query?.search ?? []).slice(0, LIMITS.wikipediaPages);
  const docs: SourceDoc[] = [];
  for (const hit of hits) {
    const q = new URL(wikiApi(lang));
    q.search = new URLSearchParams({ action: 'query', prop: 'extracts', explaintext: '1', pageids: String(hit.pageid), format: 'json', formatversion: '2' }).toString();
    const r = await safeFetch(q.toString(), { timeoutMs: LIMITS.timeoutMs, maxBytes: 2_000_000, accept: 'application/json', userAgent: PAGE_HEADERS.userAgent });
    if (r.status >= 400) continue;
    const extract = (JSON.parse(r.body) as { query?: { pages?: { extract?: string }[] } }).query?.pages?.[0]?.extract ?? '';
    const segments = extract
      .split(/\n+/)
      .map((t) => t.replace(/\s+/g, ' ').trim())
      .filter((t) => t && !/^=+.*=+$/.test(t))
      .map((text) => ({ text, quote: false }));
    const model = buildTextModel(segments);
    if (model.tokens.length < 20) continue;
    docs.push({ kind: 'WIKIPEDIA', title: `Wikipedia (${lang}): ${hit.title}`, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`, taskId: null, model });
  }
  return docs;
}

// ------------------------------------------------------------- Search service (Serper, optional)

let searchEndpoint = 'https://google.serper.dev/search';
/** Tests only: point the search service at a local fake. */
export function setSearchEndpointForTests(url: string | null) {
  searchEndpoint = url ?? 'https://google.serper.dev/search';
}

export const searchConfigured = () => Boolean(process.env.SERPER_API_KEY?.trim());

/**
 * Exact-phrase queries through the licensed Serper API (key from .env, sent
 * only to the API in a header, never logged). Returns result URLs per query.
 */
export async function searchPassage(query: string, language: string): Promise<{ link: string; title: string }[]> {
  const key = process.env.SERPER_API_KEY?.trim();
  if (!key) throw new SourceError('no search key configured');
  const res = await fetch(searchEndpoint, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: `"${query.replace(/"/g, '')}"`, hl: language, num: 10 }),
    signal: AbortSignal.timeout(LIMITS.timeoutMs),
    redirect: 'error',
  }).catch((error: Error) => {
    throw new SourceError(`search service unreachable (${error.name === 'TimeoutError' ? 'timeout' : 'network error'})`);
  });
  if (res.status === 401 || res.status === 403) throw new SourceError('the search service rejected the key');
  if (res.status === 429) throw new SourceError('search service quota or rate limit reached');
  if (!res.ok) throw new SourceError(`search service HTTP ${res.status}`);
  const data = (await res.json().catch(() => ({}))) as { organic?: { link?: string; title?: string }[] };
  return (data.organic ?? []).filter((o): o is { link: string; title: string } => typeof o.link === 'string' && /^https?:\/\//.test(o.link)).map((o) => ({ link: o.link, title: o.title ?? o.link }));
}
