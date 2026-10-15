import { isContentWord, sentenceRanges, type TextModel } from './text';

/**
 * Evidence finding (spec §15): 5-word anchors locate candidate overlaps,
 * which count only as VERIFIED exact runs of at least 8 identical words in
 * the source text; sentences without such a run are compared with
 * sentence-level near-match metrics. Quotations and recurring site
 * boilerplate are exempt. Nothing here turns overlap into a verdict.
 */

export const ANCHOR_WORDS = 5;
export const MIN_RUN_WORDS = 8;

export interface ExactRun {
  /** Token ranges [start, end) in the article and the source. */
  a: [number, number];
  s: [number, number];
  /** Words in the run that are neither quoted nor boilerplate. */
  countedWords: number;
  exempt: null | 'quotation' | 'boilerplate';
}

export interface NearMatch {
  a: [number, number];
  s: [number, number];
  /** Content words of the article sentence also in the source sentence. */
  shared: number;
  contentWords: number;
  /** Longest common word subsequence ÷ article sentence words (word order kept). */
  ordered: number;
}

/**
 * Exact runs of ≥ MIN_RUN_WORDS identical words. `exempt[i]` marks article
 * tokens that do not count (quotations, site boilerplate); a run whose
 * counted words fall below the minimum is reported as exempt, not as evidence.
 */
export function exactRuns(article: TextModel, source: TextModel, boilerplate: Set<number> = new Set()): ExactRun[] {
  const A = article.tokens.map((t) => t.norm);
  const S = source.tokens.map((t) => t.norm);
  if (A.length < MIN_RUN_WORDS || S.length < MIN_RUN_WORDS) return [];
  const anchors = new Map<string, number[]>();
  for (let p = 0; p + ANCHOR_WORDS <= S.length; p++) {
    const key = S.slice(p, p + ANCHOR_WORDS).join(' ');
    const list = anchors.get(key);
    if (!list) anchors.set(key, [p]);
    else if (list.length < 64) list.push(p);
  }
  const runs: ExactRun[] = [];
  let i = 0;
  while (i + ANCHOR_WORDS <= A.length) {
    const hits = anchors.get(A.slice(i, i + ANCHOR_WORDS).join(' '));
    let best = 0;
    let bestP = -1;
    for (const p of hits ?? []) {
      let k = ANCHOR_WORDS;
      while (i + k < A.length && p + k < S.length && A[i + k] === S[p + k]) k++;
      if (k > best) {
        best = k;
        bestP = p;
      }
    }
    if (best >= MIN_RUN_WORDS) {
      let counted = 0;
      let quoted = 0;
      for (let t = i; t < i + best; t++) {
        if (article.tokens[t].quoted) quoted++;
        else if (!boilerplate.has(t)) counted++;
      }
      runs.push({ a: [i, i + best], s: [bestP, bestP + best], countedWords: counted, exempt: counted >= MIN_RUN_WORDS ? null : quoted >= best - counted - quoted ? 'quotation' : 'boilerplate' });
      i += best;
    } else i++;
  }
  return runs;
}

function lcs(a: string[], b: string[]): number {
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]);
      diag = tmp;
    }
  }
  return prev[b.length];
}

export const NEAR = { minSentenceWords: 10, minShared: 6, minContainment: 0.7, minOrdered: 0.6 };

/**
 * Sentence-level near matches: an article sentence that shares most of its
 * content words with one source sentence, largely in the same order. Skips
 * sentences already covered by exact runs, quotations and boilerplate.
 */
export function nearMatches(article: TextModel, source: TextModel, covered: Set<number>, boilerplate: Set<number> = new Set()): NearMatch[] {
  const srcSentences = sentenceRanges(source).filter(([a, b]) => b - a >= 6);
  const index = new Map<string, number[]>();
  srcSentences.forEach(([a, b], idx) => {
    for (const w of new Set(source.tokens.slice(a, b).map((t) => t.norm).filter(isContentWord))) {
      const list = index.get(w);
      if (!list) index.set(w, [idx]);
      else if (list.length < 400) list.push(idx);
    }
  });
  const out: NearMatch[] = [];
  for (const [a, b] of sentenceRanges(article)) {
    if (b - a < NEAR.minSentenceWords) continue;
    const toks = article.tokens.slice(a, b);
    let skip = 0;
    for (let t = a; t < b; t++) if (covered.has(t) || boilerplate.has(t) || article.tokens[t].quoted) skip++;
    if (skip / (b - a) >= 0.5) continue;
    const content = [...new Set(toks.map((t) => t.norm).filter(isContentWord))];
    if (content.length < NEAR.minShared) continue;
    const counts = new Map<number, number>();
    for (const w of content) for (const idx of index.get(w) ?? []) counts.set(idx, (counts.get(idx) ?? 0) + 1);
    let best: NearMatch | null = null;
    for (const [idx, shared] of counts) {
      if (shared < NEAR.minShared || shared / content.length < NEAR.minContainment) continue;
      const [sa, sb] = srcSentences[idx];
      const ordered = lcs(
        toks.map((t) => t.norm),
        source.tokens.slice(sa, sb).map((t) => t.norm),
      ) / toks.length;
      if (ordered < NEAR.minOrdered) continue;
      if (!best || shared / content.length + ordered > best.shared / best.contentWords + best.ordered) best = { a: [a, b], s: [sa, sb], shared, contentWords: content.length, ordered };
    }
    if (best) out.push(best);
  }
  return out;
}

