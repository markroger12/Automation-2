import { normalizeText, sentences, words } from '@/lib/content/text';

/**
 * The local editor: flags language patterns per paragraph and article-wide
 * repetition/rhythm. These are editorial diagnostics (what a copy editor
 * would mark), never an "AI detection" score.
 */

type Lang = 'en' | 'de';

const FILLERS: Record<Lang, string[]> = {
  en: ['it is important to note', "it's important to note", 'it is worth noting', "it's worth noting", 'it should be noted', 'this highlights', 'in conclusion', 'needless to say', 'at the end of the day', "in today's world", 'when it comes to', 'it goes without saying', 'all in all'],
  // German inverts after an opener ("Zudem ist es erwähnenswert"), so both word orders are listed.
  de: ['es ist wichtig zu beachten', 'ist es wichtig zu beachten', 'es ist wichtig zu erwähnen', 'ist es wichtig zu erwähnen', 'es ist erwähnenswert', 'ist es erwähnenswert', 'es sei darauf hingewiesen', 'es ist hervorzuheben', 'abschließend lässt sich sagen', 'zusammenfassend lässt sich sagen', 'last but not least', 'nicht zuletzt', 'es bleibt festzuhalten', 'in der heutigen zeit'],
};

const OPENERS: Record<Lang, string[]> = {
  en: ['additionally', 'furthermore', 'moreover', 'notably', 'overall', 'ultimately'],
  de: ['zudem', 'darüber hinaus', 'außerdem', 'des weiteren', 'letztendlich', 'insgesamt', 'bemerkenswerterweise'],
};

const INFLATED: Record<Lang, string[]> = {
  en: ['delve', 'delves', 'delving', 'pivotal', 'intricate', 'meticulous', 'meticulously', 'underscore', 'underscores', 'showcase', 'showcases', 'showcasing', 'testament', 'tapestry', 'realm', 'vibrant', 'embark', 'embarked', 'navigate', 'navigating', 'leverage', 'foster', 'fostering', 'crucial', 'remarkable', 'renowned', 'boasts'],
  de: ['facettenreich', 'maßgeblich', 'unvergleichlich', 'zweifellos', 'eindrucksvoll', 'bahnbrechend', 'unbestreitbar', 'beeindruckend'],
};

export interface ParagraphFlags {
  fillers: string[];
  openers: string[];
  inflated: string[];
  dashes: number;
}

export function flagParagraph(text: string, language: string): ParagraphFlags {
  const lang: Lang = language === 'de' ? 'de' : 'en';
  const lower = ` ${normalizeText(text)} `;
  // One entry per occurrence, so the diagnostics count every empty phrase.
  const fillers = FILLERS[lang].flatMap((f) => Array<string>(lower.split(` ${normalizeText(f)} `).length - 1).fill(f));
  const openers: string[] = [];
  for (const s of sentences(text)) {
    const start = normalizeText(s);
    const hit = OPENERS[lang].find((o) => start === o || start.startsWith(`${o} `));
    if (hit) openers.push(hit);
  }
  const tokens = new Set(words(text.toLowerCase()));
  const inflated = INFLATED[lang].filter((w) => tokens.has(w));
  const dashes = (text.match(/—|–(?=\s)|\s-\s/g) ?? []).length;
  return { fillers, openers, inflated, dashes };
}

export function isFlagged(f: ParagraphFlags): boolean {
  return f.fillers.length > 0 || f.openers.length > 0 || f.inflated.length > 0 || f.dashes >= 2;
}

export function describeFlags(f: ParagraphFlags): string[] {
  const out: string[] = [];
  const fillers = [...new Set(f.fillers)];
  if (fillers.length) out.push(`empty phrase${fillers.length > 1 ? 's' : ''} “${fillers.join('”, “')}”${f.fillers.length > fillers.length ? ` (${f.fillers.length}×)` : ''}`);
  if (f.openers.length) out.push(`sentence opener${f.openers.length > 1 ? 's' : ''} “${[...new Set(f.openers)].join('”, “')}”`);
  if (f.inflated.length) out.push(`inflated word${f.inflated.length > 1 ? 's' : ''} “${f.inflated.join('”, “')}”`);
  if (f.dashes >= 2) out.push(`${f.dashes} dashes`);
  return out;
}

export interface EditorialDiagnostics {
  paragraphs: number;
  words: number;
  flaggedParagraphs: number;
  fillerPhrases: number;
  bannedOpeners: number;
  inflatedWords: number;
  dashes: number;
  /** Sentence-opening words used three or more times. */
  repeatedOpeners: { word: string; count: number }[];
  sentenceLength: { mean: number; sd: number; sentences: number };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Article-wide diagnostics over plain paragraph texts. */
export function diagnose(paragraphs: string[], language: string): EditorialDiagnostics {
  let fillerPhrases = 0;
  let bannedOpeners = 0;
  let inflatedWords = 0;
  let dashes = 0;
  let flagged = 0;
  const openerCounts = new Map<string, number>();
  const lengths: number[] = [];
  for (const p of paragraphs) {
    const f = flagParagraph(p, language);
    fillerPhrases += f.fillers.length;
    bannedOpeners += f.openers.length;
    inflatedWords += f.inflated.length;
    dashes += f.dashes;
    if (isFlagged(f)) flagged++;
    for (const s of sentences(p)) {
      const w = words(s);
      if (!w.length) continue;
      lengths.push(w.length);
      const first = w[0].toLowerCase();
      openerCounts.set(first, (openerCounts.get(first) ?? 0) + 1);
    }
  }
  const mean = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
  const sd = lengths.length ? Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length) : 0;
  return {
    paragraphs: paragraphs.length,
    words: paragraphs.reduce((n, p) => n + words(p).length, 0),
    flaggedParagraphs: flagged,
    fillerPhrases,
    bannedOpeners,
    inflatedWords,
    dashes,
    repeatedOpeners: [...openerCounts.entries()]
      .filter(([, c]) => c >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([word, count]) => ({ word, count })),
    sentenceLength: { mean: round1(mean), sd: round1(sd), sentences: lengths.length },
  };
}

/** Article-wide observations sent with every batch (repetition and rhythm). */
export function observations(d: EditorialDiagnostics): string[] {
  const out: string[] = [];
  for (const r of d.repeatedOpeners.filter((x) => x.count >= Math.max(3, Math.round(d.sentenceLength.sentences * 0.12)))) out.push(`Across the article, ${r.count} sentences start with “${r.word}”; vary the openings where it reads naturally.`);
  if (d.sentenceLength.sentences >= 8 && d.sentenceLength.sd < 4) out.push(`Sentence lengths are very uniform (about ${Math.round(d.sentenceLength.mean)} words each); vary the rhythm naturally.`);
  return out;
}
