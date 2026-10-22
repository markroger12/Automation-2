import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { makeServiceAccount, startFakeGoogle, type AnalyticsBody, type FakeGoogle } from '../fixtures/fake-google';

/**
 * Live Search Console (owner request): service-account login, sync into the Search Performance analysis, sitemap
 * resubmit ~35 s after a verified publish, and Google's URL Inspection as proof. Against a fake Google.
 */
let client: PrismaClient;
let google: FakeGoogle;
let gsc: typeof import('@/lib/gsc/client');
let sync: typeof import('@/lib/gsc/sync');
let siteId: string;
const sa = makeServiceAccount();
const PROPERTY = 'sc-domain:promizeiten.example';
const NOW = new Date('2026-10-16T12:00:00Z'); // 05:00 in Pacific Time: “today” is 2026-10-16
let indexedUrls = new Set<string>();
// The service account's properties (the fake reads this array, so a test can share another property).
const properties = [{ siteUrl: PROPERTY, permissionLevel: 'SITE_FULL_USER' }];

function analytics(body: AnalyticsBody) {
  const dim = body.dimensions[0];
  if (dim === 'date') {
    const rows = [];
    for (let t = Date.parse(`${body.startDate}T00:00:00Z`); t <= Date.parse(`${body.endDate}T00:00:00Z`); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      rows.push({ keys: [d], clicks: 10, impressions: 200, ctr: 0.05, position: 8.5 });
    }
    return { rows: rows.slice(body.startRow, body.startRow + body.rowLimit), metadata: { firstIncompleteDate: '2026-10-14' } };
  }
  const current = body.startDate === '2026-09-19';
  if (dim === 'page') {
    // 30,000 pages in the current period: two API pages of up to 25,000 rows.
    const all = Array.from({ length: current ? 30_000 : 2 }, (_, i) => ({ keys: [`https://promizeiten.example/p${i}/`], clicks: i === 0 ? (current ? 3 : 40) : 1, impressions: 50, ctr: 0.02, position: 12 }));
    return { rows: all.slice(body.startRow, body.startRow + body.rowLimit) };
  }
  if (dim === 'query') return { rows: [{ keys: ['daphne govers'], clicks: current ? 25 : 5, impressions: 400, ctr: 0.06, position: 4.2 }] };
  if (dim === 'hour') {
    expect(body.dataState).toBe('hourly_all');
    return { rows: [0, 1, 2].map((h) => ({ keys: [`2026-10-16T0${h}:00:00-07:00`], clicks: h, impressions: 10 + h, ctr: 0.1, position: 5 })), metadata: { firstIncompleteHour: '2026-10-16T02:00:00-07:00' } };
  }
  return { rows: [] };
}

