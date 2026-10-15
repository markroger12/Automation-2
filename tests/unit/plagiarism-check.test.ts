import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

/**
 * Plagiarism Evidence Checker end to end against a local fake web (pages,
 * Wikipedia API, licensed search API); nothing leaves this machine.
 */
let client: PrismaClient;
let server: http.Server;
let PORT = 0;
let net: typeof import('@/lib/links/net');
let sources: typeof import('@/lib/plagiarism/sources');
let service: typeof import('@/lib/plagiarism/service');
let check: typeof import('@/lib/plagiarism/check');
const searchCalls: { key: string | undefined; q: string; url: string }[] = [];

const COPIED_SENTENCE = 'Its concert hall burned down during the war, and the current building opened in 1981 after years of planning by the city council.';
const QUOTE = 'music belongs to everyone in this city and should never depend on the price of a ticket';
const SIMILAR_SOURCE = 'Many visitors attend the summer concerts in the park, which are free of charge and draw large crowds every year.';
const WIKI_SENTENCE = 'The orchestra performs more than seventy concerts in its home hall every season and tours abroad regularly with guest conductors.';
const OWNER_SENTENCE = 'Visitors often combine a concert with a walk through the historic market square and the old town hall nearby.';
const FOUND_SENTENCE = 'Ticket prices for the main season range between twenty and ninety euros depending on the seat category chosen.';
const CTA = 'Subscribe to our newsletter for weekly updates about concerts and events in Leipzig and Saxony.';
const filler = (n: number) => Array.from({ length: n }, (_, i) => `<p>Unrelated paragraph ${i} about gardening, compost, seedlings and the patience every vegetable bed requires in spring.</p>`).join('');

const page = (body: string) => `<!doctype html><html><head><title>Fake page</title></head><body><nav><p>Home News Contact Imprint Privacy Login</p></nav><main>${body}</main><footer><p>All rights reserved by the fake publisher forever.</p></footer></body></html>`;

const u = (host: string, path: string) => `http://${host}:${PORT}${path}`;

function articleHtml() {
  return [
    `<p>The Leipzig Gewandhaus Orchestra has a long history in the city. ${COPIED_SENTENCE}</p>`,
    '<p>Many visitors attend summer concerts in the park, because they are free of charge and draw big crowds each year.</p>',
    `<p>As the orchestra’s director said at the opening, “${QUOTE}” and the audience applauded.</p>`,
    `<p>${WIKI_SENTENCE}</p>`,
    `<p>${OWNER_SENTENCE}</p>`,
    `<p>${FOUND_SENTENCE}</p>`,
    `<p>${CTA}</p>`,
    `<p>Further reading: <a href="${u('copied.example', '/copied')}">the history of the hall</a> and <a href="https://leipzig-music.example/tickets/">our ticket guide</a>.</p>`,
  ].join('');
}

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const host = (req.headers.host ?? '').split(':')[0];
    const html = (body: string) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    };
    if (host === 'copied.example') return html(page(`<p>History. ${COPIED_SENTENCE}</p><p>The director once said: “${QUOTE}”.</p>${filler(3)}`));
    if (host === 'similar.example') return html(page(`<p>${SIMILAR_SOURCE}</p>${filler(3)}`));
    if (host === 'jsonly.example') return html('<!doctype html><html><body><div id="app"></div><script>render()</script></body></html>');
    if (host === 'found.example') return html(page(`<p>Prices. ${FOUND_SENTENCE}</p>${filler(2)}`));
    if (host === 'en.wikipedia.org' && url.pathname === '/w/api.php') {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url.searchParams.get('list') === 'search') return res.end(JSON.stringify({ query: { search: [{ pageid: 7, title: 'Gewandhaus Orchestra' }] } }));
      return res.end(JSON.stringify({ query: { pages: [{ pageid: 7, extract: `Gewandhaus Orchestra\n\n== History ==\nFounded long ago. ${WIKI_SENTENCE} It has a large library of scores and recordings.` }] } }));
    }
    if (host === '127.0.0.1' && url.pathname === '/search' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        searchCalls.push({ key: req.headers['x-api-key'] as string | undefined, q: JSON.parse(body).q, url: req.url ?? '' });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ organic: [{ link: u('found.example', '/found'), title: 'Found' }, { link: 'https://leipzig-music.example/own-page/', title: 'Own site' }] }));
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  PORT = (server.address() as AddressInfo).port;
  net = await import('@/lib/links/net');
  const names = ['copied.example', 'similar.example', 'jsonly.example', 'found.example', 'en.wikipedia.org'];
  net.setLinkNetworkForTests(
    async (host) => {
      if (host === 'intranet.test') return [{ address: '10.0.0.5', family: 4 }];
      if (names.includes(host)) return [{ address: '127.0.0.1', family: 4 }];
      throw new Error('ENOTFOUND');
    },
    names,
  );
  sources = await import('@/lib/plagiarism/sources');
  service = await import('@/lib/plagiarism/service');
  check = await import('@/lib/plagiarism/check');
  sources.setWikipediaApiBaseForTests((lang) => `http://${lang}.wikipedia.org:${PORT}/w/api.php`);
  sources.setSearchEndpointForTests(`http://127.0.0.1:${PORT}/search`);
});

