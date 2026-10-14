import { describe, expect, it } from 'vitest';
import { parseFaqs, parseQuickBio, parseTitles, confirmedFullName, analyzeResearch } from '@/modules/celebrity-writer/parsers';
import { cleanModelMarkdown, markdownToHtml, dedupeBlocks } from '@/lib/content/markdown';
import { sanitizeArticleHtml } from '@/lib/html/sanitize';
import { assembleArticle } from '@/lib/content/assembly';
import { runSeoChecks, type SeoInput } from '@/lib/seo/checks';
import { evaluateQuality } from '@/lib/quality/gate';
import { countExact, countNormalized, detectLanguage, makeSlug, parseSecondaryKeywords } from '@/lib/content/text';
import { normalizeResponseText } from '@/lib/chatgpt/normalize';

describe('celebrity parsers', () => {
  it('parses numbered titles and the Recommended Title line', () => {
    const r = parseTitles('Here are options:\n1. **Sydney Sweeney: Rise of a Star**\n2) "Sydney Sweeney Biography"\n- Sydney Sweeney Net Worth Explained\n\nRecommended Title: Sydney Sweeney: Rise of a Star');
    expect(r.recommended).toBe('Sydney Sweeney: Rise of a Star');
    expect(r.options).toEqual(['Sydney Sweeney: Rise of a Star', 'Sydney Sweeney Biography', 'Sydney Sweeney Net Worth Explained']);
    expect(parseTitles('no titles here').recommended).toBeNull();
  });

  it('parses QUESTION/ANSWER pairs, including German labels', () => {
    const faqs = parseFaqs('QUESTION: How old is she?\nANSWER: She was born in 1997.\n\nQUESTION: Where is she from\nANSWER: Spokane, Washington.');
    expect(faqs).toEqual([
      { question: 'How old is she?', answer: 'She was born in 1997.' },
      { question: 'Where is she from?', answer: 'Spokane, Washington.' },
    ]);
    expect(parseFaqs('FRAGE: Wie alt?\nANTWORT: 28 Jahre.')).toHaveLength(1);
  });

  it('rebuilds a clean two-column Quick Bio and flags malformed tables', () => {
    const ok = parseQuickBio('<table><tr><th>Attribute</th><th>Details</th></tr><tr><td>Full Name</td><td>Sydney Bernice Sweeney</td></tr><tr><td>Height</td><td>N/A</td></tr></table>', 'en', 3);
    expect(ok.rows).toEqual([
      { attribute: 'Full Name', details: 'Sydney Bernice Sweeney' },
      { attribute: 'Height', details: 'Not publicly confirmed' },
    ]);
    expect(ok.html).toContain('<thead><tr><th>Attribute</th><th>Details</th></tr></thead>');
    expect(confirmedFullName(ok.rows)).toBe('Sydney Bernice Sweeney');
    const md = parseQuickBio('| Attribute | Details |\n|---|---|\n| Beruf | Schauspielerin |\n| Größe | unbekannt |', 'de', 2);
    expect(md.rows[1].details).toBe('Nicht öffentlich bestätigt');
    expect(md.html).toContain('<th>Merkmal</th><th>Angaben</th>');
    const bad = parseQuickBio('<table><tr><td>A</td><td>B</td><td>C</td></tr></table>', 'en', 12);
    expect(bad.problems.some((p) => /3 columns/.test(p))).toBe(true);
    expect(confirmedFullName([{ attribute: 'Full Name', details: 'Not publicly confirmed' }])).toBeNull();
  });

  it('extracts research sources and uncertainty without touching the article', () => {
    const r = analyzeResearch('Born 1997 (https://example.org/bio).\nWedding date is unconfirmed.\nNet worth is an estimate of $40M.');
    expect(r.sources.map((s) => s.url)).toEqual(['https://example.org/bio']);
    expect(r.uncertain).toHaveLength(1);
    expect(r.estimates).toHaveLength(1);
  });
});

