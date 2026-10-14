import { describe, expect, it } from 'vitest';
import { markSpans, plainText, restoreParagraph, tokenizeParagraph } from '@/lib/humanizer/tokens';
import { hasName, validateRewrite, type FactLockContext } from '@/lib/humanizer/validate';
import { diagnose, flagParagraph, observations } from '@/lib/humanizer/analyze';
import { applyResults, batchVariables, evaluateBatch, parseLabelled, planHumanize, skippedResults, summarize } from '@/lib/humanizer/plan';

const EN: FactLockContext = { keyword: 'Heidi Klum', language: 'en', names: ['Heidi Klum', 'Tom Kaulitz'], tolerancePct: 20 };
const DE: FactLockContext = { keyword: 'Heidi Klum', language: 'de', names: ['Heidi Klum', 'Tom Kaulitz'], tolerancePct: 20 };

describe('humanizer marks', () => {
  it('turns links, bold and italic into lossless marks and restores the original tags', () => {
    const html = 'Heidi Klum met <a href="https://example.org/x?a=1&amp;b=2" rel="noopener" data-bas-link="ext">Tom <em>Kaulitz</em></a> in <strong>2018</strong> &amp; married him in <em>Capri</em> {not a mark}.';
    const t = tokenizeParagraph(html)!;
    expect(t.text).toBe('Heidi Klum met {L1}Tom Kaulitz{/L1} in {b}2018{/b} & married him in {i}Capri{/i} ｛not a mark｝.');
    expect(plainText(t.text)).toBe('Heidi Klum met Tom Kaulitz in 2018 & married him in Capri {not a mark}.');
    const restored = restoreParagraph('In {b}2018{/b} Heidi Klum met {L1}Tom Kaulitz{/L1}; they married in {i}Capri{/i} & stayed ｛not a mark｝.', t.links);
    expect(restored).toContain('<a href="https://example.org/x?a=1&amp;b=2" rel="noopener" data-bas-link="ext">Tom <em>Kaulitz</em></a>');
    expect(restored).toContain('<strong>2018</strong>');
    expect(restored).toContain('&amp; stayed {not a mark}');
    expect(markSpans(t.text)).toEqual({ links: [{ n: 1, inner: 'Tom Kaulitz' }], bold: ['2018'], italic: ['Capri'], stray: false });
  });

  it('refuses paragraphs with markup it cannot rebuild exactly', () => {
    expect(tokenizeParagraph('Some <span class="x">styled</span> text')).toBeNull();
    expect(tokenizeParagraph('A <strong>bold <em>nested</em></strong> mark')).toBeNull();
    expect(tokenizeParagraph('Line<br>break')).toBeNull();
  });
});

