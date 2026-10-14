import { load, type CheerioAPI } from 'cheerio';
import { sanitizeArticleHtml } from '../html/sanitize';
import { dedupeBlocks } from './markdown';

export interface FaqItem {
  question: string;
  answer: string;
}

export interface AssemblyImage {
  slot: 'BODY1' | 'BODY2';
  html: string;
}

export interface AssemblyInput {
  /** Main article HTML (intro + H2/H3 body + conclusion), already sanitized. */
  bodyHtml: string;
  language: string;
  moduleKey: string;
  quickBioHtml?: string | null;
  quickBioName?: string | null;
  faqs?: FaqItem[];
  internalLink?: { line: string; url: string; title: string } | null;
  images?: AssemblyImage[];
}

export interface AssemblyResult {
  html: string;
  warnings: string[];
  structure: { introParagraphs: number; h2: string[]; hasConclusion: boolean; removedDuplicates: number; removedSections: string[] };
}

const HEADINGS = {
  en: { quickBio: 'Quick Bio', quickBioOf: (n: string) => `Quick Bio of ${n}`, faq: 'Frequently Asked Questions' },
  de: { quickBio: 'Kurzbiografie', quickBioOf: (n: string) => `Kurzbiografie von ${n}`, faq: 'Häufig gestellte Fragen' },
};

export const CONCLUSION_RE = /^(conclusion|final thoughts|in conclusion|the bottom line|bottom line|summary|wrapping up|fazit|schlussfolgerung|zusammenfassung|abschließende gedanken|schlusswort|schlussgedanken)\b/i;
export const FAQ_RE = /^(faqs?|frequently asked questions|häufig gestellte fragen|häufige fragen|fragen und antworten)\b/i;
export const QUICK_BIO_RE = /^(quick bio|kurzbiografie|steckbrief|fast facts|quick facts)\b/i;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Section {
  heading: string;
  html: string;
}

function splitSections($: CheerioAPI): { intro: string; sections: Section[] } {
  const nodes = $('body').contents().toArray();
  let intro = '';
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const node of nodes) {
    const html = $.html(node);
    if (node.type === 'tag' && (node as { tagName?: string }).tagName === 'h2') {
      current = { heading: $(node).text().trim(), html };
      sections.push(current);
    } else if (current) current.html += html;
    else intro += html;
  }
  return { intro, sections };
}

/**
 * Assemble in the required order: Introduction → Quick Bio (celebrity) →
 * main body (H2/H3) → FAQs → Conclusion → one final internal-link line.
 * Removes duplicate sections/paragraphs and model-added FAQ/Quick Bio
 * sections, keeps tables, marks, verified links and image positions.
 */