describe('markdown, sanitizing and cleanup', () => {
  it('removes fences, duplicate titles and chatbot commentary', () => {
    const md = cleanModelMarkdown('```markdown\n# My Title\nHere is the revised article:\nIntro text.\n\n## Section\nBody.\n```', { title: 'My Title' });
    expect(md).toBe('Intro text.\n\n## Section\nBody.');
  });

  it('never keeps scripts, handlers or javascript: links', () => {
    const html = sanitizeArticleHtml('<p onclick="x()">Hi<script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://ok.example">ok</a></p><iframe src="https://x"></iframe><style>p{}</style>');
    expect(html).not.toMatch(/script|onclick|javascript:|iframe|style/i);
    expect(html).toContain('<a href="https://ok.example" rel="noopener">ok</a>');
    expect(markdownToHtml('| a | b |\n|---|---|\n| 1 | 2 |')).toContain('<table>');
  });

  it('removes duplicate paragraphs but keeps the first', () => {
    const r = dedupeBlocks('<p>Same text here for sure.</p><p>Other paragraph text.</p><p>Same   text here for sure.</p>');
    expect(r.removed).toBe(1);
    expect(r.html).toBe('<p>Same text here for sure.</p><p>Other paragraph text.</p>');
  });

  it('normalizes ChatGPT answers (preambles, citation tokens, single fence)', () => {
    expect(normalizeResponseText('Sure! Here is the article you asked for:\n\n## Title\nText citeturn0search1 more.\n\nLet me know if you want changes.')).toBe('## Title\nText  more.');
    expect(normalizeResponseText('```\nQUESTION: a?\nANSWER: b\n```')).toBe('QUESTION: a?\nANSWER: b');
  });
});

