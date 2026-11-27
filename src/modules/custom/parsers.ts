import { load } from 'cheerio';
import { cleanModelMarkdown, markdownToHtml } from '@/lib/content/markdown';
import { stripTags, wordCount } from '@/lib/content/text';
import { CONCLUSION_RE, FAQ_RE } from '@/lib/content/assembly';
import { profileHeadingAsH2 } from '@/lib/content/profile-heading';
import type { CustomWriterConfig, WriterBase } from '@/lib/writers/types';
import { parseTigramArticle } from '../tigram-writer/parsers';
import { parseQuickBio, type BioRow, type FaqItem } from '../celebrity-writer/parsers';

export interface CustomArticleParse {
  seoTitle: string | null;
  metaDescription: string | null;
  slug: string | null;
  /** The article's own H1 (the post title when the writer has no title step). */
  h1: string | null;
  html: string;
  markdown: string;
  bioRows: BioRow[];
  bioHtml: string | null;
  faqs: FaqItem[];
  words: number;
  h2: string[];
  /** The answer cannot be used (a fresh prompt is sent). */
  problems: string[];
  /** Usable, but worth a look (review reasons). */
  warnings: string[];
}

/** A fenced block that holds a table becomes the table (never a code block in the article). */
function unwrapFencedTables(md: string): string {
  return md.replace(/```[a-z]*\n([\s\S]*?)\n```/gi, (block, inner: string) => (/<table[\s>]/i.test(inner) || /^\s*\|.+\|\s*$/m.test(inner) ? inner.trim() : block));
}

/**
 * The ARTICLE answer of a writer the owner built (Writers → a writer → Test reads an answer the same way). What it must
 * contain comes from the writer's rules: a missing article, a required facts table or the FAQ section (when FAQs are
 * asked for) means a fresh prompt; counts and lengths outside the rules are review notes. SEO lines are read in both
 * forms (value on the label's line or on the next one); missing ones are filled by the app.
 */
export function parseCustomArticle(text: string, language: string, title: string | null | undefined, opts: { base: WriterBase; rules: CustomWriterConfig['rules'] }): CustomArticleParse {
  const problems: string[] = [];
  const warnings: string[] = [];
  const r = opts.rules;
  const meta = parseTigramArticle(text, language);
  if (r.seoLines) {
    if (!meta.seoTitle) warnings.push('The answer had no “SEO Title:” line; the title is used.');
    if (!meta.metaDescription) warnings.push('The answer had no “Meta Description:” line; one is taken from the introduction.');
    if (!meta.slug) warnings.push('The answer had no “URL Slug:” line; the slug is made from the keyword.');
  }
  warnings.push(...meta.warnings.filter((w) => !/Meta description has/.test(w)));
  if (meta.metaDescription && (meta.metaDescription.length < 110 || meta.metaDescription.length > 160)) warnings.push(`Meta description has ${meta.metaDescription.length} characters (110–160 is best).`);

  const body = unwrapFencedTables(meta.body);
  const h1Line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const h1 = h1Line && /^#\s+/.test(h1Line) ? h1Line.replace(/^#\s+/, '').replace(/\*\*/g, '').trim() : null;
  const markdown = cleanModelMarkdown(body, { title: title ?? h1 });
  let html = markdownToHtml(markdown);

  // Person writers: the facts table about the person, rebuilt as the app's clean two-column table under its H2.
  let bioRows: BioRow[] = [];
  let bioHtml: string | null = null;
  const heading = (language === 'de' ? r.tableHeadingDe : r.tableHeading) || r.tableHeading || 'Family Profile';
  if (opts.base === 'person' && r.table !== 'none') {
    const $ = load(`<body>${html}</body>`);
    const table = $('table').first();
    if (table.length) {
      profileHeadingAsH2($, language, 'table', heading);
      const parsed = parseQuickBio($.html(table), language, 12);
      const structural = parsed.problems.filter((p) => /columns|No table rows/.test(p));
      if (parsed.rows.length && !structural.length) {
        bioRows = parsed.rows;
        bioHtml = parsed.html;
        table.replaceWith(parsed.html);
        html = $('body').html() ?? html;
      } else (r.table === 'required' ? problems : warnings).push(`The ${heading} table is malformed (${structural[0] ?? 'no rows'}).`);
    } else if (r.table === 'required') problems.push(`The ${heading} table is missing.`);
  }

  const $$ = load(`<body>${html}</body>`);
  const h2 = $$('h2')
    .toArray()
    .map((e) => $$(e).text().replace(/\s+/g, ' ').trim());
  const faqs: FaqItem[] = [];
  const faqH2 = $$('h2')
    .toArray()
    .find((e) => FAQ_RE.test($$(e).text().trim()));
  if (faqH2) {
    let n = $$(faqH2).next();
    let current: FaqItem | null = null;
    while (n.length && !n.is('h2')) {
      if (n.is('h3') || (n.is('p') && n.children('strong').length === 1 && /\?\s*$/.test(n.text().trim()) && n.text().trim() === n.children('strong').text().trim())) {
        current = { question: n.text().replace(/^\s*(?:Q\s*\d*[:.)]|\d{1,2}[.)])\s*/i, '').replace(/\s+/g, ' ').trim(), answer: '' };
        faqs.push(current);
      } else if (current && n.is('p')) current.answer = `${current.answer} ${n.text()}`.replace(/\s+/g, ' ').trim();
      n = n.next();
    }
  }
  const usable = faqs.filter((f) => f.question && f.answer);
  if (r.faqCount > 0) {
    if (!faqH2) problems.push('The “Frequently Asked Questions” section is missing.');
    else if (r.exactFaqs ? usable.length !== r.faqCount : Math.abs(usable.length - r.faqCount) > 2) warnings.push(`${usable.length} FAQs instead of ${r.exactFaqs ? 'exactly' : 'about'} ${r.faqCount}.`);
  }
  if (r.conclusion && !h2.some((t) => CONCLUSION_RE.test(t))) warnings.push('No “Conclusion” section was found.');
  if (r.noLists && $$('ul, ol').length) warnings.push(`${$$('ul, ol').length} bullet or numbered list(s) in the article (the writer asks for prose).`);
  if (h2.filter((t) => !FAQ_RE.test(t) && !CONCLUSION_RE.test(t)).length < 2) warnings.push('Fewer than two H2 sections besides the FAQs and the conclusion.');

  const words = wordCount(stripTags(html));
  if (words < Math.max(250, Math.round(r.wordMin * 0.4))) problems.push(`The article had only ${words} words (the writer asks for ${r.wordMin}–${r.wordMax}).`);
  else if (words < r.wordMin * 0.85 || words > r.wordMax * 1.2) warnings.push(`${words} words (the writer asks for ${r.wordMin}–${r.wordMax}).`);
  return { seoTitle: meta.seoTitle, metaDescription: meta.metaDescription, slug: meta.slug, h1, html, markdown, bioRows, bioHtml, faqs: usable, words, h2, problems, warnings };
}
