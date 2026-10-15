/**
 * Descriptive alt text for article images (upgrade 08). Alt text comes from
 * the image plan / photo check; this module cleans it and replaces text that
 * a screen reader cannot use (file names, URLs, empty or one-word labels,
 * keyword stuffing, the same text on two images). It never claims to know
 * what an image shows: the fallback only names the article subject.
 */

export type AltSlot = 'FEATURED' | 'BODY1' | 'BODY2';

export const ALT_MAX = 125;

// “Image of …” adds nothing (screen readers announce an image); “Photo of …” says what kind of image it is and stays.
const REDUNDANT_PREFIX = /^(?:(?:an?|the)\s+)?(?:image|picture|graphic)\s+(?:of|showing|shows)\s+|^(?:ein(?:e)?\s+|das\s+)?(?:bild|abbildung|grafik)\s+(?:von|zeigt|mit)\s+/i;
const FILE_LIKE = /\.(?:jpe?g|png|webp|gif|avif|bmp|tiff?|svg)$|^(?:img|dsc|dscn|pxl|image|screenshot|photo)[-_ ]?\d{2,}/i;
const URL_LIKE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|de|org|net|io)\b/i;

function clean(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”„‚‘’«»]+|["'“”„‚‘’«»]+$/g, '')
    .trim();
}

function truncate(s: string, max = ALT_MAX): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  const at = cut.lastIndexOf(' ');
  return (at > max * 0.6 ? cut.slice(0, at) : s.slice(0, max)).replace(/[\s,;:–—-]+$/, '');
}

function countOccurrences(text: string, phrase: string): number {
  const p = phrase.trim().toLowerCase();
  if (!p) return 0;
  let n = 0;
  for (let i = text.toLowerCase().indexOf(p); i >= 0; i = text.toLowerCase().indexOf(p, i + p.length)) n++;
  return n;
}

/** Problems that make alt text unusable (empty list = fine). */
export function altTextIssues(alt: string | null | undefined, keyword?: string | null): string[] {
  const a = clean(alt ?? '');
  const issues: string[] = [];
  if (!a) return ['missing'];
  if (FILE_LIKE.test(a)) issues.push('looks like a file name');
  if (URL_LIKE.test(a)) issues.push('contains a web address');
  const words = a.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (a.length < 5 || words.length < 2) issues.push('too short to describe the image');
  if (keyword && countOccurrences(a, keyword) > 1) issues.push('repeats the keyword');
  return issues;
}

function fallbackAlt(slot: AltSlot, ctx: { subject: string; title?: string | null; language: string }): string {
  const de = ctx.language === 'de';
  if (slot === 'FEATURED' && ctx.title?.trim()) return truncate(clean(ctx.title));
  const n = slot === 'FEATURED' ? 1 : slot === 'BODY1' ? 2 : 3;
  return truncate(de ? `${ctx.subject}: Artikelbild ${n}` : `${ctx.subject}: article image ${n}`);
}

export interface AltResult {
  alt: string;
  /** What was wrong with the proposed text (shown as image notes). */
  issues: string[];
  /** True when the proposed text was unusable and a neutral fallback was used. */
  fallback: boolean;
}

/**
 * Clean the proposed alt text for one image slot. `others` holds alt text
 * already given to other images of the same article (case-insensitive
 * duplicates are replaced).
 */
export function normalizeAltText(raw: string | null | undefined, slot: AltSlot, ctx: { subject: string; keyword?: string | null; title?: string | null; language: string; others?: string[] }): AltResult {
  let alt = clean(raw ?? '');
  const notes: string[] = [];
  const stripped = alt.replace(REDUNDANT_PREFIX, '');
  if (stripped !== alt && altTextIssues(stripped).length === 0) {
    alt = stripped.charAt(0).toUpperCase() + stripped.slice(1);
    notes.push('dropped “image of …” (screen readers already announce an image)');
  }
  if (alt.length > ALT_MAX) {
    alt = truncate(alt);
    notes.push(`shortened to ${ALT_MAX} characters`);
  }
  const issues = altTextIssues(alt, ctx.keyword);
  const duplicate = !!alt && (ctx.others ?? []).some((o) => clean(o).toLowerCase() === alt.toLowerCase());
  if (duplicate) issues.push('same text as another image');
  if (issues.length) {
    const fb = fallbackAlt(slot, ctx);
    const usable = !(ctx.others ?? []).some((o) => clean(o).toLowerCase() === fb.toLowerCase());
    return { alt: usable ? fb : truncate(`${fb} (${slot.toLowerCase()})`), issues: [...notes, ...issues], fallback: true };
  }
  return { alt, issues: notes, fallback: false };
}
