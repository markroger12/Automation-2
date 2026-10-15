import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { GSC_FIXTURE, makeZip } from '../helpers/zip';

/** Search Performance (upgrade 10) with fixture exports: only imported data, honest states. */
let client: PrismaClient;
let sp: typeof import('@/lib/search-performance/service');
let siteId: string;
const tasks: Record<string, string> = {};

const file = (name: string, text: string) => ({ name, bytes: Buffer.from(text, 'utf8') });
const daysCsv = (end: string, n: number, clicks: (i: number) => number) => {
  const rows = ['Date,Clicks,Impressions,CTR,Position'];
  for (let i = 0; i < n; i++) {
    const d = new Date(`${end}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - i);
    rows.push(`${d.toISOString().slice(0, 10)},${clicks(i)},${clicks(i) * 20},5%,8.0`);
  }
  return `${rows.join('\n')}\n`;
};

async function article(key: string, slug: string, publishedAt: Date, status = 'ACTIVE') {
  const create = await import('@/lib/tasks/create');
  const cat = await client.category.findFirstOrThrow({ where: { websiteId: siteId } });
  const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: key, websiteId: siteId, categoryId: cat.id, idempotencyKey: `sp:${key}` }, { source: 'SINGLE' });
  const wpPostId = 100 + Object.keys(tasks).length;
  await client.articleTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', wpPostId, selectedTitle: key } });
  await client.linkTarget.create({ data: { websiteId: siteId, wpPostId, url: `https://celeb.example/${slug}/`, title: key, status, publishedAt } });
  tasks[key] = task.id;
  return task.id;
}

beforeAll(async () => {
  ({ client } = await setupTestDb());
  sp = await import('@/lib/search-performance/service');
  const websites = await import('@/lib/websites');
  siteId = (await websites.createWebsite({ name: 'Celeb News', publicUrl: 'https://celeb.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
  await client.category.create({ data: { websiteId: siteId, externalId: 7, name: 'Stars' } });
  await article('Tom Kaulitz', 'tom-kaulitz', new Date('2026-08-01T10:00:00Z'));
  await article('Bill Kaulitz', 'bill-kaulitz', new Date('2026-08-01T10:00:00Z'));
  await article('Heidi Klum', 'heidi-klum', new Date('2026-08-02T10:00:00Z'));
  await article('Brand New Post', 'brand-new-post', new Date('2026-10-10T10:00:00Z'));
});

describe('Search Performance', () => {
  it('without a property it is NOT CONNECTED and refuses imports; with one and no import it is NO VERIFIED DATA', async () => {
    expect((await sp.searchPerformance(siteId)).state).toBe('NOT_CONNECTED');
    await expect(sp.importSearchExport(siteId, [file('Pages.csv', GSC_FIXTURE.pages)])).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
    await client.website.update({ where: { id: siteId }, data: { searchConsoleProperty: 'sc-domain:celeb.example' } });
    const s = await sp.searchPerformance(siteId);
    expect([s.state, s.property]).toEqual(['NO_DATA', 'sc-domain:celeb.example']);
    expect('trend' in s).toBe(false);
  });

  it('refuses another property, other search types, a missing period and the same export twice', async () => {
    await expect(sp.importSearchExport(siteId, [file('Pages.csv', 'Top pages,Clicks,Impressions,CTR,Position\nhttps://other.example/a/,1,2,50%,3\n'), file('Dates.csv', GSC_FIXTURE.dates)])).rejects.toMatchObject({ code: 'WRONG_PROPERTY' });
    await expect(sp.importSearchExport(siteId, [file('Pages.csv', GSC_FIXTURE.pages), file('Dates.csv', GSC_FIXTURE.dates), file('Filters.csv', 'Filter,Value\nSearch type,Image\n')])).rejects.toMatchObject({ code: 'UNSUPPORTED_SEARCH_TYPE' });
    await expect(sp.importSearchExport(siteId, [file('Pages.csv', GSC_FIXTURE.pages)])).rejects.toMatchObject({ code: 'PERIOD_REQUIRED' });
    await expect(sp.importSearchExport(siteId, [file('notes.txt', 'hello')])).rejects.toThrow(/not a Search Console/);
    await expect(sp.importSearchExport(siteId, [file('Countries.csv', 'Country,Clicks,Impressions,CTR,Position\nGermany,1,2,3%,4\n')], { start: '2026-09-01', end: '2026-09-28' })).rejects.toThrow(/No Search Console performance table/);
    expect(await client.searchPerformanceSnapshot.count()).toBe(0);
  });

  it('imports a zipped export: 7/28/90-day trends, pages matched to articles, queries, indexing kept apart', async () => {
    const zip = makeZip([
      { name: 'Pages.csv', text: 'Top pages,Clicks,Impressions,CTR,Position\nhttps://celeb.example/tom-kaulitz/,"1,204",23411,5.14%,7.2\nhttps://www.celeb.example/bill-kaulitz,88,9001,0.98%,14.6\nhttps://celeb.example/heidi-klum/,0,0,0%,0\n', deflate: true },
      { name: 'Queries.csv', text: GSC_FIXTURE.queries, deflate: true },
      { name: 'Dates.csv', text: daysCsv('2026-10-13', 14, (i) => (i < 7 ? 10 : 20)), deflate: true },
      { name: 'Filters.csv', text: GSC_FIXTURE.filters },
    ]);
    const res = await sp.importSearchExport(siteId, [{ name: 'celeb.example-Performance-on-Search-2026-10-14.zip', bytes: zip }]);
    expect(res.snapshot).toMatchObject({ startDate: '2026-09-30', endDate: '2026-10-13', pageRows: 3, queryRows: 2, dateRows: 14, compare: false, dateFilter: 'Last 28 days' });
    await expect(sp.importSearchExport(siteId, [{ name: 'again.zip', bytes: zip }])).rejects.toMatchObject({ code: 'ALREADY_IMPORTED' });
    // Indexing: a request (workflow) and the owner's own confirmation are counted apart from impressions in the data.
    const wf = await client.workflow.create({ data: { websiteId: siteId, name: 'WF' } });
    await client.workflowKeyword.create({ data: { workflowId: wf.id, keyword: 'Heidi Klum', normalizedKeyword: 'heidi klum', position: 1, status: 'INDEXING_REQUESTED', taskId: tasks['Heidi Klum'], indexingRequestedAt: new Date() } });
    await client.workflowKeyword.create({ data: { workflowId: wf.id, keyword: 'Tom Kaulitz', normalizedKeyword: 'tom kaulitz', position: 2, status: 'INDEXED', taskId: tasks['Tom Kaulitz'] } });

    const s = await sp.searchPerformance(siteId);
    if (s.state !== 'DATA') throw new Error(s.state);
    const week = s.trend.trends.find((t) => t.days === 7)!;
    expect(week.current).toMatchObject({ start: '2026-10-07', end: '2026-10-13', covered: 7, clicks: 70, impressions: 1400, ctr: 5, position: 8 });
    expect(week.previous).toMatchObject({ covered: 7, clicks: 140 });
    expect(week.clicksChangePct).toBe(-50);
    const month = s.trend.trends.find((t) => t.days === 28)!;
    expect([month.current.covered, month.clicksChangePct]).toEqual([14, null]);
    expect(s.pages.map((p) => [p.clicks, p.taskId])).toEqual([
      [1204, tasks['Tom Kaulitz']],
      [88, tasks['Bill Kaulitz']], // www. and the missing trailing slash still match
      [0, tasks['Heidi Klum']],
    ]);
    expect(s.queries.map((q) => q.key)).toEqual(['tom kaulitz', 'tom kaulitz, heidi klum']);
    // Zero impressions: Heidi Klum (0 impressions); the post published 3 days before the report ended is too young.
    expect(s.zero.map((z) => [z.taskId, z.detail])).toEqual([[tasks['Heidi Klum'], '0 impressions in 2026-09-30 – 2026-10-13']]);
    expect(s.indexing).toEqual({ published: 4, requested: 1, confirmedByOwner: 1, seenInSearch: 2 });
    expect(s.declining).toEqual([]); // no comparison period yet
  });

  it('finds declining pages from a compare export or an earlier report of the same length', async () => {
    const compare = 'Top pages,Last 14 days Clicks,Previous 14 days Clicks,Last 14 days Impressions,Previous 14 days Impressions,Last 14 days CTR,Previous 14 days CTR,Last 14 days Position,Previous 14 days Position\nhttps://celeb.example/tom-kaulitz/,300,1000,9000,20000,3.3%,5%,9,6\nhttps://celeb.example/bill-kaulitz/,8,9,500,600,1.6%,1.5%,15,15\n';
    await sp.importSearchExport(siteId, [file('Pages.csv', compare)], { start: '2026-10-14', end: '2026-10-27' });
    let s = await sp.searchPerformance(siteId);
    if (s.state !== 'DATA') throw new Error(s.state);
    expect(s.pagesReport).toMatchObject({ start: '2026-10-14', end: '2026-10-27', compare: true });
    expect(s.declining.map((d) => [d.taskId, d.clicks, d.prevClicks, d.changePct])).toEqual([[tasks['Tom Kaulitz'], 300, 1000, -70]]);
    // Without comparison columns: the earlier report of the same length (2026-09-30 – 2026-10-13, 14 days) is used.
    await sp.importSearchExport(siteId, [file('Pages.csv', 'Top pages,Clicks,Impressions,CTR,Position\nhttps://celeb.example/tom-kaulitz/,200,9000,2.2%,9\nhttps://celeb.example/bill-kaulitz/,80,8000,1%,15\n')], { start: '2026-10-14', end: '2026-10-27' });
    s = await sp.searchPerformance(siteId);
    if (s.state !== 'DATA') throw new Error(s.state);
    expect(s.declining.map((d) => [d.taskId, d.changePct, d.basis])).toEqual([[tasks['Tom Kaulitz'], -83.4, 'report 2026-09-30 – 2026-10-13']]);
    // Bill: 80 vs 88 is not a decline. Heidi and the newer post (old enough now) have no row in the latest report.
    expect(s.zero.map((z) => [z.taskId, z.detail])).toEqual([
      [tasks['Heidi Klum'], 'not in the page report 2026-10-14 – 2026-10-27'],
      [tasks['Brand New Post'], 'not in the page report 2026-10-14 – 2026-10-27'],
    ]);
  });

  it('a capped page export proves nothing about missing pages; CSV export escapes formulas', async () => {
    const rows = ['Top pages,Clicks,Impressions,CTR,Position', ...Array.from({ length: 1000 }, (_, i) => `https://celeb.example/p-${i}/,1,10,10%,9`)];
    await sp.importSearchExport(siteId, [file('Pages.csv', `${rows.join('\n')}\n`), file('Queries.csv', 'Top queries,Clicks,Impressions,CTR,Position\n=1+2,1,2,50%,1\n')], { start: '2026-10-28', end: '2026-11-10' });
    const s = await sp.searchPerformance(siteId);
    if (s.state !== 'DATA') throw new Error(s.state);
    expect(s.pagesReport?.capped).toBe(true);
    expect(s.zero).toEqual([]);
    const csv = await sp.exportSearchCsv(siteId, 'queries');
    expect(csv.split('\r\n')[0]).toBe('query,clicks,impressions,ctr_percent,position,period');
    expect(csv).toContain(`"'=1+2",1,2,50,1,2026-10-28 – 2026-11-10`);
    expect((await sp.exportSearchCsv(siteId, 'pages')).split('\r\n').length).toBe(1 + 200 + 1);
  });

  it('removing every import goes back to NO VERIFIED DATA', async () => {
    for (const snap of await client.searchPerformanceSnapshot.findMany()) await sp.deleteSearchSnapshot(snap.id);
    expect(await client.searchPerformanceRow.count()).toBe(0);
    expect((await sp.searchPerformance(siteId)).state).toBe('NO_DATA');
    expect(await client.auditLog.count({ where: { action: 'search.import.delete' } })).toBe(4);
    await expect(sp.exportSearchCsv(siteId, 'pages')).rejects.toMatchObject({ code: 'NO_DATA' });
  });
});
