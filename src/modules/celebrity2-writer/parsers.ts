import { load } from 'cheerio';
import { cleanModelMarkdown, markdownToHtml } from '@/lib/content/markdown';
import { stripTags, wordCount } from '@/lib/content/text';
import { FAQ_RE } from '@/lib/content/assembly';
import { parseTigramArticle } from '../tigram-writer/parsers';
import { parseQuickBio, type BioRow, type FaqItem } from '../celebrity-writer/parsers';

export interface Celebrity2Parse {
  seoTitle: string | null;
  metaDescription: string | null;
  slug: string | null;
  /** The article's own H1 (the title it was given); the post title stays the approved title. */
  h1: string | null;
  /** Article HTML without the H1: introduction, direct answer, Family Profile table, sections, conclusion, FAQs. */
  html: string;
  /** The same article as Markdown (stored as the stage output). */
  markdown: string;
  bioRows: BioRow[];
  /** The Family Profile table rebuilt as the clean two-column table (class bas-quick-bio), or null without a table. */
  bioHtml: string | null;
  faqs: FaqItem[];
  words: number;
  /** The answer cannot be used (a fresh prompt is sent). */
  problems: string[];
  /** Usable, but worth a look (review reasons). */
  warnings: string[];
}

/**
 * A fenced block that holds a table is unwrapped (owner: “give bio table in bio table format not in code form”), so
 * it becomes a real table and never a code block in the article.
 */
function unwrapFencedTables(md: string): string {
  return md.replace(/```[a-z]*\n([\s\S]*?)\n```/gi, (block, inner: string) => (/<table[\s>]/i.test(inner) || /^\s*\|.+\|\s*$/m.test(inner) ? inner.trim() : block));
}

/**
 * Parse the Celebrity 2 ARTICLE answer (owner's prompt, section 16 “Required output format”):
 *
 *   **SEO Title:** … / **Meta Description:** … / **URL Slug:** …
 *   # Title
 *   introduction, the direct answer (no heading), **Family Profile** + table, ## sections, ## Conclusion,
 *   ## Frequently Asked Questions with ### 1. … questions.
 *
 * Missing metadata lines are not a reason to ask again (the app fills them as for the Celebrity writer); a missing
 * article, Family Profile table or FAQ section is.
 */
export function parseCelebrity2Article(text: string, language: string, title?: string | null): Celebrity2Parse {
  const problems: string[] = [];
  const warnings: string[] = [];
  const meta = parseTigramArticle(text, language);
  const hasMeta = Boolean(meta.seoTitle || meta.metaDescription || meta.slug);
  // Without any metadata line the whole answer is the article.
  let body = hasMeta ? meta.body : text.replace(/\r\n/g, '\n').trim();
  if (!meta.seoTitle) warnings.push('The answer had no “SEO Title:” line; the approved title is used.');
  if (!meta.metaDescription) warnings.push('The answer had no “Meta Description:” line; one is taken from the introduction.');
  if (!meta.slug) warnings.push('The answer had no “URL Slug:” line; the slug is made from the keyword.');
  warnings.push(...meta.warnings.filter((w) => !/Meta description has/.test(w)));
  if (meta.metaDescription && (meta.metaDescription.length < 120 || meta.metaDescription.length > 130)) warnings.push(`Meta description has ${meta.metaDescription.length} characters (the prompt asks for 120–130).`);

  body = unwrapFencedTables(body);
  const h1Line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const h1 = h1Line && /^#\s+/.test(h1Line) ? h1Line.replace(/^#\s+/, '').replace(/\*\*/g, '').trim() : null;
  const markdown = cleanModelMarkdown(body, { title });
  let html = markdownToHtml(markdown);

  // The Family Profile table: the first table of the article, rebuilt as the app's clean two-column table.
  const $ = load(`<body>${html}</body>`);
  const table = $('table').first();
  let bioRows: BioRow[] = [];
  let bioHtml: string | null = null;
  if (table.length) {
    const parsed = parseQuickBio($.html(table), language, 12);
    const structural = parsed.problems.filter((p) => /columns|No table rows/.test(p));
    if (parsed.rows.length && !structural.length) {
      bioRows = parsed.rows;
      bioHtml = parsed.html;
      table.replaceWith(parsed.html);
      html = $('body').html() ?? html;
    } else problems.push(`The Family Profile table is malformed (${structural[0] ?? 'no rows'}).`);
  } else problems.push('The Family Profile table is missing.');

  // FAQs: the H3 questions under the FAQ heading (their “1.” numbering is kept in the article as written).
  const $$ = load(`<body>${html}</body>`);
  const faqs: FaqItem[] = [];
  const faqH2 = $$('h2')
    .toArray()
    .find((e) => FAQ_RE.test($$(e).text().trim()));
  if (faqH2) {
    let n = $$(faqH2).next();
    let current: FaqItem | null = null;
    while (n.length && !n.is('h2')) {
      if (n.is('h3')) {
        current = { question: n.text().replace(/^\s*\d{1,2}[.)]\s*/, '').replace(/\s+/g, ' ').trim(), answer: '' };
        faqs.push(current);
      } else if (current && n.is('p')) current.answer = `${current.answer} ${n.text()}`.replace(/\s+/g, ' ').trim();
      n = n.next();
    }
  }
  if (!faqH2) problems.push('The “Frequently Asked Questions” section is missing.');
  else if (faqs.length !== 5) warnings.push(`${faqs.length} FAQs instead of exactly five.`);
  if (!$$('h2').toArray().some((e) => /^(conclusion|fazit)\b/i.test($$(e).text().trim()))) warnings.push('No “Conclusion” section was found.');

  const words = wordCount(stripTags(html));
  if (words < 400) problems.push(`The article had only ${words} words.`);
  return {
    seoTitle: meta.seoTitle,
    metaDescription: meta.metaDescription,
    slug: meta.slug,
    h1,
    html,
    markdown,
    bioRows,
    bioHtml,
    faqs: faqs.filter((f) => f.question && f.answer),
    words,
    problems,
    warnings,
  };
}
