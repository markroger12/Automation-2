import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

/** Evidence ledger against a local fake web (no internet): the acceptance cases of upgrade 03. */
let client: PrismaClient;
let server: http.Server;
let PORT = 0;
let net: typeof import('@/lib/links/net');
let ledger: typeof import('@/lib/research/ledger');
let service: typeof import('@/lib/research/service');
let siteId: string;
const hits = new Map<string, number>();

const PAGES: Record<string, string> = {
  'en.wikipedia.org/wiki/Tom_Kaulitz': '<title>Tom Kaulitz – Wikipedia</title><main><p>Tom Kaulitz (born 1 September 1989 in Leipzig) is a German guitarist and member of the band Tokio Hotel.</p><p>He married model Heidi Klum in 2019.</p></main>',
  'www.tokiohotel.com/band': '<title>The band – Tokio Hotel</title><main><p>Guitarist Tom Kaulitz, born September 1, 1989, founded Tokio Hotel with his twin brother Bill.</p></main>',
  'otherprofile.example/tom': '<title>Tom Kaulitz profile</title><main><p>Tom Kaulitz of Tokio Hotel was born on 1 October 1989 in Leipzig.</p></main>',
  'presenter.example/chris-evans': '<title>Chris Evans (presenter)</title><main><p>Chris Evans is an English radio presenter and television host, born 1 April 1966 in Warrington.</p></main>',
  'names.example/chris-evans': '<title>Chris Evans</title><main><p>Chris Evans may refer to: Chris Evans (actor), born 1981; Chris Evans (presenter), born 1966.</p></main>',
};

