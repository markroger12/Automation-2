import { createHash } from 'node:crypto';
import { exactRuns, excerpt, nearMatches, blockFingerprint, type ExactRun } from '../plagiarism/match';
import type { TextModel } from '../plagiarism/text';
import type { Highlight } from '../plagiarism/types';

/**
 * Duplicate Content Detector (upgrade 07): how much of an article's WORDING
 * repeats another saved article. Shared facts are expected between two
 * articles about the same person (names, dates, numbers), so runs made
 * mostly of such tokens are counted separately as “shared facts”, not as
 * duplicated wording. The result is evidence plus a severity used to decide
 * whether to pause for review — never a plagiarism verdict.
 */

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';

export interface DuplicateExcerpt {
  kind: 'wording' | 'fact' | 'near' | 'paragraph';
  words: number;
  article: Highlight;
  other: Highlight;
}

export interface DuplicateComparison {
  otherTaskId: string;
  severity: Severity;
  /** Article words in duplicated-wording runs (≥ 8 identical words, not fact-like). */
  wordingWords: number;
  /** Article words in identical runs that are mostly names, dates and numbers. */
  factWords: number;
  longestRun: number;
  nearSentences: number;
  /** Whole paragraphs that are identical (normalized). */
  exactParagraphs: number;
  /** wordingWords ÷ article words (0–1), shown with the evidence, not as a verdict. */
  wordingShare: number;
  excerpts: DuplicateExcerpt[];
}

const MONTHS = /^(january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|märz|maerz|juni|juli|oktober|dezember)$/;

/** A run is fact-like when it is short and dominated by names, numbers and dates. */
export function isFactLike(model: TextModel, run: [number, number]): boolean {
  const [a, b] = run;
  if (b - a > 20) return false;
  let factTokens = 0;
  for (let i = a; i < b; i++) {
    const t = model.tokens[i];
    const raw = model.text.slice(t.start, t.end);
    if (/\d/.test(t.norm) || MONTHS.test(t.norm) || (i > a && /^\p{Lu}/u.test(raw))) factTokens++;
  }
  return factTokens / (b - a) >= 0.3;
}

export function paragraphHashes(model: TextModel): { hash: string; words: number; position: number }[] {
  return model.blocks
    .map((block, position) => {
      const fp = blockFingerprint(model, block);
      const words = fp ? fp.split(' ').length : 0;
      return { hash: createHash('sha1').update(fp).digest('hex'), words, position };
    })
    .filter((p) => p.words >= 8);
}

export function severityOf(c: Pick<DuplicateComparison, 'wordingShare' | 'longestRun' | 'exactParagraphs' | 'nearSentences' | 'wordingWords'>, highShare: number): Severity {
  if (c.wordingShare >= highShare || c.longestRun >= 60 || c.exactParagraphs >= 3) return 'HIGH';
  if (c.wordingShare >= highShare / 3 || c.longestRun >= 25 || c.exactParagraphs >= 1 || c.nearSentences >= 4) return 'MEDIUM';
  return 'LOW';
}

export function compareArticles(article: TextModel, other: TextModel, otherTaskId: string, opts: { highShare: number; boilerplate?: Set<number> }): DuplicateComparison | null {
  const boilerplate = opts.boilerplate ?? new Set<number>();
  const runs = exactRuns(article, other, boilerplate).filter((r) => !r.exempt);
  const covered = new Set<number>();
  for (const r of runs) for (let t = r.a[0]; t < r.a[1]; t++) covered.add(t);
  const near = nearMatches(article, other, covered, boilerplate);
  if (!runs.length && !near.length) return null;
  const wording: ExactRun[] = [];
  const facts: ExactRun[] = [];
  for (const r of runs) (isFactLike(article, r.a) ? facts : wording).push(r);
  const wordingWords = wording.reduce((n, r) => n + r.countedWords, 0);
  const factWords = facts.reduce((n, r) => n + r.countedWords, 0);
  const otherHashes = new Set(paragraphHashes(other).map((p) => p.hash));
  const exactParagraphs = paragraphHashes(article).filter((p) => otherHashes.has(p.hash)).length;
  const longestRun = Math.max(0, ...wording.map((r) => r.a[1] - r.a[0]));
  const wordingShare = article.tokens.length ? Math.round((wordingWords / article.tokens.length) * 1000) / 1000 : 0;
  const base = { wordingWords, factWords, longestRun, nearSentences: near.length, exactParagraphs, wordingShare };
  const excerpts: DuplicateExcerpt[] = [
    ...wording.sort((x, y) => y.a[1] - y.a[0] - (x.a[1] - x.a[0])).slice(0, 8).map((r) => ({ kind: 'wording' as const, words: r.a[1] - r.a[0], article: excerpt(article, r.a), other: excerpt(other, r.s) })),
    ...near.slice(0, 4).map((n) => ({ kind: 'near' as const, words: n.a[1] - n.a[0], article: excerpt(article, n.a, 0), other: excerpt(other, n.s, 0) })),
    ...facts.slice(0, 3).map((r) => ({ kind: 'fact' as const, words: r.a[1] - r.a[0], article: excerpt(article, r.a, 4), other: excerpt(other, r.s, 4) })),
  ];
  return { otherTaskId, severity: severityOf(base, opts.highShare), ...base, excerpts };
}