/**
 * Distinctive passages to look up in a search service: sentences of 12–40
 * words rich in long, rare-looking words, numbers and names, spread over the
 * article. Each gives an exact-phrase query of `window` words.
 */
export function distinctivePassages(article: TextModel, count: number, window = 10): { sentence: [number, number]; query: string }[] {
  const scored = sentenceRanges(article)
    .filter(([a, b]) => b - a >= 12 && b - a <= 40 && !article.tokens.slice(a, b).some((t) => t.quoted))
    .map(([a, b]) => {
      const toks = article.tokens.slice(a, b);
      let score = 0;
      for (const t of toks) {
        if (!isContentWord(t.norm)) continue;
        score += t.norm.length >= 8 ? 2 : 1;
        if (/\d/.test(t.norm)) score += 2;
        const raw = article.text.slice(t.start, t.end);
        if (t !== toks[0] && /^\p{Lu}/u.test(raw)) score += 1;
      }
      return { range: [a, b] as [number, number], score: score / Math.sqrt(b - a) };
    })
    .sort((x, y) => y.score - x.score);
  const picked: { sentence: [number, number]; query: string }[] = [];
  const minGap = Math.max(20, Math.floor(article.tokens.length / (count * 2)));
  for (const s of scored) {
    if (picked.length >= count) break;
    if (picked.some((p) => Math.abs(p.sentence[0] - s.range[0]) < minGap)) continue;
    // The window with the most content words.
    const [a, b] = s.range;
    let bestStart = a;
    let bestScore = -1;
    for (let w = a; w + window <= b; w++) {
      const sc = article.tokens.slice(w, w + window).filter((t) => isContentWord(t.norm)).length;
      if (sc > bestScore) {
        bestScore = sc;
        bestStart = w;
      }
    }
    const toks = article.tokens.slice(bestStart, Math.min(b, bestStart + window));
    const query = article.text.slice(toks[0].start, toks[toks.length - 1].end).replace(/\s+/g, ' ');
    picked.push({ sentence: s.range, query });
  }
  return picked;
}

/** Normalized fingerprint of a block (paragraph) for recurring-boilerplate detection. */
export function blockFingerprint(model: TextModel, block: { start: number; end: number }): string {
  return model.tokens
    .filter((t) => t.start >= block.start && t.end <= block.end)
    .map((t) => t.norm)
    .join(' ');
}

/**
 * Article tokens inside blocks that recur verbatim in at least `minArticles`
 * other articles of the same website (disclaimers, calls to action, link
 * lines). Returned with the number of articles each block appears in.
 */
export function boilerplateTokens(article: TextModel, otherBlockCounts: Map<string, number>, minArticles = 3): { tokens: Set<number>; blocks: { text: string; articles: number }[] } {
  const tokens = new Set<number>();
  const blocks: { text: string; articles: number }[] = [];
  for (const block of article.blocks) {
    const fp = blockFingerprint(article, block);
    if (fp.split(' ').length < 4) continue;
    const n = otherBlockCounts.get(fp) ?? 0;
    if (n < minArticles) continue;
    blocks.push({ text: article.text.slice(block.start, block.end), articles: n });
    article.tokens.forEach((t, i) => {
      if (t.start >= block.start && t.end <= block.end) tokens.add(i);
    });
  }
  return { tokens, blocks };
}

/** Text of a token range with up to `context` words around it, split for highlighting. */
export function excerpt(model: TextModel, range: [number, number], context = 12): { before: string; match: string; after: string } {
  const [a, b] = range;
  const t = model.tokens;
  const ctxStart = Math.max(0, a - context);
  const ctxEnd = Math.min(t.length, b + context);
  const clean = (s: string) => s.replace(/\s+/g, ' ');
  return {
    before: (ctxStart > 0 ? '… ' : '') + clean(model.text.slice(t[ctxStart].start, t[a].start)),
    match: clean(model.text.slice(t[a].start, t[b - 1].end)),
    after: clean(model.text.slice(t[b - 1].end, ctxEnd < t.length ? t[ctxEnd - 1].end : model.text.length)) + (ctxEnd < t.length ? ' …' : ''),
  };
}
