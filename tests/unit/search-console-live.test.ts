import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { makeServiceAccount, startFakeGoogle, type AnalyticsBody, type FakeGoogle } from '../fixtures/fake-google';

/**
 * Live Search Console (owner request): service-account login, sync into the Search Performance analysis, “Request
 * indexing” queued for Automation Chrome ~35 s after a verified publish (URL Inspection → Request indexing, as the
 * owner does it; not a sitemap resubmit), and Google's URL Inspection as proof. Against a fake Google.
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

  it('~35 s after publishing, “Request indexing” is queued for Automation Chrome (not a sitemap); INDEXED only when Google says the URL is on Google', async () => {
    const ri = await import('@/lib/gsc/request-indexing');
    const publishedAt = new Date('2026-10-16T12:00:00Z');
    const kw = await publishedKeyword('Daphne Govers', 'https://promizeiten.example/daphne-govers/', true, publishedAt);
    // 20 s after publishing: too early.
    expect(await sync.indexingTick(new Date(publishedAt.getTime() + 20_000))).toMatchObject({ submitted: 0 });
    const t1 = new Date(publishedAt.getTime() + 36_000);
    expect(await sync.indexingTick(t1)).toMatchObject({ submitted: 1 });
    expect(google.submitted).toEqual([]); // no sitemap resubmit any more
    const jobs = await client.queueJob.findMany({ where: { queue: 'gsc' } });
    expect(jobs).toHaveLength(1);
    expect(JSON.parse(jobs[0].payload)).toEqual({ keywordId: kw.id, url: 'https://promizeiten.example/daphne-govers/', property: PROPERTY, websiteId: siteId, inspectLink: 'https://search.google.com/search-console/inspect?x' });
    let row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    // Queued is not requested: the status changes only when Automation Chrome reports the click.
    expect(row.status).toBe('PUBLISHED');
    expect(row.indexingStatus).toMatch(/Waiting for Automation Chrome to request indexing in Search Console/);
    expect(row.indexCheckAt?.toISOString()).toBe('2026-10-16T13:00:00.000Z'); // 1 h after publishing
    // A second tick does not queue it again.
    expect(await sync.indexingTick(new Date(t1.getTime() + 5000))).toMatchObject({ submitted: 0 });
    expect(await ri.waitingIndexingRequests(t1)).toBe(1);
    const claimed = await ri.claimIndexingRequest('install-1', new Date(t1.getTime() + 10_000));
    // As the owner does it: the property's page, where the URL is typed into “Inspect any URL”; Google's own inspection
    // link (from the URL Inspection API, the key being connected) as the fallback. Never …/inspect?id=<post URL> (404).
    expect(claimed).toEqual({ id: jobs[0].id, url: 'https://promizeiten.example/daphne-govers/', property: PROPERTY, inspectUrl: `https://search.google.com/search-console?resource_id=${encodeURIComponent(PROPERTY)}`, altUrl: 'https://search.google.com/search-console/inspect?x' });
    expect(await ri.claimIndexingRequest('install-1', new Date(t1.getTime() + 11_000))).toBeNull(); // leased
    const t2 = new Date(t1.getTime() + 60_000);
    await ri.reportIndexingRequest({ jobId: jobs[0].id, installId: 'install-1', outcome: 'REQUESTED', message: 'Indexing requested' }, t2);
    row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row.status).toBe('INDEXING_REQUESTED');
    expect(row.indexingRequestedAt?.toISOString()).toBe(t2.toISOString());
    expect(row.indexingStatus).toMatch(/Indexing requested in Search Console \(URL Inspection → Request indexing\) .* A request is not proof of indexing/);
    expect((await client.queueJob.findUniqueOrThrow({ where: { id: jobs[0].id } })).status).toBe('COMPLETED');
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
    const queuedBefore = await client.queueJob.count({ where: { queue: 'gsc' } });
    await sync.indexingTick(new Date('2026-10-01T00:01:00Z'));
    let row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(await client.queueJob.count({ where: { queue: 'gsc' } })).toBe(queuedBefore);
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

  it('a request that is still waiting (Google signed out in Automation Chrome) stays visible next to Google’s answer; INDEXED is never stepped back', async () => {
    const ri = await import('@/lib/gsc/request-indexing');
    indexedUrls = new Set();
    const publishedAt = new Date('2026-10-17T00:00:00Z');
    const kw = await publishedKeyword('Signed Out', 'https://promizeiten.example/signed-out/', true, publishedAt);
    await sync.indexingTick(new Date('2026-10-17T00:01:00Z'));
    const claimed = await ri.claimIndexingRequest('install-1', new Date('2026-10-17T00:01:10Z'));
    await ri.reportIndexingRequest({ jobId: claimed!.id, installId: 'install-1', outcome: 'NOT_SIGNED_IN' }, new Date('2026-10-17T00:02:00Z'));
    const job = await client.queueJob.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(job).toMatchObject({ status: 'WAITING', errorCode: 'NOT_SIGNED_IN' });
    expect(job.runAt.toISOString()).toBe('2026-10-17T01:02:00.000Z');
    await sync.indexingTick(new Date('2026-10-17T01:00:10Z'));
    let row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row.status).toBe('PUBLISHED');
    expect(row.indexingStatus).toMatch(/^Google: not on Google yet .* · Request indexing: Sign in to Google \(Search Console\) in Automation Chrome/);
    // The request is made while Google indexes it: a late report never steps INDEXED back.
    const again = await ri.claimIndexingRequest('install-1', new Date('2026-10-17T06:00:00Z'));
    indexedUrls = new Set(['https://promizeiten.example/signed-out/']);
    await sync.indexingTick(new Date('2026-10-17T06:00:10Z'));
    await ri.reportIndexingRequest({ jobId: again!.id, installId: 'install-1', outcome: 'REQUESTED' }, new Date('2026-10-17T06:02:00Z'));
    row = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(row.status).toBe('INDEXED');
    expect(row.indexingStatus).toMatch(/^Google: URL is on Google/);
    // A request still queued for a URL Google already shows (or a deleted keyword) is dropped, not opened.
    const late = await publishedKeyword('Late Request', 'https://promizeiten.example/late-request/', true, new Date('2026-10-17T07:00:00Z'));
    await sync.indexingTick(new Date('2026-10-17T07:01:00Z'));
    await client.workflowKeyword.update({ where: { id: late.id }, data: { status: 'INDEXED' } });
    expect(await ri.claimIndexingRequest('install-1', new Date('2026-10-17T07:02:00Z'))).toBeNull();
    expect(await client.queueJob.findUniqueOrThrow({ where: { idempotencyKey: `gsc-index:${late.id}` } })).toMatchObject({ status: 'CANCELLED', error: 'Google already shows the URL as indexed.' });
  });

  it('daily limit: asked again the next day; an account without access to the property fails with what to do', async () => {
    const ri = await import('@/lib/gsc/request-indexing');
    const a = await publishedKeyword('Quota Day', 'https://promizeiten.example/quota-day/', true, new Date('2026-10-18T00:00:00Z'));
    const b = await publishedKeyword('No Access', 'https://promizeiten.example/no-access/', true, new Date('2026-10-18T00:00:00Z'));
    await sync.indexingTick(new Date('2026-10-18T00:01:00Z'));
    const now = new Date('2026-10-18T00:02:00Z');
    const jobA = await client.queueJob.findUniqueOrThrow({ where: { idempotencyKey: `gsc-index:${a.id}` } });
    const jobB = await client.queueJob.findUniqueOrThrow({ where: { idempotencyKey: `gsc-index:${b.id}` } });
    // Only the extension holding the job may report it.
    expect(await ri.reportIndexingRequest({ jobId: jobA.id, installId: 'i', outcome: 'REQUESTED' }, now)).toEqual({ ok: false, error: 'Not claimed by this extension' });
    const claimedIds = [(await ri.claimIndexingRequest('i', now))?.id, (await ri.claimIndexingRequest('i', now))?.id];
    expect(claimedIds.sort()).toEqual([jobA.id, jobB.id].sort());
    expect(await ri.reportIndexingRequest({ jobId: jobA.id, installId: 'other', outcome: 'REQUESTED' }, now)).toEqual({ ok: false, error: 'Not claimed by this extension' });
    await ri.reportIndexingRequest({ jobId: jobA.id, installId: 'i', outcome: 'QUOTA', message: 'Quota exceeded' }, now);
    await ri.reportIndexingRequest({ jobId: jobB.id, installId: 'i', outcome: 'NO_ACCESS' }, now);
    expect((await client.queueJob.findUniqueOrThrow({ where: { id: jobA.id } })).runAt.toISOString()).toBe('2026-10-18T20:02:00.000Z');
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: a.id } })).indexingStatus).toMatch(/daily limit for indexing requests was reached\. Google: “Quota exceeded”/);
    expect((await client.queueJob.findUniqueOrThrow({ where: { id: jobB.id } })).status).toBe('FAILED');
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: b.id } })).indexingStatus).toMatch(/cannot use sc-domain:promizeiten\.example in Search Console/);
    expect(await ri.reportIndexingRequest({ jobId: 'nope', installId: 'i', outcome: 'REQUESTED' })).toEqual({ ok: false, error: 'Unknown job' });
    // A repeated report of a finished job changes nothing.
    expect(await ri.reportIndexingRequest({ jobId: jobB.id, installId: 'i', outcome: 'REQUESTED' }, now)).toEqual({ ok: false, error: 'Not claimed by this extension' });
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('PUBLISHED');
  });

  it('without a connected key indexing is still requested (Automation Chrome needs no key), but Google is not asked', async () => {
    gsc.forgetKey();
    const kw = await publishedKeyword('Ohne Schlüssel', 'https://promizeiten.example/ohne-schluessel/', true, new Date('2026-10-19T00:00:00Z'));
    expect(await sync.indexingTick(new Date('2026-10-20T00:00:00Z'))).toEqual({ submitted: 1, inspected: 0, indexed: 0 });
    expect(await client.queueJob.count({ where: { idempotencyKey: `gsc-index:${kw.id}` } })).toBe(1);
    // A website without a property: its URL is used as a URL-prefix property (as the workflow page's link does).
    const websites = await import('@/lib/websites');
    const other = await websites.createWebsite({ name: 'Ohne Property', publicUrl: 'https://ohne-property.example', language: 'de', targetCountry: 'Germany', timezone: 'UTC' });
    const wf = await client.workflow.create({ data: { websiteId: other.id, name: 'wf other', requestIndexing: true } });
    const okw = await client.workflowKeyword.create({ data: { workflowId: wf.id, keyword: 'Ohne Property', normalizedKeyword: 'ohne property', position: 1, status: 'PUBLISHED', publishedUrl: 'https://ohne-property.example/x/', publishedAt: new Date('2026-10-19T00:00:00Z') } });
    await sync.indexingTick(new Date('2026-10-20T00:00:30Z'));
    const job = await client.queueJob.findUniqueOrThrow({ where: { idempotencyKey: `gsc-index:${okw.id}` } });
    expect(JSON.parse(job.payload).property).toBe('https://ohne-property.example/');
    expect(await sync.syncDue()).toEqual([]);
    gsc.saveKey(sa.json);
  });

  it('owner screenshot: “Index status not checked: fetch failed” says why, and keeps what happened to the indexing request', async () => {
    const ri = await import('@/lib/gsc/request-indexing');
    const net = await import('node:net');
    indexedUrls = new Set();
    const waiting = await publishedKeyword('Andre Rock', 'https://promizeiten.example/andre-rock/', true, new Date('2026-10-21T00:00:00Z'));
    const requested = await publishedKeyword('Andi Rock', 'https://promizeiten.example/andi-rock/', true, new Date('2026-10-21T00:00:00Z'));
    await sync.indexingTick(new Date('2026-10-21T00:01:00Z'));
    const job = await client.queueJob.findUniqueOrThrow({ where: { idempotencyKey: `gsc-index:${requested.id}` } });
    await client.queueJob.updateMany({ where: { queue: 'gsc', id: { not: job.id }, status: 'WAITING', idempotencyKey: { not: `gsc-index:${waiting.id}` } }, data: { status: 'CANCELLED' } });
    while (true) {
      const claimed = await ri.claimIndexingRequest('install-1', new Date('2026-10-21T00:02:00Z'));
      if (!claimed) break;
      if (claimed.id === job.id) await ri.reportIndexingRequest({ jobId: job.id, installId: 'install-1', outcome: 'REQUESTED' }, new Date('2026-10-21T00:03:00Z'));
      else await ri.reportIndexingRequest({ jobId: claimed.id, installId: 'install-1', outcome: 'NOT_SIGNED_IN' }, new Date('2026-10-21T00:03:00Z'));
    }
    // The owner's computer cannot reach Google's API (Node says only “fetch failed”).
    const closedPort = await new Promise<number>((resolve) => {
      const server = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = server.address() as import('node:net').AddressInfo;
        server.close(() => resolve(port));
      });
    });
    process.env.GSC_API_BASE = `http://127.0.0.1:${closedPort}`;
    try {
      await sync.indexingTick(new Date('2026-10-21T01:00:10Z'));
    } finally {
      process.env.GSC_API_BASE = google.url;
    }
    const a = await client.workflowKeyword.findUniqueOrThrow({ where: { id: waiting.id } });
    expect(a.indexingStatus).toBe('Index status not checked: Google could not be reached from this computer (ECONNREFUSED); asked again in an hour. · Request indexing: Sign in to Google (Search Console) in Automation Chrome, then the request is made automatically.');
    const b = await client.workflowKeyword.findUniqueOrThrow({ where: { id: requested.id } });
    expect(b.status).toBe('INDEXING_REQUESTED');
    expect(b.indexingStatus).toBe('Index status not checked: Google could not be reached from this computer (ECONNREFUSED); asked again in an hour. · Indexing requested in Search Console at 2026-10-21T00:03:00.000Z.');
    expect(b.indexCheckAt?.toISOString()).toBe('2026-10-21T02:00:10.000Z');
  });
});
