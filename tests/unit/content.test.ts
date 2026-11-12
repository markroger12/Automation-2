import { describe, expect, it } from 'vitest';
import { parseFaqs, parseQuickBio, parseTitles, confirmedFullName, analyzeResearch } from '@/modules/celebrity-writer/parsers';
import { cleanModelMarkdown, markdownToHtml, dedupeBlocks } from '@/lib/content/markdown';
import { sanitizeArticleHtml } from '@/lib/html/sanitize';
import { assembleArticle, boldenLinks } from '@/lib/content/assembly';
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

  it('parses QUESTION/ANSWER pairs whose line breaks were lost (labels on one line), only with the upper-case labels', () => {
    // The owner's first live run: the page's soft line breaks were collapsed, so every pair arrived on one line.
    const oneLine =
      'QUESTION: Wer ist Gloria Krass? ANSWER: Gloria Krass ist eine deutsche Filmagentin.\n\nQUESTION: Wie alt ist Gloria Krass? ANSWER: Ihr genaues Geburtsdatum ist nicht bestätigt.';
    expect(parseFaqs(oneLine)).toEqual([
      { question: 'Wer ist Gloria Krass?', answer: 'Gloria Krass ist eine deutsche Filmagentin.' },
      { question: 'Wie alt ist Gloria Krass?', answer: 'Ihr genaues Geburtsdatum ist nicht bestätigt.' },
    ]);
    expect(parseFaqs('QUESTION: Wie alt? ANSWER: 28. QUESTION: Woher? ANSWER: Aus Wien.')).toHaveLength(2);
    expect(parseFaqs('FRAGE: Wie alt? ANTWORT: 28 Jahre.')).toHaveLength(1);
    // Ordinary prose that merely contains the words is not a FAQ.
    expect(parseFaqs('The question: is she married? The answer: yes, since 2022.')).toHaveLength(0);
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

describe('bold links (owner request)', () => {
  it('wraps every link text in <strong> — source links, internal links and the read-more line — once, and only when switched on', () => {
    const body =
      '<p>Intro with a <a href="https://www.bunte.de/x" data-bas-link="ext" rel="noopener">BUNTE</a> report.</p><h2>Career</h2><p>See <a href="https://site.example/a" data-bas-link="int">her agency</a> and <strong><a href="https://x.example">already bold</a></strong>.</p><h2>Conclusion</h2><p>End.</p>';
    const input = { bodyHtml: body, language: 'de', moduleKey: 'celebrity-writer', internalLink: { line: 'Das könnte Ihnen gefallen:', url: 'https://site.example/b', title: 'Another article' } };
    const bold = assembleArticle({ ...input, boldLinks: true }).html;
    expect(bold).toContain('<a href="https://www.bunte.de/x" data-bas-link="ext" rel="noopener"><strong>BUNTE</strong></a>');
    expect(bold).toMatch(/<a href="https:\/\/site\.example\/a"[^>]*><strong>her agency<\/strong><\/a>/);
    expect(bold).toMatch(/<a href="https:\/\/site\.example\/b"[^>]*><strong>Another article<\/strong><\/a>/);
    expect(bold).toMatch(/<strong><a href="https:\/\/x\.example"[^>]*>already bold<\/a><\/strong>/);
    expect(bold.match(/<strong><strong>/g)).toBeNull();
    expect(boldenLinks(bold)).toBe(bold);
    const plain = assembleArticle({ ...input, boldLinks: false }).html;
    expect(plain).toContain('>BUNTE</a>');
    expect(plain).not.toContain('<strong>BUNTE</strong>');
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
    // Body image 1 sits before the second article H2 (Quick Bio is the first), body image 2 one paragraph before the FAQs.
    const order = ['Intro paragraph', '<h2>Quick Bio</h2>', 'alt="one"', '<h2>Early Life</h2>', '<h2>Career</h2>', 'alt="two"', '<h2>Frequently Asked Questions</h2>', '<h2>Conclusion</h2>', 'data-bas-internal-link'];
    const idx = order.map((s) => h.indexOf(s));
    expect(idx.every((v) => v >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(r.structure.removedSections).toEqual(['FAQ']);
    expect((h.match(/data-bas-internal-link/g) ?? []).length).toBe(1);
  });

  it('places Tigram body images before the second H2 and one paragraph before the FAQs, never right before them', () => {
    const images = [
      { slot: 'BODY1' as const, html: '<figure><img src="https://x/1.webp" alt="one"></figure>' },
      { slot: 'BODY2' as const, html: '<figure><img src="https://x/2.webp" alt="two"></figure>' },
    ];
    const tigram = '<p>Intro.</p><h2>Step one</h2><p>A.</p><h2>Step two</h2><p>B1.</p><p>B2.</p><h2>FAQ</h2><h3>Q?</h3><p>x</p><h2>Conclusion</h2><p>End.</p>';
    const h = assembleArticle({ bodyHtml: tigram, language: 'en', moduleKey: 'tigram-writer', images }).html;
    const order = ['<h2>Step one</h2>', 'alt="one"', '<h2>Step two</h2>', 'B1.', 'alt="two"', 'B2.', '<h2>Frequently Asked Questions</h2>'];
    const idx = order.map((x) => h.indexOf(x));
    expect(idx.every((v) => v >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    // A single content section: image 1 goes after its first paragraph, not before the FAQs.
    const one = assembleArticle({ bodyHtml: '<p>Intro.</p><h2>Only</h2><p>A.</p><p>B.</p><h2>FAQ</h2><h3>Q?</h3><p>x</p><h2>Conclusion</h2><p>End.</p>', language: 'en', moduleKey: 'tigram-writer', images }).html;
    expect(one.indexOf('alt="one"')).toBeGreaterThan(one.indexOf('A.'));
    expect(one.indexOf('alt="two"')).toBeLessThan(one.indexOf('B.'));
    expect(one).not.toMatch(/<\/figure>\s*<h2>Frequently Asked Questions/);
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

describe('owner report: “Writing” under the title, the title repeated, the Quick Bio before the introduction', () => {
  const title = 'Wer ist Anika Bissel? Alles über Manuel Neuers Ehefrau';
  // The FINAL_ARTICLE answer as the page gave it: the writing block's label, then the title, then the article.
  const answer = `Writing\n\n# ${title}\n\nAnika Bissel ist als Ehefrau des deutschen Fußballtorwarts Manuel Neuer bekannt.\n\n## Wer ist Anika Bissel?\n\nAnika Bissel wurde am 11. Juni 2000 in Erlangen geboren.\n\n## Fazit\n\nSie hat eine eigene Laufbahn.`;
  const quickBioHtml = '<table><tr><th>Merkmal</th><th>Angaben</th></tr><tr><td>Geburtsort</td><td>Erlangen</td></tr></table>';
  const order = (html: string) => [...html.matchAll(/<(h2|p)[^>]*>(.*?)<\/\1>/g)].map((m) => `${m[1]}:${m[2].replace(/<[^>]+>/g, '').slice(0, 20)}`);

  it('the article text loses the label and the title; the Quick Bio follows the introduction', () => {
    const md = cleanModelMarkdown(answer, { title });
    expect(md).not.toMatch(/^Writing$/m);
    expect(md).not.toContain(title);
    const html = assembleArticle({ bodyHtml: markdownToHtml(md), language: 'de', moduleKey: 'celebrity-writer', quickBioHtml, quickBioName: 'Anika Neuer', title }).html;
    expect(order(html).slice(0, 3)).toEqual(['p:Anika Bissel ist als', 'h2:Kurzbiografie von An', 'h2:Wer ist Anika Bissel']);
  });

  it('a body saved before the fix is cleaned when it is assembled (label removed, repeated title dropped)', () => {
    const saved = `<p>Writing</p><h2>${title}</h2><p>Anika Bissel ist als Ehefrau des deutschen Fußballtorwarts Manuel Neuer bekannt.</p><h2>Wer ist Anika Bissel?</h2><p>Geboren in Erlangen.</p><h2>Fazit</h2><p>Ende.</p>`;
    const html = assembleArticle({ bodyHtml: saved, language: 'de', moduleKey: 'celebrity-writer', quickBioHtml, quickBioName: 'Anika Neuer', title }).html;
    expect(html).not.toMatch(/>Writing</);
    expect(order(html).slice(0, 3)).toEqual(['p:Anika Bissel ist als', 'h2:Kurzbiografie von An', 'h2:Wer ist Anika Bissel']);
  });

  it('real text with the word stays: only a line that is just the label goes', () => {
    const md = cleanModelMarkdown('Writing is his second career.\n\n## Writing\n\nHe writes books.', { title: 'Someone' });
    expect(md).toContain('Writing is his second career.');
    expect(md).toContain('## Writing');
  });
});