describe('fact locks', () => {
  const orig = 'Heidi Klum reportedly met Tom Kaulitz in 2018 at a party in {L1}Los Angeles{/L1}, and the couple married on {b}22 February 2019{/b}. She later said the wedding was “small and private”, and it is important to note that the date was kept secret.';
  const good = 'Heidi Klum reportedly met Tom Kaulitz in 2018 at a party in {L1}Los Angeles{/L1}. The couple married on {b}22 February 2019{/b}, and she later described the wedding as “small and private”; the date itself was kept secret.';

  it('accepts a faithful edit', () => {
    expect(validateRewrite(orig, good, EN)).toEqual([]);
  });

  it.each([
    ['changed number', good.replace('2018', '2017'), /Numbers changed/],
    ['changed month', good.replace('February', 'March'), /Numbers changed|month/],
    ['changed quotation', good.replace('“small and private”', '“tiny and private”'), /Quoted words/],
    ['changed anchor', good.replace('{L1}Los Angeles{/L1}', '{L1}LA{/L1}'), /link or its anchor/],
    ['dropped link mark', good.replace('{L1}Los Angeles{/L1}', 'Los Angeles'), /link or its anchor/],
    ['changed bold', good.replace('{b}22 February 2019{/b}', '22 February 2019'), /Bold text/],
    ['broken mark', good.replace('{/L1}', ''), /broken|link/],
    ['removed name', good.replace('Tom Kaulitz', 'the musician'), /Name.*missing: Tom Kaulitz/],
    ['keyword count', good.replace('Heidi Klum reportedly', 'Heidi Klum, Heidi Klum reportedly'), /Keyword/],
    ['weakened uncertainty', good.replace('reportedly ', ''), /Uncertainty weakened/],
    ['added certainty', good.replace('the date itself', 'the date itself was certainly'), /certainty/],
    ['two paragraphs', good.replace('. The couple', '.\n\nThe couple'), /exactly one paragraph/],
    ['html', good.replace('{b}22 February 2019{/b}', '<strong>22 February 2019</strong>'), /HTML|Bold/],
    ['added entity', good + ' Their friend Mark Ronson attended.', /Adds a name/],
    ['too long', `${good} ${good.replace(/\{\/?(b|L1)\}/g, '')}`, /Length changed/],
  ])('rejects %s', (_label, rewrite, expected) => {
    expect(validateRewrite(orig, rewrite, EN).join(' ')).toMatch(expected);
  });

  it('rejects a semantic shift and a language switch', () => {
    const plain = 'The singer and the model spent the summer travelling through Italy together with friends and family, visiting several small towns along the coast before returning home to prepare for the next season of their television work.';
    const shifted = 'Critics praised the band for its loud stage shows, bright costumes and energetic fans, while newspapers debated whether its music could survive changing listening habits and streaming economics in the coming decade ahead.';
    expect(validateRewrite(plain, shifted, { ...EN, keyword: '', names: [] }).join(' ')).toMatch(/Meaning shifted/);
    const german = 'Die Sängerin und das Model verbrachten den Sommer mit Freunden und der Familie in Italien und besuchten dabei mehrere kleine Orte an der Küste, bevor sie nach Hause zurückkehrten, um die nächste Staffel vorzubereiten.';
    expect(validateRewrite(plain, german, { ...EN, keyword: '', names: [] }).join(' ')).toMatch(/Language changed to German/);
  });

  it('tolerates German name inflection but still requires the name', () => {
    expect(hasName('Heidi Klums Ehe mit Tom Kaulitz', 'Heidi Klum')).toBe(true);
    expect(hasName('Die Ehe von Kaulitz’ Frau', 'Kaulitz')).toBe(true);
    expect(hasName('Heidi Klumpp', 'Heidi Klum')).toBe(false);
    const o = 'Heidi Klum heiratete Tom Kaulitz im Jahr 2019 auf Capri, und die Feier soll sehr privat gewesen sein, wie mehrere Medien damals berichteten.';
    const r = 'Heidi Klum heiratete Tom Kaulitz 2019 auf Capri; die Feier soll sehr privat gewesen sein, wie damals mehrere Medien berichteten.';
    expect(validateRewrite(o, r, DE)).toEqual([]);
    expect(validateRewrite(o, r.replace(' soll sehr privat gewesen sein', ' war sehr privat'), DE).join(' ')).toMatch(/Uncertainty/);
  });
});

