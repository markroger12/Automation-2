/**
 * Language-aware text utilities shared by parsers, assembly, SEO checks, the
 * quality gate and the humanizer. Pure functions (no I/O).
 */

export function stripTags(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|tr|div|figure|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

export function words(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

export function wordCount(text: string): number {
  return words(text).length;
}

export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Exact (case-insensitive, word-boundary) keyword occurrences. */
export function countExact(text: string, keyword: string): number {
  const k = keyword.trim();
  if (!k) return 0;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(k)}(?![\\p{L}\\p{N}])`, 'giu');
  return (text.match(re) ?? []).length;
}

/**
 * Normalized occurrences: tolerant of punctuation/case and simple German/English
 * inflection (possessive -s / 's, plural -s/-es/-n/-en on the last word).
 */
export function countNormalized(text: string, keyword: string): number {
  const kw = normalizeText(keyword).split(' ').filter(Boolean);
  if (!kw.length) return 0;
  const tokens = normalizeText(text).split(' ');
  let count = 0;
  for (let i = 0; i + kw.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < kw.length; j++) {
      const t = tokens[i + j].replace(/'s$/, '').replace(/'$/, '');
      const w = kw[j];
      const last = j === kw.length - 1;
      if (!(t === w || (last && (t === `${w}s` || t === `${w}es` || t === `${w}n` || t === `${w}en`)))) {
        ok = false;
        break;
      }
    }
    if (ok) count++;
  }
  return count;
}

export function sentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+(?=[\p{Lu}"„“(])/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Very small language heuristic (English vs German) based on stop words. */
export function detectLanguage(text: string): { language: 'en' | 'de' | 'unknown'; confidence: number } {
  const tokens = words(text.toLowerCase()).slice(0, 2000);
  if (tokens.length < 20) return { language: 'unknown', confidence: 0 };
  const de = new Set(['der', 'die', 'das', 'und', 'ist', 'nicht', 'mit', 'ein', 'eine', 'auch', 'auf', 'für', 'sich', 'dem', 'den', 'von', 'zu', 'wurde', 'sind', 'ihre', 'seine', 'nach', 'bei', 'als', 'wie', 'über']);
  const en = new Set(['the', 'and', 'is', 'not', 'with', 'a', 'an', 'also', 'on', 'for', 'his', 'her', 'of', 'to', 'was', 'are', 'their', 'after', 'at', 'as', 'how', 'about', 'which', 'has', 'have', 'that']);
  let d = 0;
  let e = 0;
  for (const t of tokens) {
    if (de.has(t)) d++;
    if (en.has(t)) e++;
  }
  const total = d + e;
  if (total < 10) return { language: 'unknown', confidence: 0 };
  return d > e ? { language: 'de', confidence: d / total } : { language: 'en', confidence: e / total };
}

/** WordPress-like slug; German umlauts transliterated (ä→ae, ö→oe, ü→ue, ß→ss). */
export function makeSlug(text: string, language: string, maxWords = 8): string {
  let s = text.trim().toLowerCase();
  if (language === 'de') s = s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  s = s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.split('-').filter(Boolean).slice(0, maxWords).join('-').slice(0, 80);
}

export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : cut.slice(0, max)).replace(/[,;:\s]+$/, '');
}

/** Parse secondary keywords from multiline / comma-separated input: ordered, de-duplicated, intent preserved. */
export function parseSecondaryKeywords(input: string | string[] | null | undefined): string[] {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\n,;]+/);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const value = String(item).replace(/\s+/g, ' ').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
