import { normalizeText, stripTags } from '../content/text';
import { significantTokens } from './verify';

/**
 * Internal link selection (pure). Relevance beats recency: keyword/entity
 * overlap with the target's title, slug and (for app-created posts) primary
 * keyword, plus a same-category bonus. Falls back to the previous article
 * created by this app, then the site's latest real post. Never the article
 * itself.
 */

export interface TargetLike {
  id: string;
  wpPostId: number;
  url: string;
  title: string;
  slug: string | null;
  categoryIds: number[];
  keyword: string | null;
  excerpt: string | null;
  publishedAt: Date | null;
}

export interface RankInput {
  keyword: string;
  secondary: string[];
  title: string | null;
  categoryExternalId: number | null;
  ownPostId: number | null;
  ownUrl?: string | null;
  now?: Date;
}

export interface Ranked<T extends TargetLike = TargetLike> {
  target: T;
  score: number;
  related: boolean;
  reasons: string[];
}

const uniq = (a: string[]) => Array.from(new Set(a));

export function rankTargets<T extends TargetLike>(input: RankInput, targets: T[]): Ranked<T>[] {
  const now = input.now ?? new Date();
  const kw = uniq(significantTokens(input.keyword));
  const extra = uniq(significantTokens(`${input.secondary.join(' ')} ${input.title ?? ''}`)).filter((t) => !kw.includes(t));
  const ownUrl = input.ownUrl ? input.ownUrl.replace(/\/+$/, '') : null;
  const out: Ranked<T>[] = [];
  for (const t of targets) {
    if (input.ownPostId && t.wpPostId === input.ownPostId) continue;
    if (ownUrl && t.url.replace(/\/+$/, '') === ownUrl) continue;
    const strong = uniq(significantTokens(`${t.keyword ?? ''} ${t.title} ${(t.slug ?? '').replace(/-/g, ' ')}`));
    const weak = uniq(significantTokens(stripTags(t.excerpt ?? ''))).filter((w) => !strong.includes(w));
    const kwHits = kw.filter((w) => strong.includes(w));
    const extraHits = extra.filter((w) => strong.includes(w));
    const weakHits = [...kw, ...extra].filter((w) => weak.includes(w));
    const sameCategory = Boolean(input.categoryExternalId && t.categoryIds.includes(input.categoryExternalId));
    const ageDays = t.publishedAt ? Math.max(0, (now.getTime() - t.publishedAt.getTime()) / 86_400_000) : 3650;
    const score = (3 * kwHits.length) / Math.max(1, kw.length) + Math.min(extraHits.length, 3) / 3 + (0.5 * Math.min(weakHits.length, 3)) / 3 + (sameCategory ? 0.8 : 0) + 0.3 * Math.exp(-ageDays / 365);
    const reasons: string[] = [];
    if (kwHits.length) reasons.push(`keyword words in title: ${kwHits.join(', ')}`);
    if (extraHits.length) reasons.push(`topic words: ${extraHits.join(', ')}`);
    if (weakHits.length) reasons.push(`mentioned in excerpt: ${weakHits.slice(0, 3).join(', ')}`);
    if (sameCategory) reasons.push('same category');
    out.push({ target: t, score: Math.round(score * 100) / 100, related: kwHits.length >= 1 || extraHits.length >= 2, reasons });
  }
  return out.sort((a, b) => b.score - a.score || (b.target.publishedAt?.getTime() ?? 0) - (a.target.publishedAt?.getTime() ?? 0));
}

export type ChoiceReason = 'related' | 'previous' | 'latest';

export function chooseLineTarget<T extends TargetLike>(ranked: Ranked<T>[]): { choice: Ranked<T>; reason: ChoiceReason; order: { choice: Ranked<T>; reason: ChoiceReason }[] } | null {
  const order: { choice: Ranked<T>; reason: ChoiceReason }[] = [];
  for (const r of ranked.filter((x) => x.related)) order.push({ choice: r, reason: 'related' });
  const byDate = [...ranked].sort((a, b) => (b.target.publishedAt?.getTime() ?? 0) - (a.target.publishedAt?.getTime() ?? 0));
  for (const r of byDate.filter((x) => x.target.keyword)) if (!order.some((o) => o.choice === r)) order.push({ choice: r, reason: 'previous' });
  for (const r of byDate) if (!order.some((o) => o.choice === r)) order.push({ choice: r, reason: 'latest' });
  return order.length ? { ...order[0], order } : null;
}