async function taskWithNotes(keyword: string, notes: string, secondary: string[] = []) {
  const create = await import('@/lib/tasks/create');
  const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword, secondaryKeywords: secondary.join(', '), websiteId: siteId, categoryId: (await client.category.findFirstOrThrow()).id, idempotencyKey: `ledger:${keyword}:${Math.random()}` }, { source: 'SINGLE' });
  await client.articleTask.update({ where: { id: task.id }, data: { researchNotes: notes } });
  return task.id;
}
const u = (hostPath: string) => {
  const [host, ...rest] = hostPath.split('/');
  return `http://${host}:${PORT}/${rest.join('/')}`;
};

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  server = http.createServer((req, res) => {
    const key = `${(req.headers.host ?? '').split(':')[0]}${req.url}`.replace(/^([^/]+)\//, '$1/');
    hits.set(key, (hits.get(key) ?? 0) + 1);
    const body = PAGES[key];
    if (!body) {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<title>Not found</title>');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head>${body.match(/<title>.*<\/title>/)![0]}</head><body>${body.replace(/<title>.*<\/title>/, '')}</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  PORT = (server.address() as AddressInfo).port;
  net = await import('@/lib/links/net');
  const names = ['en.wikipedia.org', 'www.tokiohotel.com', 'otherprofile.example', 'presenter.example', 'names.example', 'dead.example'];
  net.setLinkNetworkForTests(async (host) => {
    if (names.includes(host)) return [{ address: '127.0.0.1', family: 4 }];
    throw new Error('ENOTFOUND');
  }, names);
  ledger = await import('@/lib/research/ledger');
  service = await import('@/lib/research/service');
  const websites = await import('@/lib/websites');
  siteId = (await websites.createWebsite({ name: 'Celeb', publicUrl: 'https://celeb.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
  await client.category.create({ data: { websiteId: siteId, externalId: 1, name: 'Stars' } });
});

afterAll(async () => {
  net.setLinkNetworkForTests(null);
  await new Promise((r) => server.close(r));
});

describe('research evidence ledger', () => {
  let tom: string;

  it('verifies with two independent sources, keeps estimates and rumours apart, notes dead links', async () => {
    tom = await taskWithNotes(
      'Tom Kaulitz',
      [
        `- Tom Kaulitz was born on September 1, 1989 in Leipzig. ${u('en.wikipedia.org/wiki/Tom_Kaulitz')} ${u('www.tokiohotel.com/band')}`,
        `- He married Heidi Klum in February 2019. ${u('en.wikipedia.org/wiki/Tom_Kaulitz')}`,
        '- A rumoured relationship with Ria Sommerfeld is not confirmed by reliable sources.',
        '- His net worth is estimated at $30 million.',
        `- Old fan page: ${u('dead.example/tom')}`,
      ].join('\n'),
      ['Tokio Hotel'],
    );
    const s = await ledger.buildLedger(tom);
    const claims = await client.claimEvidence.findMany({ where: { taskId: tom } });
    const by = (re: RegExp) => claims.find((c) => re.test(c.claimText))!;
    expect(by(/born/)).toMatchObject({ claimType: 'BIRTH', status: 'VERIFIED', highImpact: true });
    const birthEvidence = JSON.parse(by(/born/).evidence);
    expect(new Set(birthEvidence.map((e: { host: string }) => e.host))).toEqual(new Set(['en.wikipedia.org', 'tokiohotel.com']));
    expect(birthEvidence[0].excerpt).toMatch(/1989/);
    expect(by(/married/)).toMatchObject({ claimType: 'FAMILY', status: 'SINGLE_SOURCE' });
    expect(by(/Ria Sommerfeld/)).toMatchObject({ nature: 'UNVERIFIED_CLAIM', status: 'DISPUTED' });
    expect(by(/net worth/)).toMatchObject({ nature: 'ESTIMATE', status: 'ESTIMATE' });
    expect(s.sources).toMatchObject({ ok: 2, dead: 1 });
    expect(s.warnings).toEqual([]);
    expect(s.notes.join(' ')).toMatch(/1 cited source\(s\) could not be reached/);
    expect((await client.sourceRecord.findUniqueOrThrow({ where: { url: u('dead.example/tom') } })).status).toBe('DEAD');
  });

  it('caches sources for a week; a re-check fetches again', async () => {
    const before = hits.get('en.wikipedia.org/wiki/Tom_Kaulitz');
    await ledger.buildLedger(tom);
    expect(hits.get('en.wikipedia.org/wiki/Tom_Kaulitz')).toBe(before);
    await ledger.buildLedger(tom, new Date(), { refetch: true });
    expect(hits.get('en.wikipedia.org/wiki/Tom_Kaulitz')).toBe(before! + 1);
  });

  it('conflicting birth dates are surfaced; an unsupported relationship in the article and leaked notes are flagged', async () => {
    const t = await taskWithNotes('Tom Kaulitz', `- Tom Kaulitz was born on September 1, 1989. ${u('en.wikipedia.org/wiki/Tom_Kaulitz')} ${u('otherprofile.example/tom')}\n- He has been dating Ria Sommerfeld, according to rumours.`, ['Tokio Hotel']);
    await ledger.buildLedger(t);
    const birth = await client.claimEvidence.findFirstOrThrow({ where: { taskId: t, claimType: 'BIRTH' } });
    expect(birth.status).toBe('CONTRADICTED');
    expect(JSON.parse(birth.evidence).find((e: { verdict: string }) => e.verdict === 'CONTRADICTS').detail).toBe('source gives 1989-10-01, the notes say 1989-09-01');
    const article = '<p>Tom Kaulitz was born on September 1, 1989 in Leipzig.</p><p>He is dating Ria Sommerfeld, fans say.</p><p>Sources: https://en.wikipedia.org/wiki/Tom_Kaulitz</p>';
    const ev = await ledger.evaluateArticleEvidence(t, article);
    expect(ev.warnings.join(' ')).toMatch(/Sources disagree on the birth date/);
    // The warning quotes what the ARTICLE says in that paragraph, then the research note it came from.
    expect(ev.warnings.join(' ')).toMatch(/unsupported family\/relationship claim in paragraph 2: “He is dating Ria Sommerfeld, fans say\.” \(research note: “He has been dating Ria Sommerfeld/);
    expect(ev.hardStops[0]).toMatch(/raw source list appear in the article \(paragraph 3/);
    expect((await client.claimEvidence.findFirstOrThrow({ where: { taskId: t, claimType: 'BIRTH' } })).articleParagraph).toBe(0);
    // Not stating the rumour clears that warning; omitting a claim is always allowed.
    expect((await ledger.evaluateArticleEvidence(t, '<p>Tom Kaulitz plays guitar.</p>')).warnings.join(' ')).not.toMatch(/unsupported/);
  });

  it('owner report: headings, outline lines and case citations are not claims; one review reason per article paragraph', async () => {
    const notes = [
      'Meet Dinesh D’Souza’s Ex-Wife',
      'Their Marriage and Family Life',
      'Mary Joan Schutz and Gene Wilder’s Marriage — Cover the wedding, timeline, and Wilder’s emerging career.',
      'In re Marriage of D’Souza, California Court of Appeal, Fourth Appellate District, Division One, Case D072564, August 26, 2020.',
      'Recommended wording: "Their marriage broke down after roughly two decades, and D’Souza filed for divorce in October 2012.',
      '- Brubaker and D’Souza have one publicly documented daughter, Danielle D’Souza Gill.',
      '| Daughter | Danielle D’Souza Gill | Verified |',
      '- She is married to Brandon Gill, who was elected to the U.S. House in 2024.',
    ].join('\n');
    const t = await taskWithNotes('Dixie Brubaker', notes);
    await ledger.buildLedger(t);
    const claims = (await client.claimEvidence.findMany({ where: { taskId: t } })).map((c) => c.claimText);
    expect(claims.some((c) => /^Meet |^Their Marriage and Family Life|— Cover|^In re |^Recommended wording/.test(c))).toBe(false);
    expect(claims).toContain('Brubaker and D’Souza have one publicly documented daughter, Danielle D’Souza Gill.');
    const article = '<h2>Their Marriage and Family Life with Danielle D’Souza Gill</h2><p>Dixie Brubaker and Dinesh D’Souza have a daughter, Danielle D’Souza Gill, who married Brandon Gill.</p>';
    const ev = await ledger.evaluateArticleEvidence(t, article);
    const unsupported = ev.warnings.filter((w) => /unsupported/.test(w));
    // Three notes match paragraph 2: one reason that names them; the heading (paragraph 1) is never a claim.
    expect(unsupported).toHaveLength(1);
    expect(unsupported[0]).toMatch(/states 3 unsupported family\/relationship claims in paragraph 2: “Dixie Brubaker and Dinesh/);
  });

  it('never merges a namesake: presenter and disambiguation pages are not used as evidence for the actor', async () => {
    const t = await taskWithNotes('Chris Evans', `Chris Evans is an American actor known for playing Captain America.\n- Chris Evans was born on June 13, 1981 in Boston. ${u('presenter.example/chris-evans')} ${u('names.example/chris-evans')}`);
    const s = await ledger.buildLedger(t);
    expect(s.sources.ok).toBe(0);
    expect(s.sources.offTopic).toBe(2);
    expect(s.notes.join(' ')).toMatch(/disambiguation page/);
    expect(s.notes.join(' ')).toMatch(/about a different chris evans/i);
    expect((await client.claimEvidence.findFirstOrThrow({ where: { taskId: t, claimType: 'BIRTH' } })).status).toBe('UNVERIFIED');
  });

  it('an owner correction keeps the source links, survives a rebuild and resolves the review reason', async () => {
    const t = await taskWithNotes('Tom Kaulitz', `- Tom Kaulitz was born on September 1, 1989. ${u('en.wikipedia.org/wiki/Tom_Kaulitz')} ${u('otherprofile.example/tom')}`, ['Tokio Hotel']);
    await ledger.buildLedger(t);
    const birth = await client.claimEvidence.findFirstOrThrow({ where: { taskId: t, claimType: 'BIRTH' } });
    await expect(service.decideClaim(birth.id, { decision: 'CORRECTED', note: 'Checked the birth register.' })).rejects.toThrow(/corrected value/);
    await service.decideClaim(birth.id, { decision: 'CORRECTED', value: '1 September 1989', note: 'Checked the birth register.' });
    await ledger.buildLedger(t);
    const after = await client.claimEvidence.findFirstOrThrow({ where: { taskId: t, claimType: 'BIRTH' } });
    expect(after).toMatchObject({ ownerDecision: 'CORRECTED', ownerValue: '1 September 1989', status: 'CONTRADICTED' });
    expect(JSON.parse(after.evidence).map((e: { url: string }) => e.url)).toEqual(expect.arrayContaining([u('en.wikipedia.org/wiki/Tom_Kaulitz'), u('otherprofile.example/tom')]));
    expect((await ledger.evaluateArticleEvidence(t, '<p>Born on September 1, 1989.</p>')).warnings).toEqual([]);
    expect(await client.auditLog.count({ where: { action: 'research.claim-decision', entityId: after.id } })).toBe(0); // rebuilt row: decision carried over
    expect(await client.auditLog.count({ where: { action: 'research.claim-decision' } })).toBe(1);
  });

  it('shows what changed since the last research of the same keyword (stale facts)', async () => {
    const later = await taskWithNotes('Tom Kaulitz', `- Tom Kaulitz was born on September 1, 1989. ${u('en.wikipedia.org/wiki/Tom_Kaulitz')}\n- He married Heidi Klum in February 2019 and they live in Los Angeles.\n- He won a Bambi award in 2024.`, ['Tokio Hotel']);
    await ledger.buildLedger(later, new Date(Date.now() + 60_000));
    const c = await ledger.changesSinceLastResearch(later);
    expect(c).not.toBeNull();
    expect(c!.changes.find((x) => x.type === 'AWARD')).toMatchObject({ kind: 'NEW' });
    const list = await service.listLedgers();
    expect(list.length).toBeGreaterThanOrEqual(4);
    const detail = await service.getLedger(tom);
    expect(detail.claims.length).toBeGreaterThan(3);
    expect(detail.sources.map((s) => s.status).sort()).toEqual(['DEAD', 'OK', 'OK']);
  });
});