afterAll(async () => {
  net.setLinkNetworkForTests(null);
  sources.setWikipediaApiBaseForTests(null);
  sources.setSearchEndpointForTests(null);
  delete process.env.SERPER_API_KEY;
  await new Promise((r) => server.close(r));
});

async function savedArticle(websiteId: string, keyword: string, html: string) {
  const create = await import('@/lib/tasks/create');
  const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword, websiteId, idempotencyKey: `pl:${keyword}` }, { source: 'SINGLE' });
  await client.articleTask.update({ where: { id: task.id }, data: { assembledHtml: html, status: 'COMPLETED' } });
  return task.id;
}

describe('Plagiarism Evidence Checker', () => {
  let taskId: string;

  it('collects evidence from every source type, exempts quotations and recurring site text, and records coverage', async () => {
    const websites = await import('@/lib/websites');
    const siteA = (await websites.createWebsite({ name: 'Leipzig Music', publicUrl: 'https://leipzig-music.example', language: 'en', targetCountry: 'Germany', timezone: 'Europe/Berlin' })).id;
    const siteB = (await websites.createWebsite({ name: 'Travel Blog', publicUrl: 'https://travel.example', language: 'en', targetCountry: 'Germany', timezone: 'Europe/Berlin' })).id;
    for (const k of ['jazz night', 'opera guide', 'choir festival']) await savedArticle(siteA, k, `<p>Our ${k} story is told here in detail with many unique words about ${k}.</p><p>${CTA}</p>`);
    await savedArticle(siteB, 'leipzig city walk', `<p>A day in Leipzig. ${OWNER_SENTENCE}</p>`);
    taskId = await savedArticle(siteA, 'gewandhaus orchestra', articleHtml());
    process.env.SERPER_API_KEY = 'test-serper-key';

    const created = await service.createPlagiarismCheck({ source: 'ARTICLE', taskId, urls: [u('similar.example', '/similar'), u('jsonly.example', '/'), 'http://intranet.test/secret'], search: true });
    expect(await client.queueJob.count({ where: { queue: 'workflow', kind: 'plagiarism.check', relatedId: created.id } })).toBe(1);
    expect(await check.runPlagiarismCheck(created.id)).toEqual({ status: 'COMPLETED' });
    const res = await service.getPlagiarismCheck(created.id);
    const r = res.result!;
    const byKind = (kind: string) => r.evidence.filter((e) => r.sources[e.source].kind === kind);

    // Verified identical runs, side by side with their source.
    const linked = byKind('LINKED_PAGE');
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ kind: 'exact' });
    expect(linked[0].article.match).toContain('the current building opened in 1981 after years of planning by the city council');
    expect(linked[0].match.match).toBe(linked[0].article.match);
    expect(byKind('WIKIPEDIA')[0]).toMatchObject({ kind: 'exact', words: 20 }); // the whole sentence
    expect(r.sources.find((s) => s.kind === 'WIKIPEDIA')!.url).toBe('https://en.wikipedia.org/wiki/Gewandhaus_Orchestra');
    const owner = byKind('OWNER_ARTICLE');
    expect(owner).toHaveLength(1);
    expect(owner[0].article.match).toBe(OWNER_SENTENCE.replace(/\.$/, ''));
    expect(r.sources[owner[0].source].title).toMatch(/leipzig city walk \(Travel Blog\)/);
    const found = byKind('SEARCH_RESULT');
    expect(found).toHaveLength(1);
    expect(r.sources[found[0].source].query).toBeTruthy();
    // Light rewording: a sentence-level near match with its metrics, not an exact run.
    const near = byKind('USER_URL');
    expect(near).toHaveLength(1);
    expect(near[0]).toMatchObject({ kind: 'near' });
    expect(near[0].shared! / near[0].contentWords!).toBeGreaterThanOrEqual(0.7);

    // Exempt: the quotation (also on the linked page) and the call to action in 3 other articles of the site.
    expect(r.exemptMatches.some((x) => x.reason === 'quotation' && x.text.includes('music belongs to everyone'))).toBe(true);
    expect(r.exempt.boilerplateBlocks).toEqual([{ text: CTA, articles: 3 }]);
    expect(r.exemptMatches.filter((x) => x.reason === 'boilerplate')).toEqual([]); // listed once, as a recurring block
    expect(r.documentsCompared).toBe(4 + 1 + 1 + 1 + 1); // 4 saved articles, linked page, similar page, Wikipedia, search result
    expect(r.evidence.some((e) => e.article.match.includes('Subscribe to our newsletter'))).toBe(false);
    expect(r.exempt.quotedWords).toBeGreaterThanOrEqual(17);

    // Coverage lists everything compared and what failed, with reasons.
    const cov = (label: RegExp) => r.coverage.find((c) => label.test(c.label) || label.test(c.url ?? ''));
    expect(cov(/Your saved articles/)).toMatchObject({ status: 'CHECKED', detail: expect.stringMatching(/4 saved article/) });
    expect(cov(/jsonly/)).toMatchObject({ status: 'FAILED', detail: expect.stringMatching(/almost no readable text/) });
    expect(cov(/intranet\.test/)).toMatchObject({ status: 'FAILED', detail: expect.stringMatching(/private or reserved address/) });
    expect(r.coverage.filter((c) => c.kind === 'SEARCH' && c.status === 'CHECKED').length).toBeGreaterThan(0);
    // The website's own pages (linked or found by search) are not fetched as outside sources.
    expect(r.coverage.some((c) => /leipzig-music\.example/.test(c.url ?? c.label))).toBe(false);

    // The licensed search API got exact-phrase queries and the key only in a header.
    expect(searchCalls.length).toBeGreaterThan(0);
    for (const call of searchCalls) {
      expect(call.key).toBe('test-serper-key');
      expect(call.q).toMatch(/^".+"$/);
      expect(call.url).not.toContain('test-serper-key');
    }
    expect(JSON.stringify(r)).not.toContain('test-serper-key');

    // Evidence, not a verdict: descriptive counts and explicit limitations, no score.
    expect(r.wordsInExactRuns).toBeGreaterThan(40);
    expect(Object.keys(r)).not.toEqual(expect.arrayContaining(['score']));
    expect(JSON.stringify(r)).not.toMatch(/"(score|percent|plagiarised|verdict)"/i);
    expect(r.limitations.join(' ')).toMatch(/No number on this page proves or disproves plagiarism/);
    expect(r.limitations.join(' ')).toMatch(/could not be read/);
    expect(res.message).toMatch(/in 5 of 8 document\(s\) compared\. Review the evidence; this is not a verdict\./);
  });

  it('works without a search key (reported as not configured) and refuses unusable input', async () => {
    delete process.env.SERPER_API_KEY;
    const before = searchCalls.length;
    const c = await service.createPlagiarismCheck({ source: 'ARTICLE', taskId, search: true, linkedPages: false, wikipedia: false });
    await check.runPlagiarismCheck(c.id);
    const r = (await service.getPlagiarismCheck(c.id)).result!;
    expect(r.coverage.find((x) => x.kind === 'SEARCH')).toMatchObject({ status: 'NOT_CONFIGURED' });
    expect(r.limitations[0]).toMatch(/wider web was not searched/);
    expect(searchCalls.length).toBe(before);
    expect(service.plagiarismMeta().searchConfigured).toBe(false);

    await expect(service.createPlagiarismCheck({ source: 'PASTE', html: 'Far too short to check.' })).rejects.toThrow(/too short/);
    await expect(service.createPlagiarismCheck({ source: 'ARTICLE', taskId, urls: ['ftp://example.com/x'] })).rejects.toThrow(/http\(s\)/);
    await expect(service.createPlagiarismCheck({ source: 'ARTICLE', taskId, urls: Array.from({ length: 11 }, (_, i) => `https://e${i}.example/`) })).rejects.toThrow();
    await expect(service.createPlagiarismCheck({ source: 'ARTICLE', taskId, ownerArticles: false, linkedPages: false, wikipedia: false, search: false })).rejects.toThrow(/at least one source/);
  });

  it('runs through the worker loop; a cancelled check is not run', async () => {
    const { plagiarismTick } = await import('@/worker/plagiarism');
    const pasted = `${Array.from({ length: 4 }, () => `<p>${OWNER_SENTENCE.replace('Visitors', 'Tourists')} Extra words keep this paragraph long enough to count properly.</p>`).join('')}<p>${OWNER_SENTENCE}</p>`;
    const a = await service.createPlagiarismCheck({ source: 'PASTE', html: pasted, title: 'Pasted draft', linkedPages: false, wikipedia: false });
    const b = await service.createPlagiarismCheck({ source: 'PASTE', html: pasted, title: 'Cancelled draft', linkedPages: false, wikipedia: false });
    await service.cancelPlagiarismCheck(b.id);
    // Jobs of the earlier checks (run directly above) are claimed first and finish as no-ops.
    for (let i = 0; i < 6; i++) await plagiarismTick('test-worker', () => false);
    expect(await client.queueJob.count({ where: { kind: 'plagiarism.check', status: { in: ['WAITING', 'ACTIVE'] } } })).toBe(0);
    const done = await service.getPlagiarismCheck(a.id);
    expect(done.status).toBe('COMPLETED');
    expect(done.result!.evidence.some((e) => e.kind === 'exact' && done.result!.sources[e.source].kind === 'OWNER_ARTICLE')).toBe(true);
    expect((await service.getPlagiarismCheck(b.id)).status).toBe('CANCELLED');
    expect(await client.queueJob.findFirst({ where: { relatedId: b.id } })).toMatchObject({ status: 'CANCELLED' });
    expect((await service.listPlagiarismChecks()).map((c) => c.title)).toEqual(expect.arrayContaining(['Pasted draft', 'Cancelled draft']));
  });
});