/**
 * The internal-link line's target for the previous article this app wrote (as in the owner's earlier tool): its
 * published post from the index, else its planned `/<slug>/` address, predicted only when the site's indexed posts
 * use such addresses. The stage checks the address: a draft's planned address works once the draft is published.
 */
export function previousArticleTarget<T extends TargetLike>(prev: { title: string; wpPostId: number | null; slug: string | null }, targets: T[], siteUrl: string): { url: string; target: T | null; planned: boolean } | null {
  const indexed = targets.find((t) => (prev.wpPostId && t.wpPostId === prev.wpPostId) || normalizeText(t.title) === normalizeText(prev.title));
  if (indexed) return { url: indexed.url, target: indexed, planned: false };
  if (!prev.slug) return null;
  const base = siteUrl.replace(/\/+$/, '');
  const slugAddresses = targets.some((t) => t.slug && t.url.replace(/\/+$/, '') === `${base}/${t.slug}`);
  return slugAddresses ? { url: `${base}/${encodeURIComponent(prev.slug)}/`, target: null, planned: true } : null;
}

/** Natural anchor for a target that already appears in the body text (keeps the body's own casing). */
export function findAnchor(bodyText: string, target: TargetLike): string | null {
  const candidates = uniq(
    [target.keyword ?? '', target.title.split(/\s[:–—|-]\s|:\s/)[0] ?? '']
      .map((c) => c.trim())
      .filter((c) => c.split(/\s+/).length >= 2 && c.split(/\s+/).length <= 6),
  );
  const lower = bodyText.toLowerCase();
  for (const c of candidates) {
    const i = lower.indexOf(c.toLowerCase());
    if (i < 0) continue;
    const before = bodyText[i - 1];
    const after = bodyText[i + c.length];
    if ((before && /[\p{L}\p{N}]/u.test(before)) || (after && /[\p{L}\p{N}]/u.test(after))) continue;
    return bodyText.slice(i, i + c.length);
  }
  return null;
}

/**
 * Words that follow a person's name in celebrity titles and keywords (“… Net Worth 2026”, “… Husband”, “Größe von …”):
 * what is left is the name, the most natural word to link (owner request 2026-11-15: the related article's link “on a
 * word” of the article).
 */
const TOPIC_WORDS = new Set(
  [
    // English
    'net', 'worth', 'age', 'height', 'weight', 'wiki', 'wikipedia', 'bio', 'biography', 'husband', 'wife', 'spouse', 'partner', 'boyfriend', 'girlfriend',
    'dating', 'married', 'marriage', 'divorce', 'relationship', 'family', 'parents', 'father', 'mother', 'dad', 'mom', 'siblings', 'brother', 'brothers', 'sister',
    'sisters', 'children', 'kids', 'son', 'sons', 'daughter', 'daughters', 'baby', 'career', 'salary', 'income', 'house', 'houses', 'cars', 'ethnicity',
    'nationality', 'religion', 'instagram', 'tiktok', 'youtube', 'death', 'cause', 'died', 'dead', 'alive', 'now', 'today', 'facts', 'news', 'life',
    'early', 'personal', 'movies', 'shows', 'songs', 'albums', 'awards', 'education', 'birthday', 'birthplace', 'background', 'photos', 'pictures', 'story',
    // German
    'vermögen', 'alter', 'größe', 'grösse', 'gewicht', 'biografie', 'ehemann', 'ehefrau', 'mann', 'frau', 'freund', 'freundin', 'partnerin', 'familie',
    'eltern', 'vater', 'mutter', 'geschwister', 'bruder', 'schwester', 'kinder', 'kind', 'sohn', 'tochter', 'töchter', 'söhne', 'karriere', 'gehalt',
    'herkunft', 'nationalität', 'tod', 'todesursache', 'heute', 'privat', 'privatleben', 'steckbrief', 'fakten',
  ].map((w) => w.normalize('NFKC')),
);
const LINKING_WORDS = new Set(['of', 'the', 'and', 'in', 'his', 'her', 'their', 'a', 'an', 'is', 'von', 'der', 'die', 'das', 'und', 'im', 'ist', 'sein', 'seine', 'ihr', 'ihre']);
const QUESTION_START = /^(who is|who was|what is|what was|what happened to|how old is|how tall is|how rich is|wer ist|wer war|was ist|wie alt ist|wie groß ist|wie reich ist)\s+/i;