describe('local editor and planning', () => {
  const p = (t: string) => `<p>${t}</p>`;
  const body = [
    p('Additionally, it is important to note that Heidi Klum has a remarkable career that spans decades — modelling — television — and business.'),
    p('She grew up in Bergisch Gladbach near Cologne and started modelling after winning a national competition in 1992, which opened doors.'),
    p('Short one.'),
    p('Her show <span>Germany’s Next Topmodel</span> started in 2006 and became one of the longest running formats on German television.'),
    p('She married Tom Kaulitz in 2019. She met him in 2018. She lives in Los Angeles. She also spends time in Germany with family and friends.'),
    '<p data-bas-internal-link="1"><strong>Also read:</strong> <a href="https://x/y">Y</a></p>',
    '<ul><li>Not a paragraph that is ever edited by the humanizer, even when long enough to count.</li></ul>',
  ].join('');

  it('flags filler phrases, banned openers, inflated words and dashes', () => {
    const f = flagParagraph('Additionally, it is important to note that her remarkable career — modelling — matters.', 'en');
    expect(f.fillers).toContain('it is important to note');
    expect(f.openers).toEqual(['additionally']);
    expect(f.inflated).toEqual(['remarkable']);
    expect(f.dashes).toBe(2);
    expect(flagParagraph('Zudem ist es erwähnenswert, dass sie maßgeblich beteiligt war.', 'de')).toMatchObject({ openers: ['zudem'], fillers: ['ist es erwähnenswert'], inflated: ['maßgeblich'] });
  });

  it('plans labelled paragraphs, skips unsafe/short ones, never touches the internal-link line or lists', () => {
    const plan = planHumanize(body, { language: 'en', scope: 'all', batchWords: 40 });
    expect(plan.paragraphs.map((x) => x.id)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
    expect(plan.paragraphs.map((x) => x.skip)).toEqual([null, null, 'too short to edit', 'contains markup that cannot be edited safely', null]);
    expect(plan.batches.map((b) => b.ids)).toEqual([['P1', 'P2'], ['P5']]);
    const vars = batchVariables(plan, 0);
    expect(vars.paragraphs).toMatch(/^\[P1\]\nAdditionally, it is important to note/);
    expect(vars.problems).toMatch(/\[P1\] empty phrase “it is important to note”; sentence opener “additionally”; inflated word “remarkable”; 3 dashes/);
    const flaggedOnly = planHumanize(body, { language: 'en', scope: 'flagged', batchWords: 1200 });
    expect(flaggedOnly.batches.map((b) => b.ids)).toEqual([['P1']]);
  });

  it('reports repetition and rhythm as editorial observations', () => {
    const d = diagnose(['She sang. She danced. She acted. She wrote. She left. She came back. She won. She lost.'], 'en');
    expect(d.repeatedOpeners[0]).toEqual({ word: 'she', count: 8 });
    expect(observations(d).join(' ')).toMatch(/8 sentences start with “she”/);
    expect(observations(d).join(' ')).toMatch(/very uniform/);
  });

  it('parses labelled answers in common formats', () => {
    const m = parseLabelled('```\n[P1]\nFirst edited.\n\n**[P2]** Second edited.\n[P3]\nThird\n```');
    expect([...m.entries()]).toEqual([
      ['P1', 'First edited.'],
      ['P2', 'Second edited.'],
      ['P3', 'Third'],
    ]);
  });

  it('applies accepted rewrites to the original HTML, keeps rejected/missing ones, and summarizes', () => {
    const html = '<h2>Career</h2><p>Additionally, Heidi Klum worked with <a href="https://example.org/gntm" rel="noopener">Germany’s Next Topmodel</a> from 2006 and became a remarkable television host in Germany.</p><p>She reportedly earned 20 million dollars in 2019 from television, advertising and fashion projects across Europe and America.</p><p>She lives in Los Angeles with her husband and children and still travels to Germany often for work and family visits.</p>';
    const plan = planHumanize(html, { language: 'en', scope: 'all', batchWords: 1200 });
    const answer = '[P1]\nHeidi Klum worked with {L1}Germany’s Next Topmodel{/L1} from 2006 and became a popular television host in Germany.\n\n[P2]\nShe earned 20 million dollars in 2019 from television, advertising and fashion projects across Europe and America.';
    const results = [...evaluateBatch(plan, 0, answer, { ...EN, keyword: '' }), ...skippedResults(plan)];
    expect(results.map((r) => r.status)).toEqual(['rewritten', 'kept', 'kept']);
    expect(results[1].reasons.join(' ')).toMatch(/Uncertainty weakened/);
    expect(results[2].reasons).toEqual(['ChatGPT did not return this paragraph.']);
    const out = applyResults(html, plan, results);
    expect(out).toContain('<h2>Career</h2>');
    expect(out).toContain('<p>Heidi Klum worked with <a href="https://example.org/gntm" rel="noopener">Germany’s Next Topmodel</a> from 2006 and became a popular television host in Germany.</p>');
    expect(out).toContain('She reportedly earned 20 million dollars');
    const s = summarize(plan, results, 'en');
    expect(s).toMatchObject({ rewritten: 1, kept: 2, unchanged: 0, skipped: 0 });
    expect(s.before.bannedOpeners).toBe(1);
    expect(s.after.bannedOpeners).toBe(0);
    expect(evaluateBatch(plan, 0, { error: 'usage limit' }, EN).every((r) => r.status === 'kept' && /usage limit/.test(r.reasons[0]))).toBe(true);
  });
});
