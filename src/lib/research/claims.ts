/**
 * Research & Fact Checker (upgrade 03), pure part: find the significant,
 * checkable statements in research notes (dates, family, education,
 * awards, money, career), normalize their values, and compare them with
 * the text of a source page. An AI assertion is never evidence by itself:
 * a claim counts as supported only when a fetched source about the same
 * person contains its value.
 */

export type ClaimType = 'BIRTH' | 'DEATH' | 'FAMILY' | 'EDUCATION' | 'AWARD' | 'NET_WORTH' | 'CAREER';
export type ClaimNature = 'REPORTED_FACT' | 'ESTIMATE' | 'UNVERIFIED_CLAIM';

export interface ExtractedClaim {
  type: ClaimType;
  text: string;
  /** Canonical values that a source must contain: dates (YYYY-MM-DD / YYYY-MM / YYYY), amounts (whole numbers), names. */
  values: { dates: string[]; amounts: number[]; names: string[] };
  nature: ClaimNature;
  highImpact: boolean;
  /** URLs cited on the same line or the line after it. */
  citations: string[];
}

export const HIGH_IMPACT: ClaimType[] = ['BIRTH', 'DEATH', 'FAMILY', 'NET_WORTH'];

const TYPE_PATTERNS: [ClaimType, RegExp][] = [
  ['BIRTH', /\b(born|birth ?date|date of birth|birthday|geboren|geburtsdatum|geburtstag)\b/i],
  ['DEATH', /\b(died|passed away|death|deceased|gestorben|verstorben|starb)\b/i],
  ['NET_WORTH', /\b(net worth|worth|earnings|salary|income|vermögen|einkommen|gage)\b/i],
  ['FAMILY', /\b(married|marriage|relationship|dating|dated|wife|husband|spouse|partner|girlfriend|boyfriend|engaged|divorced|children|child|son|daughter|kids|twin|brother|sister|parents|mother|father|verheiratet|heirat|beziehung|liiert|ehefrau|ehemann|partnerin|freundin|freund|verlobt|geschieden|kinder|kind|sohn|tochter|bruder|schwester|eltern|mutter|vater|zwilling)\b/i],
  ['EDUCATION', /\b(studied|graduated|university|college|degree|school|studierte|studium|universität|hochschule|abschluss|schule)\b/i],
  ['AWARD', /\b(award|awards|won|nominated|grammy|oscar|emmy|golden globe|bafta|echo|bambi|preis|auszeichnung|gewann|nominiert)\b/i],
  ['CAREER', /\b(starred|stars|role|film|movie|series|album|single|debut|band|founded|joined|signed|released|spielte|rolle|serie|veröffentlichte|gründete)\b/i],
];
const ESTIMATE = /\b(estimate[sd]?|approximately|approx\.|about|around|reportedly|roughly|geschätzt|schätzungsweise|angeblich|rund|etwa|circa|ca\.)\b/i;
const UNCERTAIN = /\b(unconfirmed|not (publicly )?confirmed|disputed|rumou?r(ed|s)?|unclear|conflicting|unverified|speculat\w*|allegedly|nicht (öffentlich )?bestätigt|umstritten|unklar|gerücht\w*|spekul\w*|mutmaßlich)\b/i;
const URL_RE = /https?:\/\/[^\s)\]>"'<]+/g;

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  januar: 1, februar: 2, märz: 3, maerz: 3, mai: 5, juni: 6, juli: 7, oktober: 10, dezember: 12,
};
const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const pad = (n: number) => String(n).padStart(2, '0');
const validDay = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1800 && y <= 2100;