/** The person (or thing) a keyword or title is about: “Sarah Jones Net Worth 2026: How Rich Is She?” → “Sarah Jones”. */
export function subjectOf(text: string): string | null {
  let s = (text.split(/\s[:–—|-]\s|:\s|\?/)[0] ?? '').trim();
  s = s.replace(QUESTION_START, '');
  const words = s.split(/\s+/).filter(Boolean);
  // From the end: topic words, years and linking words (“Größe von Heidi Klum” is handled from the start below).
  while (words.length && (TOPIC_WORDS.has(words[words.length - 1].toLowerCase()) || LINKING_WORDS.has(words[words.length - 1].toLowerCase()) || /^\d{4}$/.test(words[words.length - 1]))) words.pop();
  while (words.length && (TOPIC_WORDS.has(words[0].toLowerCase()) || LINKING_WORDS.has(words[0].toLowerCase()))) words.shift();
  if (words.length) words[words.length - 1] = words[words.length - 1].replace(/['’]s?$/i, '');
  if (words.length < 2 || words.length > 4 || words.some((w) => TOPIC_WORDS.has(w.toLowerCase()) || /^\d+$/.test(w))) return null;
  return words.join(' ');
}

/**
 * The word or words of the article to put the related article's link on (owner request 2026-11-15): the related
 * post's keyword, the start of its title, or the person it is about, as the article already writes it (its own
 * casing). Never a phrase of the article's own subject (`avoid`, its focus keyword): every word of it would then point
 * away from the article. Two to six words, whole words only. Null when none fits: the link then goes on a line in the
 * middle of the article.
 */
export function findRelatedAnchor(bodyText: string, target: Pick<TargetLike, 'keyword' | 'title'>, avoid: string): string | null {
  const own = new Set(normalizeText(avoid).split(' ').filter(Boolean));
  const titleStart = target.title.split(/\s[:–—|-]\s|:\s/)[0] ?? '';
  const candidates = uniq(
    [target.keyword ?? '', titleStart, subjectOf(target.keyword ?? '') ?? '', subjectOf(target.title) ?? '']
      .map((c) => c.replace(/\s+/g, ' ').trim())
      .filter((c) => {
        const n = c.split(' ').length;
        return n >= 2 && n <= 6;
      }),
  );
  for (const c of candidates) {
    const words = normalizeText(c).split(' ').filter(Boolean);
    if (!words.length || words.every((w) => own.has(w))) continue;
    const found = findPhrase(bodyText, c);
    if (found) return found;
  }
  return null;
}

/** A phrase as whole words in the text (any case), as the text writes it; null when it is not there. */
export function findPhrase(bodyText: string, phrase: string): string | null {
  const wanted = phrase.replace(/\s+/g, ' ').trim();
  if (!wanted) return null;
  const lower = bodyText.toLowerCase();
  const needle = wanted.toLowerCase();
  for (let from = 0; ; ) {
    const i = lower.indexOf(needle, from);
    if (i < 0) return null;
    const before = bodyText[i - 1];
    const after = bodyText[i + needle.length];
    if (!(before && /[\p{L}\p{N}]/u.test(before)) && !(after && /[\p{L}\p{N}]/u.test(after))) return bodyText.slice(i, i + needle.length);
    from = i + 1;
  }
}

export function sameTopic(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b);
}