export function assembleArticle(input: AssemblyInput): AssemblyResult {
  const warnings: string[] = [];
  const lang = input.language === 'de' ? 'de' : 'en';
  const h = HEADINGS[lang];
  const dedup = dedupeBlocks(sanitizeArticleHtml(input.bodyHtml));
  const $ = load(`<body>${dedup.html}</body>`);
  // Never keep an internal-link line from an earlier assembly; it is re-added once at the end.
  $('p[data-bas-internal-link]').remove();
  const { intro, sections } = splitSections($);
  const removedSections: string[] = [];
  const isCelebrity = input.moduleKey === 'celebrity-writer';
  const body: Section[] = [];
  let conclusion: Section | null = null;
  let modelFaq: Section | null = null;
  for (const s of sections) {
    if (isCelebrity && FAQ_RE.test(s.heading)) {
      removedSections.push(s.heading);
      continue;
    }
    if (isCelebrity && QUICK_BIO_RE.test(s.heading)) {
      removedSections.push(s.heading);
      continue;
    }
    if (!isCelebrity && FAQ_RE.test(s.heading)) {
      modelFaq = s;
      continue;
    }
    if (CONCLUSION_RE.test(s.heading)) {
      if (conclusion) body.push(conclusion);
      conclusion = s;
      continue;
    }
    body.push(s);
  }
  if (removedSections.length) warnings.push(`Removed sections the model added on its own: ${removedSections.join(', ')} (the dedicated stages provide them).`);
  if (!conclusion) warnings.push('No conclusion section was found in the article body.');
  if (!intro.replace(/<[^>]+>/g, '').trim()) warnings.push('The article has no introduction before the first H2.');

  const parts: string[] = [intro];
  if (isCelebrity && input.quickBioHtml) {
    const heading = input.quickBioName ? h.quickBioOf(input.quickBioName) : h.quickBio;
    parts.push(`<h2>${esc(heading)}</h2>${input.quickBioHtml}`);
  } else if (isCelebrity) {
    warnings.push('Quick Bio table is missing.');
  }
  const bodyParts = body.map((s) => s.html);
  // Body image 1: before the second article H2. With a Quick Bio first, that is the first
  // content section; never before Quick Bio itself, the FAQs or the conclusion.
  const img1 = input.images?.find((i) => i.slot === 'BODY1');
  if (img1) {
    const target = isCelebrity && input.quickBioHtml ? 0 : 1;
    if (bodyParts.length > target) bodyParts[target] = img1.html + bodyParts[target];
    else if (bodyParts.length === 1) bodyParts[0] = injectAfterFirstParagraph(bodyParts[0], img1.html);
    else warnings.push('Body image 1 could not be placed (no body sections).');
  }
  parts.push(...bodyParts);
  let faqHtml = '';
  if (isCelebrity) {
    const faqs = input.faqs ?? [];
    if (faqs.length) faqHtml = `<h2>${h.faq}</h2>${faqs.map((f) => `<h3>${esc(f.question)}</h3><p>${esc(f.answer)}</p>`).join('')}`;
    else warnings.push('FAQs are missing.');
  } else if (modelFaq) {
    const heading = FAQ_RE.test(modelFaq.heading) ? modelFaq.html.replace(/^<h2>[\s\S]*?<\/h2>/i, `<h2>${h.faq}</h2>`) : modelFaq.html;
    faqHtml = heading;
  } else {
    warnings.push('No FAQ section was found.');
  }
  // Body image 2: roughly one paragraph before the FAQ section.
  const img2 = input.images?.find((i) => i.slot === 'BODY2');
  if (img2) {
    if (parts.length > 1) parts[parts.length - 1] = injectBeforeLastParagraph(parts[parts.length - 1], img2.html);
    else warnings.push('Body image 2 could not be placed.');
  }
  if (faqHtml) parts.push(faqHtml);
  if (conclusion) parts.push(conclusion.html);
  if (input.internalLink) {
    parts.push(`<p data-bas-internal-link="1"><strong>${esc(input.internalLink.line)}</strong> <a href="${esc(input.internalLink.url)}">${esc(input.internalLink.title)}</a></p>`);
  }
  const html = sanitizeArticleHtml(parts.join('\n'));
  const $$ = load(`<body>${html}</body>`);
  return {
    html,
    warnings,
    structure: {
      introParagraphs: load(`<body>${intro}</body>`)('p').length,
      h2: $$('h2')
        .toArray()
        .map((e) => $$(e).text().trim()),
      hasConclusion: Boolean(conclusion),
      removedDuplicates: dedup.removed,
      removedSections,
    },
  };
}

function injectAfterFirstParagraph(html: string, insert: string): string {
  const idx = html.indexOf('</p>');
  return idx >= 0 ? html.slice(0, idx + 4) + insert + html.slice(idx + 4) : html + insert;
}

function injectBeforeLastParagraph(html: string, insert: string): string {
  const idx = html.lastIndexOf('<p');
  return idx > 0 ? html.slice(0, idx) + insert + html.slice(idx) : html + insert;
}

/** First paragraph text of an HTML article (for meta descriptions). */
export function firstParagraphText(html: string): string {
  const $ = load(`<body>${html}</body>`);
  const p = $('p')
    .toArray()
    .map((e) => $(e).text().replace(/\s+/g, ' ').trim())
    .find((t) => t.length > 40);
  return p ?? '';
}
