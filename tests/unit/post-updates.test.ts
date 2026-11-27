import { describe, expect, it } from 'vitest';
import { editablePost, markUse, rebuildPost, topLevelBlocks } from '@/lib/posts/editable';
import { parseUpdateAnswer } from '@/lib/posts/answer';
import { blockingFailures, checkUpdate } from '@/lib/posts/checks';
import { keywordFromTitle } from '@/wordpress/post-updates';

/** “Update to latest” (owner request 2026-11-27): what ChatGPT gets, what comes back, and the app's checks. */
describe('a WordPress post as an article ChatGPT can update', () => {
  const columns = `<!-- wp:columns -->
<div class="wp-block-columns"><!-- wp:column -->
<div class="wp-block-column"><!-- wp:paragraph -->
<p>Inside a column.</p>
<!-- /wp:paragraph --></div>
<!-- /wp:column --></div>
<!-- /wp:columns -->`;

  it('splits Gutenberg content into top-level blocks, nested blocks kept inside their parent', () => {
    const blocks = topLevelBlocks(`<!-- wp:paragraph -->\n<p>One.</p>\n<!-- /wp:paragraph -->\n\n${columns}\n\n<!-- wp:separator /-->`);
    expect(blocks.map((b) => b.name)).toEqual(['core/paragraph', 'core/columns', 'core/separator']);
    expect(blocks[1].raw).toBe(columns);
  });

  it('gives ChatGPT only text; styled, nested and media blocks are kept exactly, as marks', () => {
    const raw = `<!-- wp:paragraph -->
<p>Plain text with <em>emphasis</em> and a <a href="https://e.example/"><img src="https://e.example/i.png" alt=""></a> linked image.</p>
<!-- /wp:paragraph -->

<!-- wp:paragraph {"align":"center","className":"note"} -->
<p class="has-text-align-center note">Styled box.</p>
<!-- /wp:paragraph -->

${columns}

<!-- wp:quote -->
<blockquote class="wp-block-quote"><!-- wp:paragraph -->
<p>A quote stays word for word.</p>
<!-- /wp:paragraph --></blockquote>
<!-- /wp:quote -->

<!-- wp:list -->
<ul class="wp-block-list"><!-- wp:list-item -->
<li>Item one</li>
<!-- /wp:list-item --></ul>
<!-- /wp:list -->

<!-- wp:freeform -->
Old classic text.

[contact-form-7 id="9"]
<!-- /wp:freeform -->`;
    const e = editablePost(raw);
    expect(e.editor).toBe('GUTENBERG');
    expect(e.keeps.map((k) => `${k.block ? 'B' : 'I'}:${k.what}`)).toEqual(['I:linked image', 'B:core/paragraph', 'B:core/columns', 'B:core/quote', 'B:shortcode']);
    expect(e.markdown).toContain('Plain text with {i}emphasis{/i} and a {K1} linked image.');
    expect(e.markdown).toContain('- Item one');
    expect(e.markdown).toContain('Old classic text.');
    expect(e.markdown).not.toContain('Styled box');
    expect(e.markdown).not.toContain('word for word');
    // Unchanged answer: every kept part comes back byte for byte.
    const back = rebuildPost(e.markdown, e);
    for (const k of e.keeps) expect(back.raw).toContain(k.raw);
    expect(back.raw).toContain('<li>Item one</li>');
  });

  it('a block mark written inside a sentence: the block follows that paragraph; invented marks are dropped', () => {
    const raw = `<!-- wp:paragraph -->\n<p>First.</p>\n<!-- /wp:paragraph -->\n\n<!-- wp:image {"id":5} -->\n<figure class="wp-block-image"><img src="https://e.example/a.jpg" alt="a"/></figure>\n<!-- /wp:image -->\n\n<!-- wp:paragraph -->\n<p>Second.</p>\n<!-- /wp:paragraph -->`;
    const e = editablePost(raw);
    const answer = 'First, now longer {K1} and updated. {K9}\n\nSecond.';
    expect(markUse(answer, e.keeps)).toEqual({ missing: [], repeated: [], unknown: [9] });
    const out = rebuildPost(answer, e).raw;
    expect(out.indexOf('First, now longer')).toBeLessThan(out.indexOf('wp-block-image'));
    expect(out.indexOf('wp-block-image')).toBeLessThan(out.indexOf('Second.'));
    expect(out).not.toContain('{K');
    expect(markUse('First.\n\nSecond.', e.keeps).missing.map((k) => k.what)).toEqual(['core/image']);
  });
});

