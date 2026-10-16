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

export function sameTopic(a: string, b: string): boolean {
  return normalizeText(a) === normalizeText(b);
}
