import { countNormalized, detectLanguage, sentences, words } from '@/lib/content/text';
import { markSpans, plainText } from './tokens';

/**
 * Fact locks: a rewritten paragraph is accepted only when it keeps every
 * number, date, quotation, required name, link/bold/italic span, the
 * primary-keyword count, the language, a single paragraph, the uncertainty,
 * roughly the length, and most of the original content words. Any
 * violation keeps the original paragraph, with the specific reason.
 *
 * German tolerance (documented): names may appear inflected (Klums, Kaulitz'
 * → suffixes -s, -es, -n, -en, -e, -er, -ns and apostrophes); number words
 * are compared by stem (Million/Millionen); new-name detection is English
 * only, because German capitalizes every noun.
 */

export interface FactLockContext {
  keyword: string;
  language: string;
  /** Names that must survive wherever they occur (keyword, confirmed full name, title entities). */
  names: string[];
  tolerancePct: number;
}

const NUMBER_WORDS: Record<'en' | 'de', string[]> = {
  en: ['two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'million', 'billion', 'dozen', 'twice', 'half'],
  de: ['zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'hundert', 'tausend', 'million', 'milliard', 'dutzend', 'zweimal', 'halb'],
};
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'januar', 'jänner', 'februar', 'märz', 'mai', 'juni', 'juli', 'oktober', 'dezember'];
const HEDGES: Record<'en' | 'de', string[]> = {
  en: ['may', 'might', 'could', 'reportedly', 'allegedly', 'apparently', 'possibly', 'probably', 'likely', 'unclear', 'unconfirmed', 'rumored', 'rumoured', 'rumor', 'rumors', 'rumour', 'rumours', 'seems', 'seem', 'seemed', 'appears', 'appear', 'believed', 'suggests', 'suggest', 'perhaps', 'speculation', 'speculated', 'according to', 'said to', 'is thought'],
  de: ['soll', 'sollen', 'sollte', 'angeblich', 'vermutlich', 'wohl', 'möglicherweise', 'offenbar', 'anscheinend', 'scheint', 'scheinen', 'unklar', 'unbestätigt', 'gerücht', 'gerüchte', 'laut', 'berichten zufolge', 'vielleicht', 'womöglich', 'spekuliert', 'spekulationen'],
};
const BOOSTERS: Record<'en' | 'de', string[]> = {
  en: ['definitely', 'certainly', 'undoubtedly', 'clearly', 'confirmed', 'without doubt', 'without a doubt', 'undeniably', 'proven'],
  de: ['definitiv', 'sicherlich', 'zweifellos', 'eindeutig', 'bestätigt', 'ohne zweifel', 'unbestreitbar', 'nachweislich'],
};
const STOP = new Set(
  'the and that this with from have has had were was been being they them their there which what when where while would should could about into over under after before also than then just very more most such only other some many much your you his her its our out but not for are can will who whom whose how why all any each both few own same too der die das und ist nicht mit ein eine einen einem einer auch auf für sich dem den von zu wurde wurden sind ihre seine nach bei als wie über oder aber noch nur schon sehr mehr wenn dass doch dann denn diese dieser dieses jedoch sowie haben hatte hatten wird werden kann können'.split(' '),
);

const lang = (l: string): 'en' | 'de' => (l === 'de' ? 'de' : 'en');
const sortJoin = (a: string[]) => [...a].sort().join('|');
const ws = (s: string) => s.replace(/\s+/g, ' ').trim();

function countPhrases(text: string, list: string[]): number {
  const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ')} `;
  let n = 0;
  for (const p of list) {
    let i = t.indexOf(` ${p} `);
    while (i >= 0) {
      n++;
      i = t.indexOf(` ${p} `, i + 1);
    }
  }
  return n;
}

/** Digits (thousand separators ignored), number words (by stem) and month names. */
export function numberFacts(text: string, language: string): { numbers: string[]; months: string[] } {
  const digits = (text.match(/\d+(?:[.,:/]\d+)*/g) ?? []).map((n) => n.replace(/[.,](?=\d{3}(?!\d))/g, ''));
  const lower = words(text.toLowerCase());
  const nw = NUMBER_WORDS[lang(language)];
  const named = lower.filter((w) => nw.some((n) => w === n || (w.startsWith(n) && /^(s|en|n|e)$/.test(w.slice(n.length))))).map((w) => nw.find((n) => w.startsWith(n))!);
  return { numbers: [...digits, ...named], months: lower.filter((w) => MONTHS.includes(w)) };
}

/** Text inside double quotation marks (“…”, "…", „…“, «…»). */
export function quotations(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/[“"„«]([^“”"„«»]{1,300})[”"“»]/g)) out.push(ws(m[1]));
  return out;
}

const NAME_SUFFIX = "(?:s|es|n|en|e|er|ns|'s|’s|'|’)?";
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when the name occurs, allowing documented inflection on its last word. */
export function hasName(text: string, name: string): boolean {
  const parts = name.trim().split(/\s+/).map(escRe);
  if (!parts.length || !parts[0]) return true;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${parts.join('\\s+')}${NAME_SUFFIX}(?![\\p{L}\\p{N}])`, 'u');
  return re.test(text);
}

/** Proper-name candidates: runs of two or more capitalized words, plus (English) capitalized words inside a sentence. */
export function nameCandidates(text: string, language: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])(\p{Lu}[\p{L}'’-]+(?:\s+(?:von|van|de|der|da|di|le|la)?\s*\p{Lu}[\p{L}'’-]+)+)/gu)) found.add(ws(m[1]).replace(/['’]s$/, ''));
  if (lang(language) === 'en') {
    for (const s of sentences(text)) {
      const tokens = s.split(/\s+/);
      tokens.slice(1).forEach((tok) => {
        const w = tok.replace(/^[^\p{L}]+|[^\p{L}'’-]+$/gu, '').replace(/['’]s$/, '');
        if (/^\p{Lu}\p{Ll}/u.test(w) && w !== 'I') found.add(w);
      });
    }
  }
  return [...found];
}

function stem(w: string, language: string): string {
  if (lang(language) === 'de') return w.replace(/(ern|en|er|es|em|e|n|s)$/, '');
  return w.replace(/(ing|ed|es|ly|s)$/, '');
}

function contentStems(text: string, language: string): Set<string> {
  return new Set(
    words(text.toLowerCase())
      .filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d/.test(w))
      .map((w) => stem(w, language)),
  );
}

/** Reasons the rewrite must be rejected (empty = accepted). Both inputs are marked text. */
export function validateRewrite(original: string, rewritten: string, ctx: FactLockContext): string[] {
  const reasons: string[] = [];
  const raw = rewritten.trim();
  if (!raw) return ['No rewrite was returned for this paragraph.'];
  if (/\n\s*\n/.test(raw) || /^\s*(#{1,6}\s|\[P\d+\])/m.test(raw)) reasons.push('The rewrite is not exactly one paragraph.');
  if (/<\/?[a-z][^>]*>/i.test(raw)) reasons.push('The rewrite contains HTML markup.');

  const a = markSpans(original);
  const b = markSpans(raw);
  if (b.stray) reasons.push('A link, bold or italic mark is broken or unmatched.');
  const linkKey = (l: { n: number; inner: string }[]) => l.map((x) => `${x.n}:${ws(x.inner)}`).sort().join('|');
  if (linkKey(a.links) !== linkKey(b.links)) reasons.push('A link or its anchor text changed.');
  if (sortJoin(a.bold.map(ws)) !== sortJoin(b.bold.map(ws))) reasons.push('Bold text changed.');
  if (sortJoin(a.italic.map(ws)) !== sortJoin(b.italic.map(ws))) reasons.push('Italic text changed.');

  const po = plainText(original);
  const pr = plainText(raw);
  const L = lang(ctx.language);
  const na = numberFacts(po, L);
  const nb = numberFacts(pr, L);
  if (sortJoin(na.numbers) !== sortJoin(nb.numbers)) reasons.push(`Numbers changed (before: ${na.numbers.join(', ') || 'none'}; after: ${nb.numbers.join(', ') || 'none'}).`);
  if (sortJoin(na.months) !== sortJoin(nb.months)) reasons.push('A date (month) changed.');
  const qa = quotations(po);
  const qb = quotations(pr);
  if (sortJoin(qa) !== sortJoin(qb)) reasons.push('Quoted words changed.');

  const required = new Set<string>();
  for (const n of [...ctx.names, ...nameCandidates(po, L)]) if (n && hasName(po, n)) required.add(n);
  const missing = [...required].filter((n) => !hasName(pr, n));
  if (missing.length) reasons.push(`Name${missing.length > 1 ? 's' : ''} missing: ${missing.slice(0, 4).join(', ')}.`);
  if (L === 'en') {
    const known = new Set(words(po.toLowerCase()));
    const added = nameCandidates(pr, L).filter((n) => n.split(/\s+/).some((w) => !known.has(w.toLowerCase().replace(/['’]s$/, ''))));
    if (added.length) reasons.push(`Adds a name or entity that is not in the original: ${added.slice(0, 3).join(', ')}.`);
  }

  if (ctx.keyword.trim()) {
    const ka = countNormalized(po, ctx.keyword);
    const kb = countNormalized(pr, ctx.keyword);
    if (ka !== kb) reasons.push(`Keyword “${ctx.keyword}” count changed (${ka} → ${kb}).`);
  }
  const detected = detectLanguage(pr);
  if (detected.language !== 'unknown' && detected.confidence >= 0.7 && detected.language !== L) reasons.push(`Language changed to ${detected.language === 'de' ? 'German' : 'English'}.`);

  const ha = countPhrases(po, HEDGES[L]);
  const hb = countPhrases(pr, HEDGES[L]);
  if (hb < ha) reasons.push(`Uncertainty weakened (hedging words ${ha} → ${hb}).`);
  const ba = countPhrases(po, BOOSTERS[L]);
  const bb = countPhrases(pr, BOOSTERS[L]);
  if (bb > ba) reasons.push('Adds certainty that is not in the original.');

  const wa = words(po).length;
  const wb = words(pr).length;
  const change = wa ? ((wb - wa) / wa) * 100 : 0;
  if (Math.abs(change) > ctx.tolerancePct) reasons.push(`Length changed by ${change > 0 ? '+' : ''}${Math.round(change)} % (limit ±${ctx.tolerancePct} %).`);

  const sa = contentStems(po, L);
  const sb = contentStems(pr, L);
  if (sa.size >= 6) {
    const kept = [...sa].filter((x) => sb.has(x)).length / sa.size;
    if (kept < 0.45) reasons.push(`Meaning shifted too far (only ${Math.round(kept * 100)} % of the original content words kept).`);
  }
  return reasons;
}
