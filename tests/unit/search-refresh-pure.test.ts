import { describe, expect, it } from 'vitest';
import { GSC_FIXTURE, makeZip } from '../helpers/zip';
import { isZip, readZip, ZipError } from '@/lib/zip';
import { pageInProperty, pageKey, parseCount, parseDecimal, parseGscExport } from '@/lib/search-performance/gsc-export';
import { addDays, trends } from '@/lib/search-performance/trends';
import { externalLinks, needsRefresh, outdatedYears, priorityOf, unlinkUrls } from '@/lib/refresh/signals';


describe('ZIP reader', () => {
  it('reads stored and deflated entries and refuses damaged or oversized archives', () => {
    const zip = makeZip([
      { name: 'Pages.csv', text: GSC_FIXTURE.pages, deflate: true },
      { name: 'Filters.csv', text: GSC_FIXTURE.filters },
    ]);
    expect(isZip(zip)).toBe(true);
    const entries = readZip(zip);
    expect(entries.map((e) => [e.name, e.data.toString('utf8')])).toEqual([
      ['Pages.csv', GSC_FIXTURE.pages],
      ['Filters.csv', GSC_FIXTURE.filters],
    ]);
    expect(() => readZip(Buffer.from('not a zip at all, just some text bytes'))).toThrow(ZipError);
    expect(() => readZip(zip, { maxEntryBytes: 50 })).toThrow(/too large/);
    expect(() => readZip(zip, { maxEntries: 1 })).toThrow(/at most 1/);
    // A declared size smaller than the real content (zip bomb style) is refused, not inflated.
    const bomb = makeZip([{ name: 'big.csv', text: 'x'.repeat(100_000), deflate: true }]);
    bomb.writeUInt32LE(10, bomb.length - 22 - 46 - 'big.csv'.length + 24);
    expect(() => readZip(bomb)).toThrow(ZipError);
  });
});

describe('Search Console export parser', () => {
  it('reads pages, queries, days and filters as exported (English)', () => {
    const r = parseGscExport([
      { name: 'Pages.csv', text: GSC_FIXTURE.pages },
      { name: 'Queries.csv', text: GSC_FIXTURE.queries },
      { name: 'Dates.csv', text: GSC_FIXTURE.dates },
      { name: 'Filters.csv', text: GSC_FIXTURE.filters },
      { name: 'Countries.csv', text: 'Country,Clicks,Impressions,CTR,Position\nGermany,10,100,10%,3\n' },
    ]);
    expect(r.pages[0]).toEqual({ key: 'https://celeb.example/tom-kaulitz/', current: { clicks: 1204, impressions: 23411, ctr: 5.14, position: 7.2 }, previous: null });
    expect(r.queries[1].key).toBe('tom kaulitz, heidi klum');
    expect([r.start, r.end]).toEqual(['2026-10-13', '2026-10-14']);
    expect(r.searchType).toBe('Web');
    expect(r.compare).toBe(false);
    expect(r.files.find((f) => f.name === 'Countries.csv')?.kind).toBe('IGNORED');
  });

  it('reads German exports and compare exports (both periods)', () => {
    const de = parseGscExport([{ name: 'Seiten.csv', text: 'Häufigste Seiten,Klicks,Impressionen,CTR,Position\nhttps://promi.example/a/,"1.204","23.411","5,14 %","7,2"\n' }]);
    expect(de.pages[0].current).toEqual({ clicks: 1204, impressions: 23411, ctr: 5.14, position: 7.2 });
    const cmp = parseGscExport([{ name: 'Pages.csv', text: 'Top pages,Last 28 days Clicks,Previous 28 days Clicks,Last 28 days Impressions,Previous 28 days Impressions,Last 28 days CTR,Previous 28 days CTR,Last 28 days Position,Previous 28 days Position\nhttps://celeb.example/a/,5,40,300,900,1.67%,4.44%,12.5,8.8\n' }]);
    expect(cmp.compare).toBe(true);
    expect(cmp.pages[0]).toEqual({ key: 'https://celeb.example/a/', current: { clicks: 5, impressions: 300, ctr: 1.67, position: 12.5 }, previous: { clicks: 40, impressions: 900, ctr: 4.44, position: 8.8 } });
  });

  it('skips unreadable rows and reports them', () => {
    const r = parseGscExport([{ name: 'Pages.csv', text: 'Top pages,Clicks,Impressions,CTR,Position\nnot a url,1,2,3%,4\nhttps://celeb.example/x/,n/a,2,3%,4\nhttps://celeb.example/y/,3,9,33%,2\n' }]);
    expect(r.pages.map((p) => p.key)).toEqual(['https://celeb.example/y/']);
    expect(r.warnings).toEqual(['Pages.csv: 2 row(s) could not be read and were skipped.']);
    expect([parseCount('1 234'), parseCount('12.5'), parseDecimal('1.234,5'), parseDecimal('1,234.5'), parseDecimal('3,4 %'), parseDecimal('—')]).toEqual([1234, 125, 1234.5, 1234.5, 3.4, null]);
  });

  it('matches pages to domain and URL-prefix properties; comparable page keys', () => {
    expect(pageInProperty('https://www.celeb.example/a/', 'sc-domain:celeb.example')).toBe(true);
    expect(pageInProperty('https://celebx.example/a/', 'sc-domain:celeb.example')).toBe(false);
    expect(pageInProperty('https://celeb.example/de/a/', 'https://celeb.example/de/')).toBe(true);
    expect(pageInProperty('https://celeb.example/en/a/', 'https://celeb.example/de/')).toBe(false);
    expect(pageKey('https://www.Celeb.example/Tom-Kaulitz/?utm=x#top')).toBe(pageKey('http://celeb.example/tom-kaulitz'));
  });
});

