import { load } from 'cheerio';
import { countExact, countNormalized, normalizeText, sentences, stripTags, wordCount, words } from '../content/text';
import { CONCLUSION_RE, FAQ_RE } from '../content/assembly';

export interface SeoInput {
  html: string;
  moduleKey: string;
  language: string;
  keyword: string;
  title: string | null;
  seoTitle: string | null;
  metaDescription: string | null;
  slug: string | null;
  categoryName: string | null;
  tags: string[];
  expectedFaqCount: number;
  quickBioRows: number;
  maxWords: number;
  wordRange: [number, number] | null;
  minKeywordOccurrences: number;
  maxKeywordOccurrences: number;
  densityCeilingPct: number;
  externalLinksEnabled: boolean;
  internalLinksEnabled: boolean;
  imagesExpected: boolean;
}

export interface SeoCheck {
  id: string;
  label: string;
  passed: boolean;
  /** "error" counts toward the score; "warning" is advisory; "info" never fails. */
  severity: 'error' | 'warning' | 'info';
  weight: number;
  detail: string;
  fix?: string;
}

export interface SeoMetrics {
  words: number;
  sections: { heading: string; words: number }[];
  h2: number;
  h3: number;
  paragraphs: number;
  shortParagraphs: number;
  longParagraphs: number;
  keywordExact: number;
  keywordNormalized: number;
  densityPct: number;
  seoTitleLength: number;
  metaLength: number;
  faqCount: number;
  quickBioRows: number | null;
  quickBioColumnsOk: boolean | null;
  externalLinks: number;
  internalLinkLine: boolean;
  images: number;
  imagesWithAlt: number;
  listsInNarrative: number;
  emptyHeadings: number;
  duplicateSentences: number;
}

export interface SeoReport {
  score: number;
  checks: SeoCheck[];
  metrics: SeoMetrics;
}

/**
 * Transparent weighted on-page checks. The score is a heuristic readiness
 * signal — NOT factual accuracy and NOT a Rank Math score. Keyword targets are
 * advisory: the checker never asks for unnatural repetition.
 */
