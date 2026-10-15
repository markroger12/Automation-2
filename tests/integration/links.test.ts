import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient, Website } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { makeDriver } from '../helpers/drive';
import { cannedAnswer } from '../helpers/fake-answers';
import { startFakeWordPress, type FakeWp } from '../fixtures/fake-wordpress';

/**
 * Link verification over real HTTP against a local "fake web": named hosts
 * (en.wikipedia.org, www.imdb.com, …) are resolved to 127.0.0.1 by a TEST-ONLY
 * lookup. These are fixtures, not the real sites.
 */
let client: PrismaClient;
let net: typeof import('@/lib/links/net');
let verify: typeof import('@/lib/links/verify');
let create: typeof import('@/lib/tasks/create');
let webServer: http.Server;
let PORT = 0;
const seenCookies: string[] = [];
const servers: FakeWp[] = [];

const page = (title: string, body: string, lang = 'en') => `<!doctype html><html lang="${lang}"><head><title>${title}</title></head><body><h1>${title.split(' – ')[0].split(' - ')[0]}</h1>${body}</body></html>`;

function fakeWeb(req: http.IncomingMessage, res: http.ServerResponse) {
  const host = (req.headers.host ?? '').split(':')[0];
  const path = req.url ?? '/';
  const send = (status: number, body: string, type = 'text/html; charset=utf-8', headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': type, ...headers });
    res.end(body);
  };
  if (req.headers.cookie) seenCookies.push(req.headers.cookie);
  const key = `${host}${path}`;
  switch (key) {
    case 'en.wikipedia.org/wiki/Tokio_Hotel':
      return send(200, page('Tokio Hotel - Wikipedia', '<p>Tokio Hotel is a German pop rock band.</p>'));
    case 'en.wikipedia.org/wiki/Interpersonal_relationship':
      return send(200, page('Interpersonal relationship - Wikipedia', '<p>An interpersonal relationship is a social association.</p>'));
    case 'en.wikipedia.org/wiki/Heidi_Klum':
      return send(200, page('Heidi Klum - Wikipedia', '<p>Heidi Klum is a German-American model.</p>'));
    case 'en.wikipedia.org/wiki/Mercury':
      return send(200, page('Mercury - Wikipedia', '<p>Mercury may refer to:</p><ul><li>a planet</li></ul>'));
    case 'www.imdb.com/name/nm0000456/':
      return send(200, page('Heidi Klum - IMDb', '<p>Actress, producer.</p>'));
    case 'www.imdb.com/name/nm9999999/':
      return send(200, page('Brad Pitt - IMDb', '<p>Actor.</p>'));
    case 'www.leipzig.gov/zoo':
      return send(200, page('Leipzig Zoo – City of Leipzig', '<p>The Leipzig Zoo is open daily.</p>'));
    case 'official.example/moved':
      return send(301, '', 'text/plain', { Location: 'http://parked.example/' });
    case 'tracker.example/start':
      return send(302, '', 'text/plain', { Location: 'http://sneaky.test/admin', 'Set-Cookie': 'track=1; Path=/' });
    case 'cookie.example/first':
      return send(302, '', 'text/plain', { Location: `http://cookie.example:${PORT}/second`, 'Set-Cookie': 'session=abc; Path=/' });
    case 'cookie.example/second':
      return send(200, page('Cookie Test', '<p>Cookie Test page.</p>'));
    case 'gone.example/article':
      return send(200, page('Page not found | Gone', '<p>Sorry.</p>'));
    case 'big.example/huge':
      return send(200, `<html><head><title>Big</title></head><body>${'x'.repeat(3_000_000)}</body></html>`);
    case 'slow.example/wait':
      setTimeout(() => send(200, page('Slow', '<p>slow</p>')), 3000);
      return;
    case 'pdf.example/file':
      return send(200, '%PDF-1.4', 'application/pdf');
    default:
      return send(404, page('Not found', ''));
  }
}

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  net = await import('@/lib/links/net');
  verify = await import('@/lib/links/verify');
  create = await import('@/lib/tasks/create');
  const { registerBuiltInPipelines } = await import('@/worker/pipelines');
  registerBuiltInPipelines();
  webServer = http.createServer(fakeWeb);
  await new Promise<void>((r) => webServer.listen(0, '127.0.0.1', r));
  PORT = (webServer.address() as AddressInfo).port;
  const names = ['en.wikipedia.org', 'de.wikipedia.org', 'www.imdb.com', 'www.leipzig.gov', 'official.example', 'parked.example', 'tracker.example', 'cookie.example', 'gone.example', 'big.example', 'slow.example', 'pdf.example'];
  net.setLinkNetworkForTests(
    async (host) => {
      if (host === 'sneaky.test') return [{ address: '127.0.0.1', family: 4 }]; // NOT trusted → must be refused
      if (host === 'intranet.test') return [{ address: '10.0.0.5', family: 4 }];
      if (names.includes(host)) return [{ address: '127.0.0.1', family: 4 }];
      throw new Error('ENOTFOUND');
    },
    names,
  );
});

