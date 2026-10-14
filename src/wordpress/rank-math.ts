/**
 * Rank Math adapter: field names, score/recommendation parsing and the
 * in-editor read script. All Rank Math specifics live here (selectors are in
 * selectors.ts and can be overridden in Settings → Advanced).
 *
 * Fields are written through Rank Math's own REST endpoint
 * (rankmath/v1/updateMeta, the one its editor sidebar uses) and then read back
 * from the editor. The score is only ever READ from the Rank Math panel —
 * never computed or guessed here.
 */

export const RANK_MATH_META = {
  focusKeyword: 'rank_math_focus_keyword',
  title: 'rank_math_title',
  description: 'rank_math_description',
} as const;

export interface RankMathFields {
  focusKeyword: string | null;
  title: string | null;
  description: string | null;
}

export interface RankMathRecommendation {
  text: string;
  state: 'fail' | 'warning' | 'ok' | 'unknown';
}

export interface RankMathReading {
  present: boolean;
  fields: RankMathFields;
  fieldsVia: string | null;
  score: number | null;
  scoreText: string | null;
  scoreVia: string | null;
  recommendations: RankMathRecommendation[];
}

/** "82 / 100", "82/100", "SEO: 82", "82" → 82. Anything else → null (never guessed). */
export function parseRankMathScore(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  const m = /(?:^|[^\d])(\d{1,3})\s*(?:\/\s*100)?\s*$/.exec(t) ?? /(?:^|[^\d])(\d{1,3})\s*\/\s*100/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
}

const norm = (s: string) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Does the keyword shown by Rank Math equal the expected focus keyword? Rank
 * Math shows the keyword's score beside it, so "tom kaulitz 82" or
 * "tom kaulitz82/100" must count as the keyword "tom kaulitz" — but a keyword
 * that itself ends in a number ("iphone 15") stays intact.
 */
export function focusKeywordMatches(expected: string, shown: string | null | undefined): boolean {
  if (!shown) return false;
  const e = norm(expected);
  // Rank Math stores several focus keywords comma-separated; the first is the primary one.
  const first = norm(shown.split(',')[0] ?? '');
  if (first === e) return true;
  if (!first.startsWith(e)) return false;
  const rest = first.slice(e.length).trim();
  return /^\d{1,3}(?:\s*\/\s*100)?$/.test(rest) && Number(rest.split('/')[0]) <= 100;
}

export function fieldsMatch(expected: { focusKeyword: string; title: string; description: string }, actual: RankMathFields): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!focusKeywordMatches(expected.focusKeyword, actual.focusKeyword)) problems.push(`focus keyword reads “${actual.focusKeyword ?? '(empty)'}”, expected “${expected.focusKeyword}”`);
  if (norm(actual.title ?? '') !== norm(expected.title)) problems.push(`SEO title reads “${actual.title ?? '(empty)'}”`);
  if (norm(actual.description ?? '') !== norm(expected.description)) problems.push(`meta description reads “${(actual.description ?? '(empty)').slice(0, 80)}”`);
  return { ok: problems.length === 0, problems };
}

/**
 * In-page script (kept as a string so no build tool injects helpers into it).
 * Reads fields from Rank Math's data store when available, then from its form
 * inputs; reads the score from the configured DOM selectors.
 */
export function rankMathReadScript(selectors: { score: string[]; recommendations: string[] }): string {
  return `(() => {
  const out = { present: false, fields: { focusKeyword: null, title: null, description: null }, fieldsVia: null, scoreText: null, scoreVia: null, storeScore: null, recommendations: [] };
  const w = window;
  out.present = Boolean(w.rankMath || w.rankMathEditor || document.querySelector('[class*="rank-math"], [id*="rank-math"], [name^="rank_math_"]'));
  try {
    const store = w.wp && w.wp.data && w.wp.data.select ? w.wp.data.select('rank-math') : null;
    if (store) {
      const pick = (names) => { for (const n of names) { if (typeof store[n] === 'function') { try { const v = store[n](); if (v !== undefined && v !== null) return v; } catch (e) {} } } return null; };
      const kw = pick(['getKeywords', 'getFocusKeyword']);
      const title = pick(['getSerpTitle', 'getTitle']);
      const desc = pick(['getSerpDescription', 'getDescription']);
      const score = pick(['getSEOScore', 'getSeoScore', 'getScore']);
      if (kw !== null || title !== null || desc !== null) {
        out.fields = { focusKeyword: kw === null ? null : String(kw), title: title === null ? null : String(title), description: desc === null ? null : String(desc) };
        out.fieldsVia = 'store';
      }
      if (typeof score === 'number') out.storeScore = score;
    }
  } catch (e) {}
  if (!out.fieldsVia) {
    const val = (name) => { const el = document.querySelector('[name="' + name + '"]'); return el ? (el.value !== undefined ? String(el.value) : el.textContent) : null; };
    const kw = val('rank_math_focus_keyword'), title = val('rank_math_title'), desc = val('rank_math_description');
    if (kw !== null || title !== null || desc !== null) { out.fields = { focusKeyword: kw, title, description: desc }; out.fieldsVia = 'inputs'; }
  }
  for (const sel of ${JSON.stringify(selectors.score)}) {
    let el = null;
    try { el = document.querySelector(sel); } catch (e) {}
    if (el && (el.textContent || '').trim()) { out.scoreText = (el.textContent || '').replace(/\\s+/g, ' ').trim(); out.scoreVia = sel; break; }
  }
  const seen = new Set();
  for (const sel of ${JSON.stringify(selectors.recommendations)}) {
    let items = [];
    try { items = Array.from(document.querySelectorAll(sel)); } catch (e) {}
    for (const li of items) {
      const text = (li.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const cls = ((li.className && li.className.baseVal !== undefined ? li.className.baseVal : li.className) || '') + ' ' + (li.getAttribute('data-status') || '');
      const state = /fail|error|bad|cross/i.test(cls) ? 'fail' : /warn|ok-ish|improve/i.test(cls) ? 'warning' : /ok|pass|good|check/i.test(cls) ? 'ok' : 'unknown';
      out.recommendations.push({ text: text.slice(0, 300), state });
    }
  }
  return out;
})()`;
}

/** Recommendation texts (EN/DE) that local metadata fixes can address, without touching content. */
export type LocalFixId = 'title-keyword' | 'title-start' | 'meta-keyword' | 'slug-keyword';
export const LOCAL_FIXABLE: { id: LocalFixId; re: RegExp }[] = [
  { id: 'title-start', re: /(focus keyword|fokus-?keyword)[^.]*(beginning|start|anfang)[^.]*(seo title|seo-titel|titel|title)/i },
  { id: 'title-keyword', re: /(focus keyword|fokus-?keyword)[^.]*(seo title|seo-titel)/i },
  { id: 'meta-keyword', re: /(focus keyword|fokus-?keyword)[^.]*(meta description|meta-beschreibung)/i },
  { id: 'slug-keyword', re: /(focus keyword|fokus-?keyword)[^.]*(url|permalink|slug)/i },
];
