/**
 * Owner request (2026-11-04): whether a published article is on Google is checked with a Google search through the
 * licensed search API (Serper, `SERPER_API_KEY` in .env), not with Search Console. Google itself is never scraped.
 *
 * The search is `site:` + the post's address; the article counts as indexed only when Google's results contain that
 * exact address (http/https, “www.”, a trailing slash, the query and the fragment do not count as a difference).
 */
let endpoint = 'https://google.serper.dev/search';
/** Tests only: point the search at a local fake. */
export function setIndexCheckEndpointForTests(url: string | null) {
  endpoint = url ?? 'https://google.serper.dev/search';
}

export const indexCheckConfigured = () => Boolean(process.env.SERPER_API_KEY?.trim());

export class IndexCheckError extends Error {
  constructor(
    message: string,
    /** KEY: no key or the key was refused; LIMIT: credits or rate limit; NETWORK; HTTP. */
    readonly code: 'KEY' | 'LIMIT' | 'NETWORK' | 'HTTP',
  ) {
    super(message);
  }
}

/** The address as compared: host without “www.”, path without a trailing slash; no scheme, query or fragment. */
export function comparableUrl(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = decodeURI(u.pathname).replace(/\/+$/, '').toLowerCase();
    return `${host}${path}`;
  } catch {
    return null;
  }
}

/** Is the URL among the organic results of Serper's answer? (pure) */
export function urlInResults(url: string, data: unknown): { found: boolean; results: number } {
  const want = comparableUrl(url);
  const organic = ((data ?? {}) as { organic?: { link?: unknown }[] }).organic ?? [];
  const links = organic.map((r) => (typeof r.link === 'string' ? comparableUrl(r.link) : null));
  return { found: Boolean(want) && links.includes(want), results: organic.length };
}

/** One Google search (`site:` + the address) through Serper. */
export async function googleIndexCheck(url: string, language: string): Promise<{ found: boolean; results: number; query: string }> {
  const key = process.env.SERPER_API_KEY?.trim();
  if (!key) throw new IndexCheckError('No Serper key: add SERPER_API_KEY=… to the .env file (serper.dev), then restart the app.', 'KEY');
  const u = new URL(url);
  const query = `site:${u.hostname}${u.pathname}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q: query, hl: language === 'de' ? 'de' : 'en', num: 10 }),
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  }).catch((e: Error) => {
    throw new IndexCheckError(`the search API did not answer (${e.name === 'TimeoutError' ? 'timeout' : 'network error'})`, 'NETWORK');
  });
  if (res.status === 401 || res.status === 403) throw new IndexCheckError('Serper refused the key in .env (SERPER_API_KEY)', 'KEY');
  if (res.status === 429) throw new IndexCheckError('Serper says the credits or the rate limit are used up', 'LIMIT');
  if (!res.ok) throw new IndexCheckError(`the search API answered HTTP ${res.status}`, 'HTTP');
  const r = urlInResults(url, await res.json().catch(() => ({})));
  return { ...r, query };
}