/** Every date in a text, canonical (YYYY-MM-DD, YYYY-MM or YYYY), with its position. */
export function findDates(text: string): { value: string; index: number }[] {
  const out: { value: string; index: number }[] = [];
  const taken: [number, number][] = [];
  const add = (value: string, index: number, length: number) => {
    if (taken.some(([a, b]) => index < b && index + length > a)) return;
    taken.push([index, index + length]);
    out.push({ value, index });
  };
  // 1 September 1989 / 1. September 1989 / 1st of September 1989
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(?:of\\s+)?(${MONTH_NAMES})\\.?,?\\s+(\\d{4})\\b`, 'giu'))) {
    const d = Number(m[1]);
    const mo = MONTHS[m[2].toLowerCase()];
    const y = Number(m[3]);
    if (validDay(y, mo, d)) add(`${y}-${pad(mo)}-${pad(d)}`, m.index!, m[0].length);
  }
  // September 1, 1989
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'giu'))) {
    const mo = MONTHS[m[1].toLowerCase()];
    const d = Number(m[2]);
    const y = Number(m[3]);
    if (validDay(y, mo, d)) add(`${y}-${pad(mo)}-${pad(d)}`, m.index!, m[0].length);
  }
  // 1989-09-01
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (validDay(y, mo, d)) add(`${y}-${pad(mo)}-${pad(d)}`, m.index!, m[0].length);
  }
  // 01.09.1989 (German numeric)
  for (const m of text.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g)) {
    const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (validDay(y, mo, d)) add(`${y}-${pad(mo)}-${pad(d)}`, m.index!, m[0].length);
  }
  // September 1989
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{4})\\b`, 'giu'))) {
    const mo = MONTHS[m[1].toLowerCase()];
    const y = Number(m[2]);
    if (validDay(y, mo, 1)) add(`${y}-${pad(mo)}`, m.index!, m[0].length);
  }
  // A bare year
  for (const m of text.matchAll(/\b(1[89]\d{2}|20\d{2})\b/g)) add(m[1], m.index!, m[0].length);
  return out.sort((a, b) => a.index - b.index);
}

