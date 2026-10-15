import { load } from 'cheerio';

/**
 * Content refresh signals (upgrade 11), pure helpers. A refresh candidate is
 * only created on evidence that something in the article is out of date
 * (an edition year in the title or headings, an explicit “as of <year>”, a
 * dead link, a changed fact, falling search traffic). Age alone only raises
 * the priority of a candidate; it never creates one, so a current evergreen
 * article is left alone.
 */

export type RefreshReasonCode = 'OUTDATED_YEAR' | 'BROKEN_LINK' | 'FACTS_CHANGED' | 'DECLINING_TRAFFIC' | 'ZERO_IMPRESSIONS' | 'AGE';

export interface RefreshReason {
  code: RefreshReasonCode;
  detail: string;
  /** Where it was found: an excerpt, a URL, numbers from the imported report. */
  evidence: string;
}

export const REASON_WEIGHT: Record<RefreshReasonCode, number> = {
  OUTDATED_YEAR: 30,
  BROKEN_LINK: 20,
  FACTS_CHANGED: 30,
  DECLINING_TRAFFIC: 25,
  ZERO_IMPRESSIONS: 15,
  AGE: 10,
};

export const REASON_LABEL: Record<RefreshReasonCode, string> = {
  OUTDATED_YEAR: 'Outdated year',
  BROKEN_LINK: 'Dead link',
  FACTS_CHANGED: 'Facts changed',
  DECLINING_TRAFFIC: 'Falling search traffic',
  ZERO_IMPRESSIONS: 'No search impressions',
  AGE: 'Age',
};

const FRESHNESS = /\b(as of|updated(?: in)?|last updated|current as of|stand(?::)?|aktualisiert(?: am| im)?|zuletzt aktualisiert)\s+(?:[a-zäöüß]+\.?\s+)?(?:\d{1,2}\.?\s+)?(?:[a-zäöüß]+\s+)?((?:19|20)\d{2})\b/i;

function excerpt(text: string, at: number, len = 140): string {
  const start = Math.max(0, at - 50);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + len).trim()}${start + len < text.length ? '…' : ''}`;
}

/**
 * Edition years that have passed: a year in the title or a heading (“Best
 * phones 2024”, “Net worth 2025”) or an explicit freshness marker in the
 * text (“as of 2024”, “Stand: März 2024”). Years in ordinary sentences
 * (“born in 1989”, “married in 2019”) are facts and never count.
 */
export function outdatedYears(html: string, title: string, now = new Date()): RefreshReason[] {
  const current = now.getUTCFullYear();
  const reasons: RefreshReason[] = [];
  const seen = new Set<string>();
  const add = (year: number, where: string, ex: string) => {
    const key = `${where}:${year}`;
    if (seen.has(key)) return;
    seen.add(key);
    reasons.push({ code: 'OUTDATED_YEAR', detail: `${where} names ${year}; it is now ${current}.`, evidence: ex });
  };
  const edition = (text: string, where: string) => {
    for (const m of text.matchAll(/\b((?:19|20)\d{2})\b/g)) {
      const y = Number(m[1]);
      // An edition year is recent (at most 10 years back) and already over.
      if (y < current && y >= current - 10) add(y, where, text.trim().slice(0, 160));
    }
  };
  edition(title, 'The title');
  const $ = load(`<body>${html}</body>`);
  $('h1, h2, h3').each((_, el) => edition($(el).text(), `The heading “${$(el).text().trim().slice(0, 80)}”`));
  const text = $('body').text().replace(/\s+/g, ' ');
  for (const m of text.matchAll(new RegExp(FRESHNESS.source, 'gi'))) {
    const y = Number(m[2]);
    if (y < current) add(y, `“${m[0].trim()}”`, excerpt(text, m.index ?? 0));
  }
  return reasons;
}

/** External links of the article (absolute http(s), not the site itself), first occurrence only. */
export function externalLinks(html: string, siteHost: string): { url: string; text: string }[] {
  const $ = load(`<body>${html}</body>`);
  const host = siteHost.replace(/^www\./, '').toLowerCase();
  const out: { url: string; text: string }[] = [];
  const seen = new Set<string>();
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') ?? '').trim();
    try {
      const u = new URL(href);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      if (u.hostname.replace(/^www\./, '').toLowerCase() === host) return;
      if (seen.has(u.toString())) return;
      seen.add(u.toString());
      out.push({ url: u.toString(), text: $(el).text().trim().slice(0, 120) });
    } catch {
      /* relative or invalid: not an external link */
    }
  });
  return out;
}

/** Automatic, conservative fix: a dead link is removed and its words are kept. */
export function unlinkUrls(html: string, urls: string[]): { html: string; removed: { url: string; text: string }[] } {
  if (!urls.length) return { html, removed: [] };
  const $ = load(`<body>${html}</body>`);
  const wanted = new Set(urls);
  const removed: { url: string; text: string }[] = [];
  $('a[href]').each((_, el) => {
    const a = $(el);
    let href = '';
    try {
      href = new URL((a.attr('href') ?? '').trim()).toString();
    } catch {
      return;
    }
    if (!wanted.has(href)) return;
    removed.push({ url: href, text: a.text().trim() });
    a.replaceWith(a.html() ?? '');
  });
  return { html: $('body').html() ?? html, removed };
}

export function priorityOf(reasons: RefreshReason[]): number {
  const byCode = new Map<RefreshReasonCode, number>();
  for (const r of reasons) byCode.set(r.code, (byCode.get(r.code) ?? 0) + 1);
  let score = 0;
  for (const [code, n] of byCode) score += REASON_WEIGHT[code] * (code === 'BROKEN_LINK' ? Math.min(n, 3) : 1);
  return Math.min(100, score);
}

/** A candidate needs evidence; age alone is not a reason to rewrite an article. */
export function needsRefresh(reasons: RefreshReason[]): boolean {
  return reasons.some((r) => r.code !== 'AGE');
}
