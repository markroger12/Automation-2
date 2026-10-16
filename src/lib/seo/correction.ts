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

// ---------------------------------------------------------------- rich-text marks for the SEO-correction prompt

/**
 * The SEO-correction prompt carries the whole article. Markdown links (`[**anchor**](https://…)`) and `**bold**`
 * were not placed in ChatGPT's composer as typed text (owner report: “Could not place the complete prompt in the
 * composer as text”), while the humanizer's marks were. So links and bold/italic spans travel as the humanizer's
 * marks: {L1}anchor{/L1}, {b}…{/b}, {i}…{/i}. Each link keeps its original tag (URL, attributes, inner bold) and gets
 * it back after the answer; a link ChatGPT drops stays dropped, so the correction checks still reject it.
 */
export interface MarkedLink {
  n: number;
  outer: string;
  text: string;
}

const lookAlike = (s: string) => s.replace(/\{/g, '｛').replace(/\}/g, '｝');

export const MARKS_NOTE = 'Links are written as {L1}…{/L1}, bold as {b}…{/b} and italic as {i}…{/i}. Keep every mark exactly as it is, with the same text inside, at the place where it belongs.';

export function markRichText(html: string): { html: string; links: MarkedLink[] } {
  const $ = load(`<body>${html}</body>`);
  const body = $('body');
  // Braces in the article text become look-alikes, so text can never forge a mark.
  body.find('*').addBack().contents().each((_, node) => {
    if (node.type === 'text') (node as unknown as { data: string }).data = lookAlike((node as unknown as { data: string }).data);
  });
  const links: MarkedLink[] = [];
  body.find('a').each((_, el) => {
    if ($(el).parents('a').length) return;
    const n = links.length + 1;
    const text = $(el).text();
    links.push({ n, outer: $.html(el).replace(/｛/g, '{').replace(/｝/g, '}'), text });
    $(el).replaceWith(`{L${n}}${$('<div>').text(text).html()}{/L${n}}`);
  });
  for (const [selector, mark] of [['strong, b', 'b'], ['em, i', 'i']] as const) {
    body.find(selector).each((_, el) => {
      $(el).replaceWith(`{${mark}}${$('<div>').text($(el).text()).html()}{/${mark}}`);
    });
  }
  return { html: body.html() ?? '', links };
}

/** HTML of the answer with the marks turned back into the original links, bold and italic. */
export function restoreRichText(html: string, links: MarkedLink[]): string {
  const byN = new Map(links.map((l) => [l.n, l]));
  return html
    .replace(/\{L(\d+)\}([\s\S]*?)\{\/L\1\}/g, (_, n: string, inner: string) => byN.get(Number(n))?.outer ?? inner)
    .replace(/\{b\}([\s\S]*?)\{\/b\}/g, '<strong>$1</strong>')
    .replace(/\{i\}([\s\S]*?)\{\/i\}/g, '<em>$1</em>')
    .replace(/\{\/?(?:b|i|L\d+)\}/g, '')
    .replace(/｛/g, '{')
    .replace(/｝/g, '}');
}
