import { describe, expect, it } from 'vitest';
import { buildTextModel, htmlSegments } from '@/lib/plagiarism/text';
import { blockFingerprint, boilerplateTokens } from '@/lib/plagiarism/match';
import { compareArticles, isFactLike, paragraphHashes, severityOf } from '@/lib/duplicates/compare';
import { matchSiteRule, parseRoutingRules, resolveWriter } from '@/lib/campaigns/router';

const model = (html: string) => buildTextModel(htmlSegments(html));
const P = (n: number, topic: string) =>
  Array.from({ length: n }, (_, i) => `<p>${topic} paragraph ${i} describes ${['gardening', 'cycling', 'baking', 'sailing', 'painting', 'climbing'][i % 6]} habits, the weekly routine around it and why the hobby keeps people motivated through long winters.</p>`).join('');

describe('Duplicate Content Detector — comparison', () => {
  it('a syndicated copy is heavy overlap: identical paragraphs and long identical runs', () => {
    const body = P(6, 'Ava');
    const c = compareArticles(model(body), model(`<p>Republished from our partner site.</p>${body}`), 'other', { highShare: 0.45 })!;
    expect(c.severity).toBe('HIGH');
    expect(c.exactParagraphs).toBe(6);
    expect(c.wordingShare).toBeGreaterThan(0.9);
    expect(c.excerpts[0]).toMatchObject({ kind: 'wording' });
  });

  it('two articles about the same person share facts, not wording: facts are counted separately and do not raise the severity', () => {
    const a = model('<p>Tom Kaulitz was born on 1 September 1989 in Leipzig, Germany. He founded the band with his twin brother and later moved to Los Angeles to work on new music.</p><p>Fans first noticed him on stage as a teenager, and his guitar style became part of the early sound.</p>');
    const b = model('<p>Born on 1 September 1989 in Leipzig, Germany, the guitarist grew up near Magdeburg. Critics describe his playing as melodic, and interviews show a dry sense of humour.</p><p>Today he spends most of the year in California with his family.</p>');
    const c = compareArticles(a, b, 'other', { highShare: 0.45 });
    expect(c).not.toBeNull();
    expect(c!.wordingWords).toBe(0);
    expect(c!.factWords).toBeGreaterThanOrEqual(8);
    expect(c!.severity).toBe('LOW');
    expect(c!.excerpts.every((e) => e.kind === 'fact')).toBe(true);
  });

  it('different people with the same name and different text: no overlap at all', () => {
    const actor = model(`<p>Chris Evans the actor became famous for playing a superhero in a long film series and later produced independent dramas.</p>${P(2, 'Actor')}`);
    const host = model('<p>Chris Evans the broadcaster presented a breakfast radio show for years and later bought a classic car collection that he shows at events.</p>');
    expect(compareArticles(host, actor, 'other', { highShare: 0.45 })).toBeNull();
  });

  it('recurring site text (a call to action in 3+ other articles) is not duplication', () => {
    const cta = '<p>Subscribe to our newsletter for weekly updates about concerts and events in Leipzig and Saxony every Friday morning.</p>';
    const article = model(`<p>A completely different introduction about jazz clubs in the city centre and their history since the nineties.</p>${cta}`);
    const counts = new Map([[blockFingerprint(article, article.blocks[1]), 4]]);
    const bp = boilerplateTokens(article, counts, 3).tokens;
    expect(compareArticles(article, model(`<p>Opera guide intro.</p>${cta}`), 'other', { highShare: 0.45, boilerplate: bp })).toBeNull();
    expect(compareArticles(article, model(`<p>Opera guide intro.</p>${cta}`), 'other', { highShare: 0.45 })!.wordingWords).toBeGreaterThan(8);
  });

  it('classifies fact-like runs and grades severity from the overlap', () => {
    const m = model('<p>She was born on 14 March 1990 in Berlin to Anna Schmidt and Peter Schmidt, according to the registry.</p><p>the weekly routine around it and why the hobby keeps people motivated through long winters</p>');
    expect(isFactLike(m, [2, 13])).toBe(true); // born on 14 March 1990 in Berlin to Anna Schmidt and
    const generic = m.blocks[1];
    const start = m.tokens.findIndex((t) => t.start >= generic.start);
    expect(isFactLike(m, [start, start + 12])).toBe(false);
    const base = { wordingShare: 0, longestRun: 0, exactParagraphs: 0, nearSentences: 0, wordingWords: 0 };
    expect(severityOf({ ...base, wordingShare: 0.5 }, 0.45)).toBe('HIGH');
    expect(severityOf({ ...base, longestRun: 60 }, 0.45)).toBe('HIGH');
    expect(severityOf({ ...base, exactParagraphs: 3 }, 0.45)).toBe('HIGH');
    expect(severityOf({ ...base, wordingShare: 0.16 }, 0.45)).toBe('MEDIUM');
    expect(severityOf({ ...base, longestRun: 25 }, 0.45)).toBe('MEDIUM');
    expect(severityOf({ ...base, nearSentences: 4 }, 0.45)).toBe('MEDIUM');
    expect(severityOf({ ...base, longestRun: 12 }, 0.45)).toBe('LOW');
    expect(paragraphHashes(model(P(3, 'X'))).length).toBe(3);
  });
});

describe('Smart Article Router — per-website rules', () => {
  const rules = [
    { contains: 'net worth', writer: 'celebrity-writer' as const },
    { contains: 'vpn', writer: 'tigram-writer' as const },
  ];

  it('matches whole words only, case-insensitive', () => {
    expect(matchSiteRule('Taylor Swift NET WORTH 2026', rules)?.writer).toBe('celebrity-writer');
    expect(matchSiteRule('best vpn apps', rules)?.writer).toBe('tigram-writer');
    expect(matchSiteRule('vpnfilter malware', rules)).toBeNull();
    expect(matchSiteRule('networth', rules)).toBeNull();
  });

  it('precedence: row choice, campaign default, website rule, then the classifier — never a third writer', () => {
    expect(resolveWriter({ keyword: 'best vpn apps', siteRules: rules, override: 'celebrity' })).toMatchObject({ writer: 'celebrity-writer', source: 'OVERRIDE' });
    expect(resolveWriter({ keyword: 'best vpn apps', siteRules: rules, campaignDefault: 'celebrity-writer' })).toMatchObject({ source: 'CAMPAIGN' });
    expect(resolveWriter({ keyword: 'jaguar net worth', siteRules: rules })).toMatchObject({ writer: 'celebrity-writer', source: 'SITE_RULE', rationale: 'Website rule: keyword contains “net worth”.' });
    expect(resolveWriter({ keyword: 'jaguar', siteRules: rules }).source).toBe('RULE');
    expect(resolveWriter({ keyword: 'x', siteRules: rules, override: 'celebrity-writer-2' }).writer).not.toBe('celebrity-writer-2');
  });

  it('stored rules are parsed defensively: anything invalid never routes', () => {
    expect(parseRoutingRules('[{"contains":"vpn","writer":"tigram-writer"}]')).toEqual([{ contains: 'vpn', writer: 'tigram-writer' }]);
    expect(parseRoutingRules('[{"contains":"vpn","writer":"celebrity-writer-2"}]')).toEqual([]);
    expect(parseRoutingRules('not json')).toEqual([]);
  });
});