describe("ChatGPT's answer", () => {
  it('reads the parts, also with bolded or spaced markers, and the sources with their notes', () => {
    const text = ['**===TITLE===**', 'Sarah Jones Net Worth 2026', '=== META DESCRIPTION ===', 'A description.', '===CHANGES===', '- Age 34 → 36', '2. Net worth', '===SOURCES===', '- https://news.example/a — confirms the age', '- [https://b.example/x](https://b.example/x): net worth', '===ARTICLE===', '## Early Life', '', 'Text.', '===END===', 'ignored'].join('\n');
    const a = parseUpdateAnswer(text);
    expect(a).toMatchObject({ title: 'Sarah Jones Net Worth 2026', metaDescription: 'A description.', changes: ['Age 34 → 36', 'Net worth'], noChanges: false, article: '## Early Life\n\nText.' });
    expect('sources' in a && a.sources).toEqual([
      { url: 'https://news.example/a', note: 'confirms the age' },
      { url: 'https://b.example/x', note: 'net worth' },
    ]);
    expect(parseUpdateAnswer('===TITLE===\nT\n===CHANGES===\n- No changes needed\n===ARTICLE===\nText.')).toMatchObject({ noChanges: true });
    expect(parseUpdateAnswer('Just an article.')).toEqual({ error: expect.stringMatching(/===ARTICLE===/) });
  });
});

describe("the app's checks of an update", () => {
  const para = (n: number, word = 'career') => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i} about her ${word} and the projects she worked on over the years with several directors.</p>`).join('');
  const before = `<h2>Early Life</h2>${para(6)}<h2>Career</h2>${para(6)}`;
  const base = { beforeHtml: before, marks: { missing: [], repeated: [], unknown: [] }, keyword: 'Sarah Jones', language: 'en', densityCeilingPct: 2.5, titleBefore: 'Sarah Jones Net Worth 2024', metaDescription: null, changes: ['x'], sources: [{ url: 'https://a.example', note: '' }], now: new Date('2026-11-27T00:00:00Z') };

  it('a real update passes', () => {
    const after = before.replace('Paragraph 1 about her career', 'Paragraph 1 about her new 2026 film');
    expect(blockingFailures(checkUpdate({ ...base, afterHtml: after, titleAfter: 'Sarah Jones Net Worth 2026' }))).toEqual([]);
  });

  it('a new year in the title with the same text is flagged (date-only freshness); a future year stops it', () => {
    const same = checkUpdate({ ...base, afterHtml: before, titleAfter: 'Sarah Jones Net Worth 2026' });
    expect(same.find((c) => c.id === 'freshness')).toMatchObject({ passed: false, blocking: false });
    const future = checkUpdate({ ...base, afterHtml: before, titleAfter: 'Sarah Jones Net Worth 2027' });
    expect(blockingFailures(future).map((c) => c.id)).toEqual(['future-year']);
  });

  it('lost structure, stuffing, chatbot remarks and another language stop it', () => {
    const shortened = checkUpdate({ ...base, afterHtml: `<h2>Early Life</h2>${para(2)}`, titleAfter: base.titleBefore });
    expect(blockingFailures(shortened).map((c) => c.id)).toEqual(expect.arrayContaining(['length', 'headings']));
    const stuffed = checkUpdate({ ...base, afterHtml: `${before}<p>${'Sarah Jones '.repeat(40)}</p>`, titleAfter: base.titleBefore });
    expect(blockingFailures(stuffed).map((c) => c.id)).toContain('keyword');
    const chatty = checkUpdate({ ...base, afterHtml: `${before}<p>I hope this helps! Let me know if you need more.</p>`, titleAfter: base.titleBefore });
    expect(blockingFailures(chatty).map((c) => c.id)).toContain('chatbot');
    const german = `<h2>Early Life</h2>${Array.from({ length: 12 }, () => '<p>Sie ist eine bekannte Schauspielerin und lebt mit ihrer Familie in Kalifornien, wo sie an neuen Filmen arbeitet.</p>').join('')}<h2>Career</h2>`;
    expect(blockingFailures(checkUpdate({ ...base, afterHtml: german, titleAfter: base.titleBefore })).map((c) => c.id)).toContain('language');
  });
});

describe('the keyword of a post the app did not write', () => {
  it("is the title's topic without its year or question mark", () => {
    expect(keywordFromTitle('Sarah Jones Net Worth 2024: How Rich Is She?')).toBe('Sarah Jones Net Worth');
    expect(keywordFromTitle('Who Is Anna Bell?')).toBe('Who Is Anna Bell');
    expect(keywordFromTitle('Best Films of 2023')).toBe('Best Films of');
    expect(keywordFromTitle('2024')).toBe('2024');
  });
});