/** Money amounts as whole numbers: $30 million, 30 Mio. Euro, €2.5m, 1,200,000 dollars. */
export function findAmounts(text: string): number[] {
  const out: number[] = [];
  const re = /(?:[$€£]\s?)(\d+(?:[.,]\d+)*)\s*(billion|million|mio\.?|mrd\.?|milliarden?|thousand|k|m|bn)?\b|(\d+(?:[.,]\d+)*)\s*(billion|million|mio\.?|mrd\.?|milliarden?)\s*(?:us-?)?(?:dollars?|euros?|euro|pounds?|usd|eur)?/gi;
  for (const m of text.matchAll(re)) {
    const raw = (m[1] ?? m[3] ?? '').trim();
    const unit = (m[2] ?? m[4] ?? '').toLowerCase().replace(/\.$/, '');
    if (!raw) continue;
    // "2.5" with a unit is a decimal; "1,200,000" without a unit is thousands separators (English); German "2,5 Mio." is a decimal.
    let n: number;
    if (unit) n = Number(raw.replace(/,/g, '.').replace(/\.(?=.*\.)/g, ''));
    else n = Number(raw.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.'));
    if (!Number.isFinite(n)) continue;
    const mult = /^(billion|bn|mrd|milliarde|milliarden)$/.test(unit) ? 1e9 : /^(million|mio|m)$/.test(unit) ? 1e6 : /^(thousand|k)$/.test(unit) ? 1e3 : 1;
    const value = Math.round(n * mult);
    if (value >= 1000 && !out.includes(value)) out.push(value);
  }
  return out;
}

const NAME_STOP = new Set(['The', 'He', 'She', 'They', 'His', 'Her', 'In', 'On', 'At', 'After', 'Before', 'During', 'When', 'Source', 'Sources', 'Quelle', 'Quellen', 'Er', 'Sie', 'Der', 'Die', 'Das', 'Im', 'Am', 'Nach', 'Vor', 'Mit', 'Note', 'Unclear', 'Unconfirmed', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);

/** Person-like names (2–4 capitalized words), excluding the article's own subject. */
export function findNames(text: string, subjectTokens: string[]): string[] {
  const out: string[] = [];
  const subject = new Set(subjectTokens.map((t) => t.toLowerCase()));
  for (const m of text.matchAll(/\b(\p{Lu}[\p{Ll}'’-]+(?:\s+(?:von|van|de|der|da|di|le|la)?\s*\p{Lu}[\p{Ll}'’-]+){1,3})\b/gu)) {
    const words = m[1].split(/\s+/).filter((w) => !NAME_STOP.has(w));
    if (words.length < 2) continue;
    if (words.every((w) => subject.has(w.toLowerCase()))) continue;
    const name = words.join(' ');
    if (!out.includes(name)) out.push(name);
  }
  return out.slice(0, 6);
}

export function subjectTokens(keyword: string): string[] {
  return keyword
    .replace(/\b(net worth|wife|husband|kids|children|age|height|biography|bio|vermögen|frau|freundin|kinder|alter|größe)\b/gi, ' ')
    .split(/\s+/)
    .filter((w) => /^\p{L}[\p{L}'’.-]+$/u.test(w))
    .slice(0, 4);
}

/** Split notes into statements: bullet lines and sentences; citation lines attach to the statement before them. */
function statements(notes: string): { text: string; urls: string[] }[] {
  const out: { text: string; urls: string[] }[] = [];
  for (const rawLine of notes.split(/\n+/)) {
    const line = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (!line) continue;
    const urls = [...line.matchAll(URL_RE)].map((m) => m[0].replace(/[.,;:]+$/, ''));
    const textOnly = line.replace(URL_RE, '').replace(/\(\s*\)|\[\s*\]/g, '').trim();
    if (/^(sources?|quellen?|references?|citation)\s*:?\s*$/i.test(textOnly) || (!textOnly.replace(/^(sources?|quellen?)\s*:/i, '').trim() && urls.length)) {
      if (out.length) out[out.length - 1].urls.push(...urls);
      continue;
    }
    if (/^#+\s/.test(line) || textOnly.length < 15) continue;
    const parts = textOnly.split(/(?<=[.!?])\s+(?=\p{Lu})/u);
    parts.forEach((p, i) => out.push({ text: p.trim(), urls: i === parts.length - 1 ? urls : [] }));
  }
  return out;
}

export function extractClaims(notes: string, keyword: string): ExtractedClaim[] {
  const subject = subjectTokens(keyword);
  const claims: ExtractedClaim[] = [];
  for (const s of statements(notes)) {
    const type = TYPE_PATTERNS.find(([, re]) => re.test(s.text))?.[0];
    if (!type) continue;
    const dates = findDates(s.text).map((d) => d.value);
    const amounts = type === 'NET_WORTH' ? findAmounts(s.text) : [];
    const names = type === 'FAMILY' || type === 'AWARD' || type === 'EDUCATION' ? findNames(s.text, subject) : [];
    // Only statements with something checkable are claims (a date, an amount or a name).
    if (!dates.length && !amounts.length && !names.length) continue;
    const nature: ClaimNature = UNCERTAIN.test(s.text) ? 'UNVERIFIED_CLAIM' : ESTIMATE.test(s.text) || type === 'NET_WORTH' ? 'ESTIMATE' : 'REPORTED_FACT';
    claims.push({ type, text: s.text.slice(0, 600), values: { dates, amounts, names }, nature, highImpact: HIGH_IMPACT.includes(type), citations: [...new Set(s.urls)] });
  }
  return claims.slice(0, 60);
}

// ---------------------------------------------------------------- matching against a source

export interface SourceText {
  text: string;
  title: string;
}

/** Is the page about this subject? Every subject token must occur; disambiguation pages never count. */
export function aboutSubject(source: SourceText, keyword: string, context: string[] = []): { ok: boolean; reason: string | null } {
  const lower = `${source.title}\n${source.text}`.toLowerCase();
  if (/\b(may refer to|disambiguation|begriffsklärung|steht für:)\b/.test(lower)) return { ok: false, reason: 'disambiguation page (several people or things with this name)' };
  const subject = subjectTokens(keyword).map((t) => t.toLowerCase());
  const missing = subject.filter((t) => !new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'iu').test(lower));
  if (missing.length) return { ok: false, reason: `does not mention ${subject.join(' ')}` };
  // A page about someone else with the same name: none of the context words (occupation, band, works) appear.
  // Even one distinguishing word (occupation, band, secondary keyword) must appear: a namesake is never merged in.
  const ctx = context.map((c) => c.toLowerCase()).filter((c) => c.length > 3);
  if (ctx.length && !ctx.some((c) => lower.includes(c))) return { ok: false, reason: `about a different ${subject.join(' ')} (none of: ${ctx.slice(0, 4).join(', ')})` };
  return { ok: true, reason: null };
}

export type Verdict = 'SUPPORTS' | 'CONTRADICTS' | 'NO_MENTION';

const NEAR: Record<ClaimType, RegExp> = Object.fromEntries(TYPE_PATTERNS) as Record<ClaimType, RegExp>;

/** What one source says about one claim, with an excerpt around the evidence. */
export function judge(claim: ExtractedClaim, source: SourceText): { verdict: Verdict; excerpt: string | null; detail: string | null } {
  const text = source.text;
  const around = (i: number, len = 60) => text.slice(Math.max(0, i - 120), Math.min(text.length, i + len + 120)).replace(/\s+/g, ' ').trim();
  if (claim.values.dates.length) {
    const found = findDates(text);
    const want = claim.values.dates;
    const hit = found.find((d) => want.some((w) => d.value === w || (w.length === 4 && d.value.startsWith(w)) || (d.value.length === 4 && w.startsWith(d.value))));
    // For births and deaths, a different full date next to the keyword is a contradiction.
    if (claim.type === 'BIRTH' || claim.type === 'DEATH') {
      const typed = found.filter((d) => d.value.length === 10 && NEAR[claim.type].test(text.slice(Math.max(0, d.index - 80), d.index + 40)));
      const full = want.find((w) => w.length === 10);
      if (full && typed.length && !typed.some((d) => d.value === full)) return { verdict: 'CONTRADICTS', excerpt: around(typed[0].index), detail: `source gives ${typed[0].value}, the notes say ${full}` };
      if (full && typed.some((d) => d.value === full)) return { verdict: 'SUPPORTS', excerpt: around(typed.find((d) => d.value === full)!.index), detail: null };
    }
    if (hit && (!claim.values.names.length || claim.values.names.some((n) => text.includes(n)))) return { verdict: 'SUPPORTS', excerpt: around(hit.index), detail: null };
  }
  if (claim.values.amounts.length) {
    const found = findAmounts(text);
    const match = found.find((a) => claim.values.amounts.some((w) => Math.abs(a - w) / w < 0.02));
    if (match) {
      const i = text.search(/[$€£]?\s?\d/);
      return { verdict: 'SUPPORTS', excerpt: around(Math.max(0, i)), detail: null };
    }
    if (found.length && NEAR.NET_WORTH.test(text)) return { verdict: 'CONTRADICTS', excerpt: null, detail: `source gives ${found.slice(0, 2).map((a) => a.toLocaleString('en-US')).join(' / ')}` };
  }
  if (claim.values.names.length && !claim.values.dates.length) {
    const name = claim.values.names.find((n) => text.includes(n));
    if (name) return { verdict: 'SUPPORTS', excerpt: around(text.indexOf(name), name.length), detail: null };
  }
  return { verdict: 'NO_MENTION', excerpt: null, detail: null };
}

export type ClaimStatus = 'VERIFIED' | 'SINGLE_SOURCE' | 'ESTIMATE' | 'DISPUTED' | 'CONTRADICTED' | 'UNVERIFIED';

/** Status from the evidence: two independent supporting sites verify; any contradiction is surfaced, never hidden. */
export function statusFor(claim: ExtractedClaim, evidence: { host: string; verdict: Verdict }[]): ClaimStatus {
  const supporting = new Set(evidence.filter((e) => e.verdict === 'SUPPORTS').map((e) => e.host));
  const contradicting = evidence.some((e) => e.verdict === 'CONTRADICTS');
  if (contradicting && claim.nature !== 'ESTIMATE') return 'CONTRADICTED';
  if (claim.nature === 'ESTIMATE') return contradicting || !supporting.size ? (contradicting ? 'DISPUTED' : 'ESTIMATE') : 'ESTIMATE';
  if (claim.nature === 'UNVERIFIED_CLAIM') return supporting.size >= 2 ? 'SINGLE_SOURCE' : 'DISPUTED';
  if (supporting.size >= 2) return 'VERIFIED';
  if (supporting.size === 1) return 'SINGLE_SOURCE';
  return 'UNVERIFIED';
}

/** The same kind of high-impact fact with different values inside the notes themselves (e.g. two birth dates). */
export function internalConflicts(claims: ExtractedClaim[]): { type: ClaimType; values: string[] }[] {
  const out: { type: ClaimType; values: string[] }[] = [];
  for (const type of ['BIRTH', 'DEATH'] as ClaimType[]) {
    const full = [...new Set(claims.filter((c) => c.type === type).flatMap((c) => c.values.dates.filter((d) => d.length === 10)))];
    if (full.length > 1) out.push({ type, values: full });
  }
  return out;
}

/** Where a claim's value appears in the article (paragraph index), or null when the article does not state it. */
export function locateInArticle(claim: ExtractedClaim, paragraphs: string[]): number | null {
  for (const [i, p] of paragraphs.entries()) {
    const dates = findDates(p).map((d) => d.value);
    if (claim.values.dates.some((d) => d.length >= 7 && dates.includes(d))) return i;
    if (claim.values.amounts.length && findAmounts(p).some((a) => claim.values.amounts.some((w) => Math.abs(a - w) / w < 0.02))) return i;
    if (claim.values.names.length && !claim.values.dates.length && claim.values.names.some((n) => p.includes(n))) return i;
  }
  return null;
}
