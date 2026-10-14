import { normalizeKeyword } from '../domain';

/**
 * Near-duplicate keys (client-safe): word order, punctuation, case,
 * possessives and simple plurals do not make a different article.
 */
export function nearKey(keyword: string): string {
  return normalizeKeyword(keyword)
    .replace(/[’'`´]s\b/g, '')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length > 4 ? w.replace(/(ies)$/, 'y').replace(/(es|s)$/, '') : w))
    .sort()
    .join(' ');
}

/** Levenshtein distance with an early exit above `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Same article in practice: equal near-keys, or a small typo in a longer keyword. */
export function isNearDuplicate(a: string, b: string): boolean {
  const ka = nearKey(a);
  const kb = nearKey(b);
  if (ka === kb) return true;
  // "iphone 14 review" and "iphone 15 review" are different articles: numbers must match exactly.
  const digits = (s: string) => (s.match(/\d+/g) ?? []).join(',');
  if (digits(ka) !== digits(kb)) return false;
  return Math.min(ka.length, kb.length) >= 10 && editDistance(ka, kb, 2) <= 2;
}