export function runSeoChecks(input: SeoInput): SeoReport {
  const $ = load(`<body>${input.html}</body>`);
  const de = input.language === 'de';
  const text = stripTags(input.html);
  const totalWords = wordCount(text);
  const kw = input.keyword.trim();
  const keywordExact = countExact(text, kw);
  const keywordNormalized = countNormalized(text, kw);
  const kwWords = Math.max(1, words(kw).length);
  const densityPct = totalWords ? (keywordNormalized * kwWords * 100) / totalWords : 0;

  const h2 = $('h2').toArray();
  const h3 = $('h3').toArray();
  const paragraphs = $('p').not('[data-bas-internal-link]').toArray();
  const paraWords = paragraphs.map((p) => wordCount($(p).text()));
  const shortParagraphs = paraWords.filter((w) => w > 0 && w < 12).length;
  const longParagraphs = paraWords.filter((w) => w > 160).length;
  const sections: SeoMetrics['sections'] = [];
  let currentHeading = de ? 'Einleitung' : 'Introduction';
  let currentWords = 0;
  $('body')
    .children()
    .each((_, el) => {
      if (el.tagName === 'h2') {
        sections.push({ heading: currentHeading, words: currentWords });
        currentHeading = $(el).text().trim();
        currentWords = 0;
      } else currentWords += wordCount($(el).text());
    });
  sections.push({ heading: currentHeading, words: currentWords });

  const firstWords = words(text).slice(0, 100).join(' ');
  const inIntro = countNormalized(firstWords, kw) > 0;
  const headingsText = [...h2, ...h3].map((e) => $(e).text()).join(' \n ');
  const inHeading = countNormalized(headingsText, kw) > 0 || (kwWords > 1 && words(kw).filter((w) => normalizeText(headingsText).includes(w.toLowerCase())).length >= Math.ceil(kwWords * 0.6));
  const conclusionH2 = h2.find((e) => CONCLUSION_RE.test($(e).text().trim()));
  let conclusionText = '';
  if (conclusionH2) {
    let n = $(conclusionH2).next();
    while (n.length && !n.is('h2')) {
      conclusionText += ' ' + n.text();
      n = n.next();
    }
  }
  const seoTitle = input.seoTitle ?? input.title ?? '';
  const inTitle = countNormalized(seoTitle, kw) > 0;
  const slug = input.slug ?? '';
  const slugTokens = new Set(slug.split('-'));
  const kwSlugTokens = normalizeText(kw)
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .split(' ')
    .map((t) => t.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ''))
    .filter(Boolean);
  const slugHits = kwSlugTokens.filter((t) => slugTokens.has(t)).length;
  const meta = input.metaDescription ?? '';

  // FAQ count: celebrity = H3s after the FAQ H2; Tigram = H3s under the FAQ H2.
  const faqH2 = h2.find((e) => FAQ_RE.test($(e).text().trim()));
  let faqCount = 0;
  if (faqH2) {
    let n = $(faqH2).next();
    while (n.length && !n.is('h2')) {
      if (n.is('h3')) faqCount++;
      n = n.next();
    }
  }
  const bioTable = $('table.bas-quick-bio').first();
  const quickBioRows = bioTable.length ? bioTable.find('tbody tr').length : null;
  const quickBioColumnsOk = bioTable.length ? bioTable.find('tr').toArray().every((tr) => $(tr).children('th,td').length === 2) : null;
  const links = $('a[href]').toArray();
  const externalLinks = links.filter((a) => /^https?:\/\//i.test($(a).attr('href') ?? '') && !$(a).closest('p[data-bas-internal-link]').length && !$(a).attr('data-bas-link')?.startsWith('internal')).length;
  const internalLinkLine = $('p[data-bas-internal-link]').length === 1;
  const imgs = $('img').toArray();
  const imagesWithAlt = imgs.filter((i) => ($(i).attr('alt') ?? '').trim().length >= 5).length;
  const listsInNarrative = input.moduleKey === 'celebrity-writer' ? $('ul,ol').length : 0;
  const emptyHeadings = [...h2, ...h3].filter((e) => !$(e).text().trim()).length;
  const sentenceList = sentences(text).map((s) => normalizeText(s)).filter((s) => s.split(' ').length >= 6);
  const duplicateSentences = sentenceList.length - new Set(sentenceList).size;

  const minWords = input.wordRange ? Math.round(input.wordRange[0] * 0.85) : Math.min(600, Math.round(input.maxWords * 0.5));
  const maxWords = input.wordRange ? Math.round(input.wordRange[1] * 1.15) : Math.round(input.maxWords * 1.1);
  // Advisory occurrence target scales down for shorter articles (never a reason to stuff).
  const scale = Math.min(1, totalWords / 1300);
  const advisoryMin = Math.max(3, Math.round(input.minKeywordOccurrences * scale));
  const advisoryMax = Math.max(advisoryMin + 2, Math.round(input.maxKeywordOccurrences * Math.max(scale, 0.6)));
  const metaRange: [number, number] = input.moduleKey === 'tigram-writer' ? [100, 150] : de ? [110, 160] : [120, 160];

  const checks: SeoCheck[] = [
    { id: 'seo-title-length', label: 'SEO title under 60 characters', passed: seoTitle.length > 0 && seoTitle.length <= 60, severity: 'error', weight: 8, detail: `${seoTitle.length} characters`, fix: 'Shorten the SEO title while keeping the keyword near the start.' },
    { id: 'keyword-in-title', label: 'Keyword in SEO title', passed: inTitle, severity: 'error', weight: 8, detail: inTitle ? 'Present' : 'Not found', fix: 'Use the focus keyword naturally in the SEO title.' },
    { id: 'meta-length', label: `Meta description ${metaRange[0]}–${metaRange[1]} characters`, passed: meta.length >= metaRange[0] && meta.length <= metaRange[1], severity: 'error', weight: 8, detail: `${meta.length} characters`, fix: 'Write a specific meta description within the range.' },
    { id: 'slug', label: 'Readable lowercase slug with the keyword', passed: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slugHits >= Math.ceil(kwSlugTokens.length * 0.5), severity: 'error', weight: 6, detail: slug || '(empty)', fix: 'Use lowercase words of the keyword separated by hyphens.' },
    { id: 'keyword-in-intro', label: 'Keyword in the first 100 words', passed: inIntro, severity: 'error', weight: 10, detail: inIntro ? 'Present' : 'Not in the introduction', fix: 'Mention the keyword naturally in the opening paragraph.' },
    { id: 'keyword-in-heading', label: 'Keyword (or most of it) in an H2/H3', passed: inHeading, severity: 'error', weight: 6, detail: inHeading ? 'Present' : 'No heading mentions it', fix: 'Use the keyword in one relevant heading where it reads naturally.' },
    { id: 'keyword-in-conclusion', label: 'Keyword in the conclusion', passed: !conclusionH2 ? false : countNormalized(conclusionText, kw) > 0, severity: 'warning', weight: 4, detail: conclusionH2 ? 'Checked conclusion section' : 'No conclusion section', fix: 'Refer back to the topic in the conclusion.' },
    { id: 'keyword-density', label: `Keyword density ≤ ${input.densityCeilingPct}% (no stuffing)`, passed: densityPct <= input.densityCeilingPct, severity: 'error', weight: 8, detail: `${densityPct.toFixed(2)}% (${keywordNormalized} mentions / ${totalWords} words)`, fix: 'Replace some repetitions with natural variations or pronouns.' },
    { id: 'keyword-occurrences', label: `Keyword mentions about ${advisoryMin}–${advisoryMax} (advisory)`, passed: keywordNormalized >= advisoryMin && keywordNormalized <= advisoryMax, severity: 'warning', weight: 4, detail: `${keywordExact} exact, ${keywordNormalized} normalized`, fix: 'Advisory only — never add unnatural mentions to hit a number.' },
    { id: 'word-count', label: input.wordRange ? `Word count ${input.wordRange[0]}–${input.wordRange[1]}` : `Word count ≤ ${input.maxWords}`, passed: totalWords >= minWords && totalWords <= maxWords, severity: 'error', weight: 8, detail: `${totalWords} words`, fix: 'Regenerate or edit the article to the configured length.' },
    { id: 'headings', label: input.moduleKey === 'tigram-writer' ? '5–7 H2 sections (excluding FAQ/conclusion)' : 'At least 3 H2 sections', passed: input.moduleKey === 'tigram-writer' ? h2.length - (faqH2 ? 1 : 0) - (conclusionH2 ? 1 : 0) >= 5 && h2.length - (faqH2 ? 1 : 0) - (conclusionH2 ? 1 : 0) <= 7 : h2.length >= 3, severity: 'error', weight: 6, detail: `${h2.length} H2, ${h3.length} H3`, fix: 'Use clear H2 sections with H3 subheadings where useful.' },
    { id: 'heading-hierarchy', label: 'No empty headings; H3 only under H2', passed: emptyHeadings === 0 && !($('body').children().first().is('h3')), severity: 'error', weight: 3, detail: `${emptyHeadings} empty`, fix: 'Remove empty headings and keep H3 under an H2.' },
    { id: 'paragraph-length', label: 'Paragraph lengths readable', passed: longParagraphs === 0 && shortParagraphs <= Math.max(2, paragraphs.length * 0.15), severity: 'warning', weight: 4, detail: `${shortParagraphs} very short, ${longParagraphs} very long of ${paragraphs.length}`, fix: 'Split very long paragraphs; merge one-line fragments.' },
    { id: 'duplicates', label: 'No duplicated sentences', passed: duplicateSentences === 0, severity: 'error', weight: 4, detail: `${duplicateSentences} duplicated`, fix: 'Remove repeated sentences.' },
    { id: 'faq-count', label: input.moduleKey === 'celebrity-writer' ? `Exactly ${input.expectedFaqCount} FAQs` : `About ${input.expectedFaqCount} FAQ questions`, passed: input.moduleKey === 'celebrity-writer' ? faqCount === input.expectedFaqCount : Math.abs(faqCount - input.expectedFaqCount) <= 2 && faqCount > 0, severity: 'error', weight: 6, detail: `${faqCount} found`, fix: 'Regenerate the FAQ stage.' },
    ...(input.moduleKey === 'celebrity-writer'
      ? [
          {
            id: 'quick-bio',
            label: `Two-column Quick Bio with ${input.quickBioRows - 1}–${input.quickBioRows + 1} rows`,
            passed: quickBioColumnsOk === true && quickBioRows !== null && quickBioRows >= input.quickBioRows - 2 && quickBioRows <= input.quickBioRows + 2,
            severity: 'error' as const,
            weight: 6,
            detail: quickBioRows === null ? 'Missing' : `${quickBioRows} rows${quickBioColumnsOk ? '' : ', wrong column count'}`,
            fix: 'Regenerate the Quick Bio stage.',
          },
          { id: 'no-lists', label: 'No bullet/numbered lists in the narrative', passed: listsInNarrative === 0, severity: 'warning' as const, weight: 3, detail: `${listsInNarrative} list(s)`, fix: 'Rewrite lists as prose paragraphs.' },
        ]
      : []),
    { id: 'category', label: 'Category assigned', passed: Boolean(input.categoryName), severity: 'error', weight: 3, detail: input.categoryName ?? 'None', fix: 'Choose one existing category.' },
    { id: 'tags', label: 'Tags set', passed: input.tags.length > 0, severity: 'warning', weight: 2, detail: input.tags.join(', ') || 'None' },
    { id: 'external-links', label: 'Verified external links', passed: !input.externalLinksEnabled || externalLinks > 0, severity: 'warning', weight: 3, detail: `${externalLinks} link(s)`, fix: 'No verified link passed; add authoritative sources manually if useful.' },
    { id: 'internal-link-line', label: 'Exactly one internal-link line at the end', passed: !input.internalLinksEnabled || internalLinkLine, severity: 'warning', weight: 3, detail: internalLinkLine ? 'Present' : 'Missing', fix: 'Add a related article from this site.' },
    { id: 'image-alt', label: 'Images have descriptive alt text', passed: imgs.length === imagesWithAlt && (!input.imagesExpected || imgs.length > 0), severity: imgs.length ? 'error' : 'warning', weight: 3, detail: `${imagesWithAlt}/${imgs.length} with alt text`, fix: 'Add descriptive alt text (not keyword stuffing).' },
  ];
  const scored = checks.filter((c) => c.severity !== 'info');
  const total = scored.reduce((s, c) => s + c.weight, 0);
  const passed = scored.filter((c) => c.passed).reduce((s, c) => s + c.weight, 0);
  return {
    score: total ? Math.round((passed / total) * 100) : 0,
    checks,
    metrics: {
      words: totalWords,
      sections,
      h2: h2.length,
      h3: h3.length,
      paragraphs: paragraphs.length,
      shortParagraphs,
      longParagraphs,
      keywordExact,
      keywordNormalized,
      densityPct: Number(densityPct.toFixed(2)),
      seoTitleLength: seoTitle.length,
      metaLength: meta.length,
      faqCount,
      quickBioRows,
      quickBioColumnsOk,
      externalLinks,
      internalLinkLine,
      images: imgs.length,
      imagesWithAlt,
      listsInNarrative,
      emptyHeadings,
      duplicateSentences,
    },
  };
}