describe('assembly order and placement', () => {
  const body = '<p>Intro paragraph about the topic.</p><h2>Early Life</h2><p>A.</p><h2>Career</h2><p>B.</p><h2>FAQ</h2><h3>Q?</h3><p>x</p><h2>Conclusion</h2><p>End.</p>';
  it('orders intro → Quick Bio → body → FAQs → conclusion → internal link and removes model-added FAQ sections', () => {
    const r = assembleArticle({
      bodyHtml: body,
      language: 'en',
      moduleKey: 'celebrity-writer',
      quickBioHtml: '<table class="bas-quick-bio"><thead><tr><th>Attribute</th><th>Details</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table>',
      quickBioName: null,
      faqs: [{ question: 'Who?', answer: 'Someone.' }],
      internalLink: { line: 'Also read:', url: 'https://site.example/other', title: 'Other' },
      images: [
        { slot: 'BODY1', html: '<figure><img src="https://x/1.webp" alt="one"></figure>' },
        { slot: 'BODY2', html: '<figure><img src="https://x/2.webp" alt="two"></figure>' },
      ],
    });
    const h = r.html;
    const order = ['Intro paragraph', '<h2>Quick Bio</h2>', '<h2>Early Life</h2>', 'alt="one"', '<h2>Career</h2>', 'alt="two"', '<h2>Frequently Asked Questions</h2>', '<h2>Conclusion</h2>', 'data-bas-internal-link'];
    const idx = order.map((s) => h.indexOf(s));
    expect(idx.every((v) => v >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(r.structure.removedSections).toEqual(['FAQ']);
    expect((h.match(/data-bas-internal-link/g) ?? []).length).toBe(1);
  });

  it('re-assembly never duplicates the internal-link line', () => {
    const first = assembleArticle({ bodyHtml: body, language: 'de', moduleKey: 'tigram-writer', internalLink: { line: 'Das könnte Ihnen gefallen:', url: 'https://s/x', title: 'X' } });
    const second = assembleArticle({ bodyHtml: first.html, language: 'de', moduleKey: 'tigram-writer', internalLink: { line: 'Das könnte Ihnen gefallen:', url: 'https://s/x', title: 'X' } });
    expect((second.html.match(/data-bas-internal-link/g) ?? []).length).toBe(1);
    expect(second.html).toContain('<h2>Häufig gestellte Fragen</h2>');
  });
});

describe('SEO checks and quality gate', () => {
  const base: Omit<SeoInput, 'html'> = {
    moduleKey: 'celebrity-writer',
    language: 'en',
    keyword: 'Sydney Sweeney',
    title: 'Sydney Sweeney: Career and Life',
    seoTitle: 'Sydney Sweeney: Career and Life',
    metaDescription: 'Sydney Sweeney is an American actress known for Euphoria. Here is a careful look at her career, family background and recent projects.',
    slug: 'sydney-sweeney',
    categoryName: 'Celebrities',
    tags: ['Sydney Sweeney'],
    expectedFaqCount: 2,
    quickBioRows: 3,
    maxWords: 1300,
    wordRange: null,
    minKeywordOccurrences: 15,
    maxKeywordOccurrences: 18,
    densityCeilingPct: 2.5,
    externalLinksEnabled: false,
    internalLinksEnabled: false,
    imagesExpected: false,
  };
  const topics = ['television drama', 'independent film', 'stage work', 'producing', 'voice acting', 'fashion campaigns', 'charity events', 'press tours', 'festival premieres', 'award shows', 'streaming series', 'comedy roles'];
  let n = 0;
  const filler = () => topics.map((t) => `In project ${++n} she focused on ${t} and earned steady praise from critics for consistent, careful work.`).join(' ');
  const article = () => `<p>Sydney Sweeney is an actress. ${filler()}</p><table class="bas-quick-bio"><thead><tr><th>Attribute</th><th>Details</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr><tr><td>E</td><td>F</td></tr></tbody></table><h2>Sydney Sweeney Early Life</h2><p>${filler()}</p><p>${filler()}</p><h2>Career</h2><p>${filler()}</p><p>${filler()}</p><h2>Frequently Asked Questions</h2><h3>Q1?</h3><p>A.</p><h3>Q2?</h3><p>B.</p><h2>Conclusion</h2><p>Sydney Sweeney remains busy. ${filler()}</p>`;

  it('passes a well-formed article and reports transparent metrics', () => {
    const r = runSeoChecks({ ...base, html: article() });
    const failedErrors = r.checks.filter((c) => !c.passed && c.severity === 'error').map((c) => c.id);
    expect(failedErrors).toEqual([]);
    expect(r.metrics.faqCount).toBe(2);
    expect(r.metrics.quickBioRows).toBe(3);
    expect(r.score).toBeGreaterThanOrEqual(85);
  });

  it('flags keyword stuffing as a hard stop and wrong FAQ count / short meta as failures', () => {
    const stuffed = `<p>${'Sydney Sweeney Sydney Sweeney is here. '.repeat(40)}</p><h2>Frequently Asked Questions</h2><h3>Q?</h3><p>A</p>`;
    const seo = runSeoChecks({ ...base, html: stuffed, metaDescription: 'short' });
    expect(seo.checks.find((c) => c.id === 'keyword-density')!.passed).toBe(false);
    expect(seo.checks.find((c) => c.id === 'meta-length')!.passed).toBe(false);
    expect(seo.checks.find((c) => c.id === 'faq-count')!.passed).toBe(false);
    const q = evaluateQuality({ html: stuffed, moduleKey: 'celebrity-writer', language: 'en', keyword: 'Sydney Sweeney', seo, reviewThreshold: 70, densityCeilingPct: 2.5, expectedFaqCount: 2, categoryValid: true, assemblyWarnings: [], imagesRequired: false, imagesPresent: 0 });
    expect(q.passed).toBe(false);
    expect(q.hardStops.map((h) => h.code)).toEqual(expect.arrayContaining(['KEYWORD_STUFFING', 'BIO_MISSING']));
  });

  it('detects the wrong language and unpublishable model text', () => {
    const english = `<p>${'The actress has been working on many projects and she is known for her roles in the series. '.repeat(10)}As an AI language model I cannot verify this.</p><h2>Häufig gestellte Fragen</h2><h3>F?</h3><p>A</p>`;
    const seo = runSeoChecks({ ...base, language: 'de', html: english });
    const q = evaluateQuality({ html: english, moduleKey: 'tigram-writer', language: 'de', keyword: 'Sydney Sweeney', seo, reviewThreshold: 70, densityCeilingPct: 2.5, expectedFaqCount: 7, categoryValid: true, assemblyWarnings: [], imagesRequired: false, imagesPresent: 0 });
    expect(q.hardStops.map((h) => h.code)).toEqual(expect.arrayContaining(['WRONG_LANGUAGE', 'UNPUBLISHABLE_TEXT']));
  });
});

describe('text utilities', () => {
  it('counts exact and normalized keyword mentions (incl. possessive/plural)', () => {
    const t = "Sydney Sweeney's role. sydney sweeney appeared. The Sydney Sweeneys? Not SydneySweeney.";
    expect(countExact(t, 'Sydney Sweeney')).toBe(2); // "Sweeneys" is not an exact match
    expect(countNormalized(t, 'Sydney Sweeney')).toBe(3);
  });
  it('detects English vs German and builds German slugs', () => {
    expect(detectLanguage('Die Schauspielerin ist bekannt und sie hat mit vielen Regisseuren gearbeitet, die ihre Arbeit schätzen und auch für den Film ausgezeichnet wurden. Sie ist auf dem Weg nach oben und der Erfolg ist da.').language).toBe('de');
    expect(makeSlug('Größe & Ehemann von Jürgen Klopp', 'de')).toBe('groesse-ehemann-von-juergen-klopp');
  });
  it('parses secondary keywords in order without duplicates', () => {
    expect(parseSecondaryKeywords('b, a\n B \n c;a')).toEqual(['b', 'a', 'c']);
  });
});
