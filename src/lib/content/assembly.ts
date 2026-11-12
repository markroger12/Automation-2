import { load, type CheerioAPI } from 'cheerio';
import { sanitizeArticleHtml } from '../html/sanitize';
import { dedupeBlocks, sameTitle, WRITING_LABEL_RE } from './markdown';
import { matchMetaLine, type MetaLines } from './meta-lines';
import { profileHeadingAsH2 } from './profile-heading';
import { keepsAnswerOrder, profileTableFor } from '../writers/rules';

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
  /** Wrap every link's text in <strong> (Settings → Content → Bold links). */
  boldLinks?: boolean;
  /** The post title: a body heading that repeats it is removed (WordPress shows the title already). */
  title?: string | null;
}

export interface AssemblyResult {
  html: string;
  warnings: string[];
  /** SEO lines found in the article's introduction and taken out of it (an article saved before the parser read them). */
  meta: MetaLines;
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

/** In the answer, the FAQ section comes after the conclusion. */
function faqWrittenAfterConclusion(sections: Section[]): boolean {
  const faq = sections.findIndex((s) => FAQ_RE.test(s.heading));
  const conclusion = sections.findIndex((s) => CONCLUSION_RE.test(s.heading));
  return faq >= 0 && conclusion >= 0 && faq > conclusion;
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
 * main body (H2/H3) → FAQs → Conclusion → one final internal-link line (Celebrity 2: … → Conclusion → FAQs → line).
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
  // Owner report: “Writing” (the label of ChatGPT's writing block) stood under the title, the title was repeated as
  // the first H2, and so the Quick Bio landed before the introduction. Drafts saved before the fix are cleaned here too.
  $('p, div').filter((_, el) => WRITING_LABEL_RE.test($(el).text().trim()) && !$(el).find('p, h2, h3, table, ul, ol').length).remove();
  // Owner report (“Ricardo Joel Gomez”): “SEO Title: …”, “Meta Description: …” and “URL Slug: …” stood at the top of
  // the article. They are never article text: taken out of the introduction, their values go to the SEO fields.
  const meta: MetaLines = { seoTitle: null, metaDescription: null, slug: null };
  for (const el of $('body').children().toArray()) {
    if ($(el).is('h2')) break;
    if (!$(el).is('p')) continue;
    const hit = matchMetaLine($(el).text().replace(/\s+/g, ' ').trim());
    if (!hit) continue;
    if (hit.value && meta[hit.kind] === null) meta[hit.kind] = hit.value;
    $(el).remove();
  }
  if (input.title) {
    const first = $('body > h1, body > h2').first();
    if (first.length && sameTitle(first.text(), input.title)) first.remove();
  }
  // Celebrity 2 articles saved before the owner's report: their bold “Family Profile” line becomes the H2 (the
  // owner's person writers: their table's heading).
  const profile = profileTableFor(input.moduleKey, lang);
  if (profile) profileHeadingAsH2($, lang, 'table.bas-quick-bio', profile.heading);
  const split = splitSections($);
  let intro = split.intro;
  const sections = split.sections;
  const removedSections: string[] = [];
  // The Celebrity writer's Quick Bio and FAQs come from their own stages. Celebrity 2 writes both into its article:
  // its table stays where ChatGPT put it, and its FAQs follow the conclusion, as the owner's prompt orders them.
  const isCelebrity = input.moduleKey === 'celebrity-writer';
  // Celebrity 2 and the owner's writers: the answer's own order (their FAQs after the conclusion when written there).
  const ownOrder = keepsAnswerOrder(input.moduleKey);
  const faqAfterConclusion = ownOrder && (input.moduleKey === 'celebrity2-writer' || faqWrittenAfterConclusion(sections));
  const body: Section[] = [];
  let conclusion: Section | null = null;
  let modelFaq: Section | null = null;
  for (const s of sections) {
    // Celebrity 2's “Family Profile” H2 with its table, right after the introduction: it stays there, and the body
    // images keep their places among the article's own sections.
    if (ownOrder && !body.length && !conclusion && /\bbas-quick-bio\b/.test(s.html)) {
      intro += s.html;
      continue;
    }
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
  if (faqAfterConclusion) {
    if (conclusion) parts.push(conclusion.html);
    if (faqHtml) parts.push(faqHtml);
  } else {
    if (faqHtml) parts.push(faqHtml);
    if (conclusion) parts.push(conclusion.html);
  }
  if (input.internalLink) {
    parts.push(`<p data-bas-internal-link="1"><strong>${esc(input.internalLink.line)}</strong> <a href="${esc(input.internalLink.url)}">${esc(input.internalLink.title)}</a></p>`);
  }
  const joined = sanitizeArticleHtml(parts.join('\n'));
  const html = input.boldLinks ? boldenLinks(joined) : joined;
  const $$ = load(`<body>${html}</body>`);
  return {
    html,
    warnings,
    meta,
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

/** Every link's text in <strong>, unless the link is already bold (inside or around it). Idempotent. */
export function boldenLinks(html: string): string {
  const $ = load(`<body>${html}</body>`);
  let changed = false;
  $('a[href]').each((_, el) => {
    const a = $(el);
    if (!a.text().trim() || a.closest('strong, b').length || a.find('strong, b').length || a.find('img').length) return;
    a.html(`<strong>${a.html() ?? ''}</strong>`);
    changed = true;
  });
  return changed ? ($('body').html() ?? html) : html;
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