beforeAll(async () => {
  ({ client } = await setupTestDb());
  google = await startFakeGoogle({
    publicKey: sa.publicKey,
    email: sa.email,
    properties,
    analytics,
    sitemaps: ['https://promizeiten.example/sitemap_index.xml'],
    inspection: (url) => (indexedUrls.has(url) ? { verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-10-16T13:05:00Z' } : { verdict: 'NEUTRAL', coverageState: 'Discovered - currently not indexed' }),
  });
  process.env.GSC_TOKEN_URL = `${google.url}/token`;
  process.env.GSC_API_BASE = google.url;
  gsc = await import('@/lib/gsc/client');
  sync = await import('@/lib/gsc/sync');
  const websites = await import('@/lib/websites');
  siteId = (await websites.createWebsite({ name: 'Promizeiten', publicUrl: 'https://promizeiten.example', language: 'de', targetCountry: 'Germany', timezone: 'UTC' })).id;
  await client.website.update({ where: { id: siteId }, data: { searchConsoleProperty: PROPERTY } });
});
afterAll(async () => {
  await google?.close();
  delete process.env.GSC_TOKEN_URL;
  delete process.env.GSC_API_BASE;
});

describe('Search Console connection', () => {
  it('refuses a file that is not a service-account key; stores a real one without ever returning the private key', async () => {
    expect(() => gsc.saveKey('{"type":"authorized_user"}')).toThrow(/not a service-account key/);
    expect(() => gsc.saveKey('not json')).toThrow(/not the JSON key file/);
    const key = gsc.saveKey(sa.json);
    expect(key.client_email).toBe(sa.email);
    const { GET } = await import('../../app/api/search-console/route');
    const res = await GET(new Request('http://127.0.0.1:3000/api/search-console?test=1', { headers: { host: '127.0.0.1:3000' } }) as never, { params: Promise.resolve({}) } as never);
    const body = await res.json();
    expect(body).toMatchObject({ connected: true, email: sa.email, project: 'test-project', properties: [{ siteUrl: PROPERTY }] });
    expect(JSON.stringify(body)).not.toContain('PRIVATE KEY');
    const { redactString } = await import('@/lib/redact');
    expect(redactString(sa.json)).not.toContain('MII');
  });

  it('a key Google does not accept says so (signature checked by the fake token endpoint)', async () => {
    const other = makeServiceAccount(sa.email);
    gsc.saveKey(other.json);
    gsc.resetGscToken();
    await expect(gsc.listProperties()).rejects.toThrow(/Google refused the service-account key: Invalid JWT Signature/);
    gsc.saveKey(sa.json);
    gsc.resetGscToken();
  });
});

describe('live sync', () => {
  it('stores 16 months of days, all pages (paged) and queries with the previous 28 days, and the last hours; the analysis uses them', async () => {
    const before = google.tokens;
    const r = await sync.syncWebsite(siteId, NOW);
    expect(r).toMatchObject({ ok: true, firstIncompleteDate: '2026-10-14', pages: 30_000, queries: 1, hours: 3 });
    expect(r.days).toBe(481);
    expect(google.tokens - before).toBe(1); // one token for the whole sync, reused
    const pageCalls = google.calls.filter((c) => (c.body as AnalyticsBody | undefined)?.dimensions?.[0] === 'page' && (c.body as AnalyticsBody).startDate === '2026-09-19');
    expect(pageCalls.map((c) => (c.body as AnalyticsBody).startRow)).toEqual([0, 25_000]);
    const { searchPerformance } = await import('@/lib/search-performance/service');
    const data = await searchPerformance(siteId);
    expect(data.state).toBe('DATA');
    if (data.state !== 'DATA') return;
    expect(data.pagesReport).toMatchObject({ start: '2026-09-19', end: '2026-10-16', compare: true, capped: false, live: true });
    expect(data.queries[0]).toMatchObject({ key: 'daphne govers', clicks: 25, prevClicks: 5 });
    expect(data.declining.map((d) => d.url)).toEqual(['https://promizeiten.example/p0/']); // 40 → 3 clicks
    expect(data.hourly.map((h) => h.key)[0]).toBe('2026-10-16T02:00:00-07:00');
    expect(data.trend?.trends.length).toBeGreaterThan(0);
    expect(data.liveSync).toMatchObject({ ok: true });
  });

  it('a new sync replaces the previous live data; imported exports are kept; a permission problem is stored and readable', async () => {
    await client.searchPerformanceSnapshot.create({ data: { websiteId: siteId, property: PROPERTY, fileName: 'export.zip', sha256: 'export-1', startDate: '2026-08-01', endDate: '2026-08-28' } });
    await sync.syncWebsite(siteId, new Date(NOW.getTime() + 3 * 3600_000));
    expect(await client.searchPerformanceSnapshot.count({ where: { websiteId: siteId, source: 'GSC_API' } })).toBe(1);
    expect(await client.searchPerformanceSnapshot.count({ where: { websiteId: siteId, source: 'GSC_EXPORT' } })).toBe(1);
    // A website none of whose properties is shared with the service account: the message names what it can use.
    await client.website.update({ where: { id: siteId }, data: { searchConsoleProperty: 'sc-domain:other.example', publicUrl: 'https://other.example' } });
    await expect(sync.syncWebsite(siteId, NOW)).rejects.toThrow(/bas-sync@test-project\.iam\.gserviceaccount\.com has no access to sc-domain:other\.example \(it can use: sc-domain:promizeiten\.example\).*add bas-sync@test-project\.iam\.gserviceaccount\.com with “Full” permission/);
    const { getValue } = await import('@/lib/settings');
    expect(await getValue<{ ok: boolean; error: string }>(sync.syncKey(siteId), { ok: true, error: '' })).toMatchObject({ ok: false });
    await client.website.update({ where: { id: siteId }, data: { searchConsoleProperty: PROPERTY, publicUrl: 'https://promizeiten.example' } });
  });

  it('owner report: a website shared as a URL-prefix property is found although “sc-domain:” was set', async () => {
    const websites = await import('@/lib/websites');
    const easy = (await websites.createWebsite({ name: 'Easy Vibs', publicUrl: 'https://easyvibs.example', language: 'en', targetCountry: 'United Kingdom', timezone: 'UTC' })).id;
    await client.website.update({ where: { id: easy }, data: { searchConsoleProperty: 'sc-domain:easyvibs.example' } });
    properties.push({ siteUrl: 'https://easyvibs.example/', permissionLevel: 'SITE_OWNER' });
    try {
      const r = await sync.syncWebsite(easy, NOW);
      expect(r.ok).toBe(true);
      expect((await client.website.findUniqueOrThrow({ where: { id: easy } })).searchConsoleProperty).toBe('https://easyvibs.example/');
      expect(google.calls.some((c) => c.path === '/webmasters/v3/sites/https://easyvibs.example//searchAnalytics/query')).toBe(true);
      expect(google.calls.some((c) => c.path.startsWith('/webmasters/v3/sites/sc-domain:easyvibs.example/'))).toBe(false);
      expect((await client.log.findFirstOrThrow({ where: { category: 'search-console' }, orderBy: { createdAt: 'desc' } })).message).toMatch(/Easy Vibs: Search Console property https:\/\/easyvibs\.example\/ detected .*sc-domain:easyvibs\.example is not shared with it/);
    } finally {
      properties.pop();
    }
  });

  it('which property stands for a website: the configured one when usable, else domain, the address, then www/http variants', async () => {
    const { pickProperty, propertyCandidates } = await import('@/lib/gsc/property');
    expect(propertyCandidates('https://www.easyvibs.co.uk')).toEqual(['sc-domain:easyvibs.co.uk', 'https://www.easyvibs.co.uk/', 'https://easyvibs.co.uk/', 'http://www.easyvibs.co.uk/', 'http://easyvibs.co.uk/']);
    const full = (siteUrl: string) => ({ siteUrl, permissionLevel: 'SITE_FULL_USER' });
    expect(pickProperty('sc-domain:easyvibs.co.uk', 'https://easyvibs.co.uk', [full('https://easyvibs.co.uk/')])).toEqual({ property: 'https://easyvibs.co.uk/', detected: true });
    expect(pickProperty('sc-domain:easyvibs.co.uk', 'https://easyvibs.co.uk', [full('sc-domain:easyvibs.co.uk'), full('https://easyvibs.co.uk/')])).toEqual({ property: 'sc-domain:easyvibs.co.uk', detected: false });
    expect(pickProperty(null, 'https://easyvibs.co.uk', [full('https://www.easyvibs.co.uk/')])).toEqual({ property: 'https://www.easyvibs.co.uk/', detected: true });
    // An unverified entry is not usable; another website's property never stands in.
    expect(pickProperty('sc-domain:easyvibs.co.uk', 'https://easyvibs.co.uk', [{ siteUrl: 'https://easyvibs.co.uk/', permissionLevel: 'siteUnverifiedUser' }, full('https://other.example/')])).toEqual({ property: 'sc-domain:easyvibs.co.uk', detected: false });
  });
});

describe('indexing after a workflow publish', () => {
  async function publishedKeyword(keyword: string, url: string, requestIndexing: boolean, publishedAt: Date) {
    const wf = (await client.workflow.findFirst({ where: { websiteId: siteId, requestIndexing } })) ?? (await client.workflow.create({ data: { websiteId: siteId, name: `wf ${requestIndexing}`, requestIndexing } }));
    return client.workflowKeyword.create({ data: { workflowId: wf.id, keyword, normalizedKeyword: keyword.toLowerCase(), position: 1, status: 'PUBLISHED', publishedUrl: url, publishedAt } });
  }

  it('resubmits the sitemap ~35 s after publishing, then marks INDEXED only when Google says the URL is on Google', async () => {
    const publishedAt = new Date('2026-10-16T12:00:00Z');
    const kw = await publishedKeyword('Daphne Govers', 'https://promizeiten.example/daphne-govers/', true, publishedAt);
    // 20 s after publishing: too early.
    expect(await sync.indexingTick(new Date(publishedAt.getTime() + 20_000))).toMatchObject({ submitted: 0 });
    const t1 = new Date(publishedAt.getTime() + 36_000);
    expect(await sync.indexingTick(t1)).toMatchObject({ submitted: 1 });
    expect(google.submitted).toEqual(['https://promizeiten.example/sitemap_index.xml']);
    let row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row.status).toBe('INDEXING_REQUESTED');
    expect(row.indexingRequestedAt?.toISOString()).toBe(t1.toISOString());
    expect(row.indexingStatus).toMatch(/Sitemap resubmitted to Google .* A request is not proof of indexing/);
    expect(row.indexCheckAt?.toISOString()).toBe('2026-10-16T13:00:00.000Z'); // 1 h after publishing
    // 1 h: Google has not indexed it yet → next check at 6 h.
    expect(await sync.indexingTick(new Date('2026-10-16T13:00:30Z'))).toMatchObject({ inspected: 1, indexed: 0 });
    row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row.status).toBe('INDEXING_REQUESTED');
    expect(row.indexingStatus).toMatch(/Google: not on Google yet \(Discovered - currently not indexed/);
    expect(row.indexCheckAt?.toISOString()).toBe('2026-10-16T18:00:00.000Z');
    // 6 h: indexed.
    indexedUrls = new Set(['https://promizeiten.example/daphne-govers/']);
    expect(await sync.indexingTick(new Date('2026-10-16T18:00:10Z'))).toMatchObject({ inspected: 1, indexed: 1 });
    row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row).toMatchObject({ status: 'INDEXED', indexCheckAt: null, indexChecks: 2 });
    expect(row.indexingStatus).toMatch(/^Google: URL is on Google \(Submitted and indexed · last crawl 2026-10-16T13:05:00Z/);
  });

  it('without the workflow switch nothing is requested, but Google is still asked; after 14 days the checks stop', async () => {
    indexedUrls = new Set();
    const publishedAt = new Date('2026-10-01T00:00:00Z');
    const kw = await publishedKeyword('Ohne Antrag', 'https://promizeiten.example/ohne-antrag/', false, publishedAt);
    const submittedBefore = google.submitted.length;
    await sync.indexingTick(new Date('2026-10-01T00:01:00Z'));
    let row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(google.submitted.length).toBe(submittedBefore);
    expect(row).toMatchObject({ status: 'PUBLISHED', indexingRequestedAt: null });
    expect(row.indexingStatus).toMatch(/Indexing not requested/);
    // Walk through every scheduled check without an index: the last one ends the checks.
    for (let i = 0; i < 16; i++) {
      row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
      if (!row.indexCheckAt) break;
      await sync.indexingTick(new Date(row.indexCheckAt.getTime() + 1000));
    }
    row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row.indexCheckAt).toBeNull();
    expect(row.indexChecks).toBe(sync.CHECK_OFFSETS_H.length);
    expect(row.indexingStatus).toMatch(/Not indexed 14 days after publishing/);
  });

  it('does nothing without a connected key', async () => {
    gsc.forgetKey();
    expect(await sync.indexingTick(new Date('2026-10-20T00:00:00Z'))).toEqual({ submitted: 0, inspected: 0, indexed: 0 });
    expect(await sync.syncDue()).toEqual([]);
    gsc.saveKey(sa.json);
  });
});
