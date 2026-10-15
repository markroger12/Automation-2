import { describe, expect, it } from 'vitest';
import { buildTextModel, htmlSegments, inputSegments, sentenceRanges } from '@/lib/plagiarism/text';
import { blockFingerprint, boilerplateTokens, distinctivePassages, exactRuns, excerpt, nearMatches } from '@/lib/plagiarism/match';

const model = (html: string, page = false) => buildTextModel(htmlSegments(html, { page }));

const SOURCE = `<html><body><nav><p>Home About Contact Imprint Privacy Login Register Newsletter</p></nav>
<main>
<p>The Leipzig Gewandhaus Orchestra was founded in 1743 and is one of the oldest civic symphony orchestras in the world.</p>
<p>Its concert hall burned down during the war, and the current building opened in 1981 after years of planning by the city council.</p>
<p>Many visitors attend the summer concerts in the park, which are free of charge and draw large crowds every year.</p>
</main><footer><p>Copyright 2026 Example Media. All rights reserved worldwide forever.</p></footer></body></html>`;

describe('plagiarism text model', () => {
  it('extracts readable blocks of a page (main content; navigation and footer dropped) and marks quotations', () => {
    const segs = htmlSegments(SOURCE, { page: true });
    expect(segs.map((s) => s.text).join(' ')).not.toMatch(/Imprint|Copyright/);
    expect(segs).toHaveLength(3);
    const m = buildTextModel(inputSegments('<p>He said “this sentence is a direct quote from him” and left.</p><blockquote><p>Every word here is quoted.</p></blockquote><p>Sie sagte „das ist ein Zitat aus dem Interview“ gestern.</p>'));
    const quoted = m.tokens.filter((t) => t.quoted).map((t) => t.norm);
    expect(quoted).toEqual(expect.arrayContaining(['this', 'direct', 'quote', 'every', 'word', 'zitat', 'interview']));
    expect(quoted).not.toContain('left');
    expect(quoted).not.toContain('gestern');
    // Plain-text paste: paragraphs by blank lines.
    expect(inputSegments('First para.\n\nSecond para here.').map((s) => s.text)).toEqual(['First para.', 'Second para here.']);
  });

  it('splits sentences at end punctuation and block breaks, not inside numbers', () => {
    const m = buildTextModel(inputSegments('Version 3.5 was released. It is fast!\n\nNew block without a full stop'));
    expect(sentenceRanges(m).map(([a, b]) => m.tokens.slice(a, b).map((t) => t.norm).join(' '))).toEqual(['version 3 5 was released', 'it is fast', 'new block without a full stop']);
  });
});

describe('evidence matching', () => {
  const source = model(SOURCE, true);

  it('finds verified exact runs of 8+ words through 5-word anchors; shorter shared phrases are not evidence', () => {
    const article = model('<p>Our guide: the current building opened in 1981 after years of planning by the city council, and it is lovely.</p><p>The orchestra is one of the oldest in town.</p>');
    const runs = exactRuns(article, source);
    expect(runs).toHaveLength(1);
    const [r] = runs;
    expect(r.exempt).toBeNull();
    expect(r.a[1] - r.a[0]).toBe(14); // "the current building opened in 1981 after years of planning by the city council"
    expect(excerpt(article, r.a).match).toBe('the current building opened in 1981 after years of planning by the city council');
    expect(excerpt(source, r.s).match).toBe('the current building opened in 1981 after years of planning by the city council');
    // A 7-word overlap ("is one of the oldest ...") does not reach the minimum.
    expect(exactRuns(model('<p>Truly it is one of the oldest civic symphony groups.</p>'), source)).toEqual([]);
  });

  it('exempts quoted copies (inline quotes and blockquotes) but still reports them as exempt', () => {
    const article = model('<p>As the city wrote, “Many visitors attend the summer concerts in the park, which are free of charge” — a nice tradition.</p>');
    const runs = exactRuns(article, source);
    expect(runs).toHaveLength(1);
    expect(runs[0].exempt).toBe('quotation');
    expect(runs[0].countedWords).toBe(0);
  });

  it('finds sentence-level near matches for light rewording, and nothing for unrelated text', () => {
    const article = model('<p>Many visitors attend summer concerts in the park, because they are free of charge and draw big crowds each year.</p><p>Bananas grow best in warm climates with plenty of rain and sunshine all year.</p>');
    const near = nearMatches(article, source, new Set());
    expect(near).toHaveLength(1);
    expect(article.tokens[near[0].a[0]].norm).toBe('many');
    expect(near[0].shared / near[0].contentWords).toBeGreaterThanOrEqual(0.7);
    expect(near[0].ordered).toBeGreaterThanOrEqual(0.6);
  });

  it('treats blocks recurring in 3+ other articles of the site as boilerplate (exempt, listed)', () => {
    const cta = 'Subscribe to our newsletter for weekly updates about concerts and events in Leipzig and Saxony.';
    const article = model(`<p>${cta}</p><p>Unique opening text about something else entirely here.</p>`);
    const fp = blockFingerprint(article, article.blocks[0]);
    const counts = new Map([[fp, 3]]);
    const bp = boilerplateTokens(article, counts, 3);
    expect(bp.blocks).toEqual([{ text: cta, articles: 3 }]);
    const other = model(`<p>Intro. ${cta}</p>`);
    const runs = exactRuns(article, other, bp.tokens);
    expect(runs).toHaveLength(1);
    expect(runs[0].exempt).toBe('boilerplate');
    expect(boilerplateTokens(article, new Map([[fp, 2]]), 3).blocks).toEqual([]);
  });

  it('samples distinctive passages spread over the article as 10-word exact-phrase queries', () => {
    const paras = Array.from({ length: 6 }, (_, i) => `<p>Paragraph ${i} explains that the Gewandhaus renovation in ${1990 + i} required extraordinary acoustic engineering, careful financing and international collaboration between architects.</p><p>It was nice and good and fine for all of us there.</p>`).join('');
    const article = model(paras);
    const picks = distinctivePassages(article, 3);
    expect(picks).toHaveLength(3);
    for (const p of picks) expect(p.query.split(' ')).toHaveLength(10);
    expect(new Set(picks.map((p) => p.sentence[0])).size).toBe(3);
    expect(picks.every((p) => !/nice and good/.test(p.query))).toBe(true);
  });
});
