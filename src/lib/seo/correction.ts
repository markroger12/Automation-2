import { load } from 'cheerio';
import { countNormalized, detectLanguage, normalizeText, stripTags, wordCount } from '@/lib/content/text';

/**
 * Safety checks for an SEO-correction rewrite. A rewrite is rejected (and the
 * previous article kept) when it adds more than 15 % words, removes more than
 * 30 %, drops a heading, a link or an image, changes language, or pushes the
 * keyword density over the configured cap.
 */

export interface CorrectionCheck {
  accepted: boolean;
  reasons: string[];
  before: { words: number; headings: number; links: number; images: number; densityPct: number };
  after: { words: number; headings: number; links: number; images: number; densityPct: number };
}

function shape(html: string, keyword: string) {
  const $ = load(`<body>${html}</body>`);
  const text = stripTags(html);
  const words = wordCount(text);
  const headings = $('h2,h3,h4').toArray().map((h) => normalizeText($(h).text()));
  const links = $('a[href]').toArray().map((a) => $(a).attr('href')!.trim());
  const images = $('img[src]').toArray().map((i) => $(i).attr('src')!.trim());
  const occurrences = countNormalized(text, keyword);
  // Mentions per 100 words, the same convention as the SEO checks and Rank Math.
  const densityPct = words ? Math.round((occurrences / words) * 1000) / 10 : 0;
  return { text, words, headings, links, images, densityPct };
}

export function evaluateCorrection(beforeHtml: string, afterHtml: string, opts: { keyword: string; language: string; densityCeilingPct: number }): CorrectionCheck {
  const b = shape(beforeHtml, opts.keyword);
  const a = shape(afterHtml, opts.keyword);
  const reasons: string[] = [];
  if (b.words > 0) {
    const change = (a.words - b.words) / b.words;
    if (change > 0.15) reasons.push(`adds ${Math.round(change * 100)} % words (max 15 %)`);
    if (change < -0.3) reasons.push(`removes ${Math.round(-change * 100)} % words (max 30 %)`);
  }
  // A heading is kept when all of its words are still in one heading (the keyword may be added to it).
  const kept = (h: string) => a.headings.some((x) => x === h || x.includes(h) || h.split(' ').every((w) => x.split(' ').includes(w)));
  const missingHeadings = b.headings.filter((h) => !kept(h));
  if (a.headings.length < b.headings.length) reasons.push(`has ${a.headings.length} headings instead of ${b.headings.length}`);
  if (missingHeadings.length) reasons.push(`loses heading(s): ${missingHeadings.slice(0, 3).join(' · ')}`);
  const missingLinks = b.links.filter((l) => !a.links.includes(l));
  if (missingLinks.length) reasons.push(`breaks/removes ${missingLinks.length} link(s)`);
  const missingImages = b.images.filter((i) => !a.images.includes(i));
  if (missingImages.length) reasons.push(`removes ${missingImages.length} image(s)`);
  if (a.densityPct > opts.densityCeilingPct && a.densityPct > b.densityPct) reasons.push(`keyword density ${a.densityPct} % exceeds the ${opts.densityCeilingPct} % cap`);
  const lang = detectLanguage(a.text);
  if ((opts.language === 'en' || opts.language === 'de') && lang.language !== 'unknown' && lang.language !== opts.language && lang.confidence > 0.6) reasons.push(`language changed to ${lang.language}`);
  if (a.words < 50) reasons.push('answer is not a full article');
  return {
    accepted: reasons.length === 0,
    reasons,
    before: { words: b.words, headings: b.headings.length, links: b.links.length, images: b.images.length, densityPct: b.densityPct },
    after: { words: a.words, headings: a.headings.length, links: a.links.length, images: a.images.length, densityPct: a.densityPct },
  };
}
