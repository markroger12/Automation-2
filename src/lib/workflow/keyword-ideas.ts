import { db } from '../db';
import { normalizeKeyword } from '../domain';
import { AppError } from '../errors';

/**
 * Keyword ideas for the workflow queue (owner request). Verified sources only, nothing invented:
 * - Search Console: queries people searched that showed this website (impressions in the latest data), for which the
 *   website has no keyword or article yet;
 * - Google searches through the licensed Serper API (never scraped): “related searches” and “People also ask” for a
 *   seed the owner types. Each search is one Serper request, made only on the owner's click.
 * Ideas already in the queue or written are marked, not offered again.
 */

export interface KeywordIdea {
  keyword: string;
  source: 'search-console' | 'related' | 'people-also-ask';
  /** Search Console numbers for the period of the data. */
  impressions?: number;
  clicks?: number;
  position?: number | null;
  /** The website has this keyword already (queue or article). */
  covered: boolean;
}

/** Everything the website has already: workflow keywords (any state) and article keywords. */
async function coveredKeywords(websiteId: string): Promise<Set<string>> {
  const [queued, articles] = await Promise.all([
    db.workflowKeyword.findMany({ where: { workflow: { websiteId } }, select: { normalizedKeyword: true } }),
    db.articleTask.findMany({ where: { websiteId }, select: { keyword: true } }),
  ]);
  return new Set([...queued.map((k) => k.normalizedKeyword), ...articles.map((a) => normalizeKeyword(a.keyword))]);
}

/** Search Console queries with impressions that the website has no keyword or article for, most impressions first. */
export async function searchConsoleIdeas(websiteId: string, limit = 100): Promise<{ ideas: KeywordIdea[]; data: { source: string; startDate: string; endDate: string } | null }> {
  const snapshot = await db.searchPerformanceSnapshot.findFirst({ where: { websiteId, queryRows: { gt: 0 } }, orderBy: [{ endDate: 'desc' }, { importedAt: 'desc' }] });
  if (!snapshot) return { ideas: [], data: null };
  const [rows, covered] = await Promise.all([
    db.searchPerformanceRow.findMany({ where: { snapshotId: snapshot.id, dimension: 'QUERY', impressions: { gt: 0 } }, orderBy: [{ impressions: 'desc' }, { clicks: 'desc' }], take: 1000 }),
    coveredKeywords(websiteId),
  ]);
  const ideas: KeywordIdea[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    const n = normalizeKeyword(r.key);
    if (!n || seen.has(n) || covered.has(n)) continue;
    seen.add(n);
    ideas.push({ keyword: r.key.trim(), source: 'search-console', impressions: r.impressions, clicks: r.clicks, position: r.position, covered: false });
    if (ideas.length >= limit) break;
  }
  return { ideas, data: { source: snapshot.source, startDate: snapshot.startDate, endDate: snapshot.endDate } };
}

let endpoint = 'https://google.serper.dev/search';
/** Tests only: point the search at a local fake. */
export function setIdeasEndpointForTests(url: string | null) {
  endpoint = url ?? 'https://google.serper.dev/search';
}

/** What Serper's answer has as related searches and “People also ask” (pure). */
export function serperIdeas(data: unknown, covered: Set<string>): KeywordIdea[] {
  const d = (data ?? {}) as { relatedSearches?: { query?: unknown }[]; peopleAlsoAsk?: { question?: unknown }[] };
  const out: KeywordIdea[] = [];
  const seen = new Set<string>();
  const add = (text: unknown, source: KeywordIdea['source']) => {
    if (typeof text !== 'string') return;
    const keyword = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    const n = normalizeKeyword(keyword);
    if (!n || seen.has(n)) return;
    seen.add(n);
    out.push({ keyword, source, covered: covered.has(n) });
  };
  for (const r of d.relatedSearches ?? []) add(r.query, 'related');
  for (const q of d.peopleAlsoAsk ?? []) add(q.question, 'people-also-ask');
  return out;
}

/** One Google search through Serper for the seed, in the website's language. */
export async function googleIdeas(websiteId: string, seed: string): Promise<KeywordIdea[]> {
  const q = seed.replace(/\s+/g, ' ').trim();
  if (q.length < 2 || q.length > 200) throw new AppError(400, 'BAD_SEED', 'Type a keyword of 2 to 200 characters.');
  const key = process.env.SERPER_API_KEY?.trim();
  if (!key) throw new AppError(409, 'NO_SERPER_KEY', 'Google suggestions need a Serper key: add SERPER_API_KEY=… to the .env file (serper.dev), then restart the app.');
  const site = await db.website.findUniqueOrThrow({ where: { id: websiteId }, select: { language: true } });
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, hl: site.language || 'en', num: 10 }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  }).catch((e: Error) => {
    throw new AppError(502, 'SERPER_UNREACHABLE', `Serper did not answer (${e.name === 'TimeoutError' ? 'timeout' : 'network error'}).`);
  });
  if (res.status === 401 || res.status === 403) throw new AppError(502, 'SERPER_KEY', 'Serper refused the key in .env (SERPER_API_KEY).');
  if (res.status === 429) throw new AppError(429, 'SERPER_LIMIT', 'Serper says the credits or rate limit are used up; try again later.');
  if (!res.ok) throw new AppError(502, 'SERPER_HTTP', `Serper answered HTTP ${res.status}.`);
  return serperIdeas(await res.json().catch(() => ({})), await coveredKeywords(websiteId));
}