describe('7/28/90-day trends', () => {
  const series = (end: string, n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ date: addDays(end, -i), clicks: f(i), impressions: f(i) * 10, position: 5 }));

  it('counts calendar days from the exported dates, independent of the machine time zone', () => {
    expect(addDays('2026-03-29', -1)).toBe('2026-03-28'); // across a European DST change
    expect(addDays('2026-11-01', 1)).toBe('2026-11-02'); // across a US DST change
    const t = trends(series('2026-10-14', 14, () => 10));
    const week = t.trends.find((x) => x.days === 7)!;
    expect([week.current.start, week.current.end, week.current.covered, week.current.clicks]).toEqual(['2026-10-08', '2026-10-14', 7, 70]);
    expect(week.previous).toMatchObject({ start: '2026-10-01', end: '2026-10-07', covered: 7, clicks: 70 });
    expect(week.clicksChangePct).toBe(0);
    expect(week.current.ctr).toBe(10);
  });

  it('reports partial coverage and gives no change for incomplete periods', () => {
    const t = trends(series('2026-10-14', 10, (i) => (i < 7 ? 5 : 20)));
    const week = t.trends.find((x) => x.days === 7)!;
    expect(week.previous?.covered).toBe(3);
    expect(week.clicksChangePct).toBeNull();
    const quarter = t.trends.find((x) => x.days === 90)!;
    expect([quarter.current.covered, quarter.previous]).toEqual([10, null]);
    expect(trends([])).toEqual({ latest: null, trends: [] });
  });
});

describe('content refresh signals', () => {
  const now = new Date('2026-10-15T12:00:00Z');

  it('flags past edition years and freshness markers, never ordinary dates', () => {
    const r = outdatedYears('<h2>Net worth in 2024</h2><p>Tom was born in 1989 and married in 2019.</p><p>As of March 2025 he lives in Los Angeles.</p>', 'Tom Kaulitz Net Worth 2024', now);
    expect(r.map((x) => x.detail)).toEqual(['The title names 2024; it is now 2026.', 'The heading “Net worth in 2024” names 2024; it is now 2026.', '“As of March 2025” names 2025; it is now 2026.']);
    expect(outdatedYears('<h2>Early life</h2><p>Born in 1989. Married in 2019. Stand: Oktober 2026.</p>', 'Tom Kaulitz: Guitarist, Twin and Husband', now)).toEqual([]);
    expect(outdatedYears('<p>Stand: März 2025</p>', 'X', now)[0].detail).toMatch(/2025/);
  });

  it('lists external links, removes dead ones keeping their words, and needs evidence beyond age', () => {
    const html = '<p>See <a href="https://dead.example/page">the old interview</a> and <a href="https://celeb.example/other/">our profile</a> and <a href="https://live.example/">this</a>.</p>';
    expect(externalLinks(html, 'www.celeb.example').map((l) => l.url)).toEqual(['https://dead.example/page', 'https://live.example/']);
    const fixed = unlinkUrls(html, ['https://dead.example/page']);
    expect(fixed.html).toContain('See the old interview and');
    expect(fixed.html).not.toContain('dead.example');
    expect(fixed.html).toContain('href="https://live.example/"');
    expect(fixed.removed).toEqual([{ url: 'https://dead.example/page', text: 'the old interview' }]);
    expect(needsRefresh([{ code: 'AGE', detail: '', evidence: '' }])).toBe(false);
    expect(needsRefresh([{ code: 'AGE', detail: '', evidence: '' }, { code: 'BROKEN_LINK', detail: '', evidence: 'x' }])).toBe(true);
    expect(priorityOf([{ code: 'BROKEN_LINK', detail: '', evidence: 'a' }, { code: 'BROKEN_LINK', detail: '', evidence: 'b' }, { code: 'OUTDATED_YEAR', detail: '', evidence: '' }])).toBe(70);
  });
});