afterAll(async () => {
  net.setLinkNetworkForTests(null);
  await new Promise((r) => webServer.close(r));
  for (const s of servers) await s.close();
});

const u = (host: string, path: string) => `http://${host}:${PORT}${path}`;

describe('SSRF-safe link verification (local fake web)', () => {
  it('accepts a matching page (HTTPS preferred, HTTP noted) and rejects disambiguation, wrong subject, soft 404 and non-HTML', async () => {
    const ok = await verify.verifyLink({ phrase: 'Tokio Hotel', url: u('en.wikipedia.org', '/wiki/Tokio_Hotel') }, 'en');
    expect(ok.ok).toBe(true);
    expect(ok.reason).toMatch(/no HTTPS available/);
    expect((await verify.verifyLink({ phrase: 'Mercury', url: u('en.wikipedia.org', '/wiki/Mercury') }, 'en')).reason).toBe('disambiguation page');
    expect((await verify.verifyLink({ phrase: 'Heidi Klum', url: u('www.imdb.com', '/name/nm9999999/') }, 'en')).reason).toMatch(/does not match/);
    expect((await verify.verifyLink({ phrase: 'Gone article', url: u('gone.example', '/article') }, 'en')).reason).toMatch(/not found/);
    expect((await verify.verifyLink({ phrase: 'Some file', url: u('pdf.example', '/file') }, 'en')).reason).toMatch(/not an HTML page/);
    expect((await verify.verifyLink({ phrase: 'Leipzig Zoo', url: u('www.leipzig.gov', '/zoo') }, 'en')).kind).toBe('edu-gov');
  });

  it('refuses redirects to other sites and to private/loopback addresses, caps size and time, never sends cookies', async () => {
    expect((await verify.verifyLink({ phrase: 'Official', url: u('official.example', '/moved') }, 'en')).reason).toMatch(/redirects to another site \(parked\.example\)/);
    await expect(net.safeFetch(u('tracker.example', '/start'))).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    await expect(net.safeFetch(`http://intranet.test/`)).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    await expect(net.safeFetch('http://127.0.0.1/')).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    await expect(net.safeFetch('http://[::1]/')).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    await expect(net.safeFetch('http://sneaky.test:8080/')).rejects.toMatchObject({ code: 'PORT' });
    await expect(net.safeFetch(u('big.example', '/huge'), { maxBytes: 1_000_000 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    await expect(net.safeFetch(u('slow.example', '/wait'), { timeoutMs: 500 })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(net.safeFetch('file:///etc/passwd')).rejects.toMatchObject({ code: 'SCHEME' });
    seenCookies.length = 0;
    const r = await net.safeFetch(u('cookie.example', '/first'));
    expect(r.status).toBe(200);
    expect(r.redirects).toHaveLength(1);
    expect(seenCookies).toEqual([]);
  });
});

async function site(wp: FakeWp, name: string, language: 'en' | 'de' = 'en'): Promise<Website> {
  const websites = await import('@/lib/websites');
  const created = await websites.createWebsite({ name, publicUrl: wp.url, language, targetCountry: language === 'de' ? 'Germany' : 'United States', timezone: 'UTC' });
  await client.category.create({ data: { websiteId: created.id, externalId: 7, name: 'Celebrities' } });
  return client.website.findUniqueOrThrow({ where: { id: created.id } });
}

async function task(s: Website, keyword: string, key: string, secondary = 'Tokio Hotel') {
  const cat = await client.category.findFirstOrThrow({ where: { websiteId: s.id } });
  const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword, secondaryKeywords: secondary, websiteId: s.id, categoryId: cat.id, options: { saveToWordPress: false }, idempotencyKey: `links:${key}` }, { source: 'SINGLE' });
  return task;
}

const stageData = async (taskId: string, key: string) => JSON.parse((await client.articleStage.findFirstOrThrow({ where: { taskId, key } })).outputJson ?? 'null');

describe('EXTERNAL_LINKS + INTERNAL_LINKS stages', () => {
  it('adds only verified links (Wikipedia ≤ half), logs every rejection, and picks the most related published post for the internal line', async () => {
    const wp = await startFakeWordPress();
    servers.push(wp);
    // Published posts on the site (and one draft that must never be linked).
    wp.addPost({ title: 'Best Pasta Recipes', status: 'publish', slug: 'pasta', content: '<p>Cook pasta.</p>', categories: [3] });
    const related = wp.addPost({ title: 'Heidi Klum: Her Modeling Career', status: 'publish', slug: 'heidi-klum-career', content: '<p>Heidi Klum began modeling.</p>', categories: [7] });
    wp.addPost({ title: 'Tom Kaulitz Heidi Klum wedding photos', status: 'draft', slug: 'draft-wedding', content: '<p>draft</p>', categories: [7] });
    const s = await site(wp, 'Links Blog');
    const answer = (stageKey: string, prompt: string, language: 'en' | 'de', keyword: string) =>
      /outbound references/.test(prompt)
        ? [
            `LINK: relationship | ${u('en.wikipedia.org', '/wiki/Interpersonal_relationship')}`,
            `LINK: Tokio Hotel | ${u('en.wikipedia.org', '/wiki/Tokio_Hotel')}`,
            `LINK: Heidi Klum | ${u('www.imdb.com', '/name/nm0000456/')}`,
            `LINK: Tom Kaulitz Heidi Klum | ${u('en.wikipedia.org', '/wiki/Heidi_Klum')}`,
            `LINK: outlets | https://www.instagram.com/heidiklum/`,
            `LINK: interviews | ${u('gone.example', '/article')}`,
            `LINK: family life | ${u('tracker.example', '/start')}`,
            `LINK: Not In The Article | ${u('en.wikipedia.org', '/wiki/Mercury')}`,
          ].join('\n')
        : cannedAnswer(stageKey, prompt, language, keyword);
    const driver = makeDriver(client, answer);
    const t0 = await task(s, 'Tom Kaulitz Heidi Klum', 'ext-1');
    await client.articleTask.update({ where: { id: t0.id }, data: {} });
    const t = await driver.drive(t0.id);
    const ext = await stageData(t.id, 'EXTERNAL_LINKS');
    const reasons = Object.fromEntries(ext.rejected.map((r: { phrase: string; reason: string }) => [r.phrase, r.reason]));
    expect(reasons['Tom Kaulitz Heidi Klum']).toMatch(/primary focus keyword/);
    expect(reasons.outlets).toMatch(/social media/);
    expect(reasons['Not In The Article']).toMatch(/does not appear/);
    expect(reasons.interviews).toMatch(/not found/);
    expect(reasons['family life']).toMatch(/redirects to another site/);
    // Accepted: IMDb (non-Wikipedia) first, so one Wikipedia link is allowed (≤ half).
    expect(ext.accepted.map((a: { phrase: string }) => a.phrase).sort()).toEqual(['Heidi Klum', 'relationship']);
    expect(reasons['Tokio Hotel']).toMatch(/does not appear/); // only in the Quick Bio, not in the body text
    expect(t.assembledHtml).toContain(`href="${u('www.imdb.com', '/name/nm0000456/')}"`);
    expect(t.assembledHtml).toMatch(/<a href="[^"]*Interpersonal_relationship" data-bas-link="ext" rel="noopener">relationship<\/a>/);
    expect((t.assembledHtml!.match(/data-bas-link="ext"/g) ?? []).length).toBe(2);
    const logs = await client.log.findMany({ where: { taskId: t.id, message: { startsWith: 'Link ' } } });
    expect(logs.length).toBe(ext.accepted.length + ext.rejected.length);

    const int = await stageData(t.id, 'INTERNAL_LINKS');
    expect(int.url).toBe(`${wp.url}/?p=${related.id}`);
    expect(int.reason).toMatch(/most related/);
    expect(int.candidates.map((c: { title: string }) => c.title)).not.toContain('Tom Kaulitz Heidi Klum wedding photos');
    expect(t.assembledHtml).toContain(`<p data-bas-internal-link="1"><strong>Also read:</strong> <a href="${wp.url}/?p=${related.id}" rel="noopener">Heidi Klum: Her Modeling Career</a></p>`);
    // What was considered is stored (SuggestedInternalLink): the chosen line target, unrelated candidates, never the draft.
    const sugg = await client.suggestedInternalLink.findMany({ where: { taskId: t.id } });
    expect(sugg.find((x) => x.kind === 'LINE')).toMatchObject({ status: 'SELECTED', url: `${wp.url}/?p=${related.id}`, title: 'Heidi Klum: Her Modeling Career' });
    expect(sugg.find((x) => x.title === 'Best Pasta Recipes')).toMatchObject({ kind: 'CANDIDATE', status: 'NOT_RELATED' });
    expect(sugg.some((x) => /wedding photos/.test(x.title))).toBe(false);
    expect(new Set(sugg.map((x) => x.websiteId))).toEqual(new Set([s.id]));
  });

  it('first post on a site: no internal line, an honest warning; later the index picks up a newly published post and a changed URL', async () => {
    const wp = await startFakeWordPress({ language: 'de' });
    servers.push(wp);
    const s = await site(wp, 'Neuer Blog', 'de');
    const driver = makeDriver(client);
    let t = await driver.drive((await task(s, 'Größe von Heidi Klum', 'first-de', 'Model')).id);
    let int = await stageData(t.id, 'INTERNAL_LINKS');
    expect(int.url).toBeNull();
    expect(int.notes.join(' ')).toMatch(/no published posts to link to yet/);
    expect(int.warnings).toEqual([]);
    expect(t.assembledHtml).not.toContain('data-bas-internal-link');
    // A related post is published, then its URL changes (old URL redirects).
    const post = wp.addPost({ title: 'Größe und Gewicht: Heidi Klum im Check', status: 'publish', slug: 'groesse-heidi', content: '<p>Heidi Klum misst 1,76 m.</p>', categories: [7] });
    await client.website.update({ where: { id: s.id }, data: { linkIndexSyncedAt: null } });
    wp.redirects.set(`/?p=${post.id}`, '/groesse-und-gewicht-heidi-klum/');
    post.slug = 'groesse-und-gewicht-heidi-klum';
    t = await driver.drive((await task(s, 'Heidi Klum Größe und Gewicht', 'second-de', 'Model')).id);
    int = await stageData(t.id, 'INTERNAL_LINKS');
    expect(int.url).toBe(`${wp.url}/groesse-und-gewicht-heidi-klum/`);
    expect(t.assembledHtml).toContain('<strong>Das könnte Ihnen gefallen:</strong>');
    const target = await client.linkTarget.findFirstOrThrow({ where: { websiteId: s.id, wpPostId: post.id } });
    expect(target.url).toBe(`${wp.url}/groesse-und-gewicht-heidi-klum/`);
  });

  it('never links an article to itself and drops posts that are no longer published', async () => {
    const wp = await startFakeWordPress();
    servers.push(wp);
    const s = await site(wp, 'Self Blog');
    const own = wp.addPost({ title: 'Sydney Sweeney Glen Powell romance', status: 'publish', slug: 'sydney-glen', content: '<p>x</p>', categories: [7] });
    const other = wp.addPost({ title: 'Sydney Sweeney movies ranked', status: 'publish', slug: 'sydney-movies', content: '<p>y</p>', categories: [7] });
    const t0 = await task(s, 'Sydney Sweeney Glen Powell', 'self', 'Anyone But You');
    await client.articleTask.update({ where: { id: t0.id }, data: { wpPostId: own.id } });
    const driver = makeDriver(client);
    let t = await driver.drive(t0.id);
    let int = await stageData(t.id, 'INTERNAL_LINKS');
    expect(int.url).toBe(`${wp.url}/?p=${other.id}`);
    expect(int.candidates.map((c: { url: string }) => c.url)).not.toContain(`${wp.url}/?p=${own.id}`);
    // The other post is unpublished: a full refresh removes it from the index.
    other.status = 'draft';
    await client.website.update({ where: { id: s.id }, data: { linkIndexSyncedAt: null, linkIndexFullSyncAt: null } });
    const actions = await import('@/lib/tasks/actions');
    await actions.regenerateStage(t.id, 'INTERNAL_LINKS');
    t = await driver.drive(t.id);
    int = await stageData(t.id, 'INTERNAL_LINKS');
    expect(int.url).toBeNull();
    expect((await client.linkTarget.findFirstOrThrow({ where: { websiteId: s.id, wpPostId: other.id } })).status).toBe('REMOVED');
  });
});
