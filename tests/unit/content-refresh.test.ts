import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

/** Content refresh (upgrade 11): evidence-only candidates, owner-approved revisions, live-post lock. */
let client: PrismaClient;
let server: http.Server;
let PORT = 0;
let net: typeof import('@/lib/links/net');
let refresh: typeof import('@/lib/refresh/service');
let siteId: string;
let online = true;
const now = new Date('2026-10-15T12:00:00Z');

const url = (host: string, path = '') => `http://${host}:${PORT}/${path}`;

async function article(title: string, html: string, opts: { live?: boolean; writtenAt?: Date; site?: string } = {}) {
  const create = await import('@/lib/tasks/create');
  const ws = opts.site ?? siteId;
  const cat = await client.category.findFirstOrThrow({ where: { websiteId: ws } });
  const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: title, websiteId: ws, categoryId: cat.id, idempotencyKey: `refresh:${title}:${Math.random()}` }, { source: 'SINGLE' });
  const wpPostId = 200 + (await client.articleTask.count());
  await client.articleTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', wpPostId, selectedTitle: title, assembledHtml: html, verifiedCompleteAt: opts.writtenAt ?? new Date('2026-09-01T10:00:00Z') } });
  if (opts.live) await client.linkTarget.create({ data: { websiteId: ws, wpPostId, url: `https://celeb.example/p-${wpPostId}/`, title, status: 'ACTIVE', publishedAt: new Date('2026-08-01T10:00:00Z') } });
  return task.id;
}

const codes = async (taskId: string) => {
  const c = await client.refreshCandidate.findFirst({ where: { taskId }, orderBy: { createdAt: 'desc' } });
  return c ? { status: c.status, codes: (JSON.parse(c.reasons) as { code: string }[]).map((r) => r.code), live: c.live, id: c.id } : null;
};

beforeAll(async () => {
  ({ client } = await setupTestDb());
  server = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    if (host === 'gone.example') {
      res.writeHead(404, { 'content-type': 'text/html' });
      return res.end('<title>Not found</title>');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>OK</title><p>Fine.</p>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  PORT = (server.address() as AddressInfo).port;
  net = await import('@/lib/links/net');
  const names = ['live.example', 'gone.example', 'offline-a.example', 'offline-b.example'];
  net.setLinkNetworkForTests(async (host) => {
    if (online && names.includes(host)) return [{ address: '127.0.0.1', family: 4 }];
    throw new Error('ENOTFOUND');
  }, names);
  refresh = await import('@/lib/refresh/service');
  const websites = await import('@/lib/websites');
  siteId = (await websites.createWebsite({ name: 'Celeb News', publicUrl: 'https://celeb.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
  await client.category.create({ data: { websiteId: siteId, externalId: 7, name: 'Stars' } });
});

afterAll(async () => {
  net.setLinkNetworkForTests(null);
  await new Promise((r) => server.close(r));
});

describe('content refresh evaluation', () => {
  const ids: Record<string, string> = {};

  it('creates candidates only on evidence; a current evergreen article and age alone are left alone', async () => {
    ids.outdated = await article('Tom Kaulitz Net Worth 2024', `<h2>Net worth in 2024</h2><p>See <a href="${url('gone.example', 'interview')}">the interview</a> and <a href="${url('live.example', 'ok')}">his band</a>.</p>`, { live: true });
    ids.evergreen = await article('Tom Kaulitz: Guitarist, Twin and Husband', `<h2>Early life</h2><p>Born in 1989, married in 2019. <a href="${url('live.example', 'ok')}">Band site</a>.</p>`);
    ids.old = await article('Bill Kaulitz: Singer', '<h2>Career</h2><p>He sings.</p>', { writtenAt: new Date('2024-06-01T10:00:00Z') });
    ids.gone = await article('Heidi Klum', `<p>An <a href="http://nxdomain.example/x">old fan site</a>.</p>`);
    ids.facts = await article('Georg Listing', '<p>Georg was born on 31 March 1987.</p>');
    await client.claimEvidence.create({ data: { taskId: ids.facts, claimType: 'BIRTH', claimText: 'Georg was born on 31 March 1987.', values: '{}', nature: 'REPORTED_FACT', highImpact: true, status: 'CONTRADICTED', articleParagraph: 0, researchedAt: now, evidence: JSON.stringify([{ verdict: 'CONTRADICTS', url: 'https://wiki.example/georg', excerpt: 'born 31 March 1986' }]) } });

    const r = await refresh.evaluateRefresh(siteId, now);
    expect(r).toMatchObject({ evaluated: 5, open: 3, created: 3, resolved: 0, notes: [] });
    expect(await codes(ids.outdated)).toMatchObject({ status: 'OPEN', codes: ['OUTDATED_YEAR', 'OUTDATED_YEAR', 'BROKEN_LINK'], live: true });
    expect(await codes(ids.evergreen)).toBeNull();
    expect(await codes(ids.old)).toBeNull(); // over 12 months old, but nothing is out of date
    // A missing domain counts as dead here because other links answered (the computer is online).
    expect(await codes(ids.gone)).toMatchObject({ codes: ['BROKEN_LINK'] });
    expect(await codes(ids.facts)).toMatchObject({ codes: ['FACTS_CHANGED'] });
    const facts = await client.refreshCandidate.findFirstOrThrow({ where: { taskId: ids.facts } });
    expect(JSON.parse(facts.reasons)[0].evidence).toContain('born 31 March 1986');
    const outdated = await client.refreshCandidate.findFirstOrThrow({ where: { taskId: ids.outdated } });
    expect(outdated.priority).toBe(30 + 20);
  });

  it('re-evaluation updates instead of duplicating, resolves fixed articles, and respects dismissals', async () => {
    const again = await refresh.evaluateRefresh(siteId, now);
    expect([again.created, again.open]).toEqual([0, 3]);
    expect(await client.refreshCandidate.count()).toBe(3);
    // The owner fixed the fan-site link locally → resolved.
    await client.articleTask.update({ where: { id: ids.gone }, data: { editedHtml: '<p>An old fan site.</p>' } });
    // The contradicted claim is dismissed with a reason.
    const facts = (await codes(ids.facts))!;
    await expect(refresh.dismissCandidate(facts.id, 'ok')).rejects.toThrow(/at least 5/);
    await refresh.dismissCandidate(facts.id, 'The source is wrong; the birth year was checked with the band.');
    const third = await refresh.evaluateRefresh(siteId, now);
    expect(third.resolved).toBe(1);
    expect(await codes(ids.gone)).toMatchObject({ status: 'RESOLVED' });
    expect(await codes(ids.facts)).toMatchObject({ status: 'DISMISSED' });
    // New evidence on the dismissed article (an outdated heading) opens a new candidate.
    await client.articleTask.update({ where: { id: ids.facts }, data: { editedHtml: '<h2>Georg in 2025</h2><p>Georg was born on 31 March 1987.</p>' } });
    await refresh.evaluateRefresh(siteId, now);
    expect(await codes(ids.facts)).toMatchObject({ status: 'OPEN', codes: ['OUTDATED_YEAR', 'FACTS_CHANGED'] });
  });

  it('offline: dead-domain checks are skipped with a note, HTTP 404 still counts', async () => {
    const websites = await import('@/lib/websites');
    const other = (await websites.createWebsite({ name: 'Offline Blog', publicUrl: 'https://offline-blog.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
    await client.category.create({ data: { websiteId: other, externalId: 3, name: 'News' } });
    const a = await article('Offline A', `<p><a href="${url('offline-a.example', 'x')}">a</a> <a href="${url('offline-b.example', 'y')}">b</a></p>`, { site: other });
    online = false;
    try {
      const r = await refresh.evaluateRefresh(other, now);
      expect(r.notes).toEqual(['None of the 2 linked page(s) answered; dead-link checks were skipped (no internet connection?).']);
      expect(await codes(a)).toBeNull();
    } finally {
      online = true;
    }
  });

  it('traffic signals come only from imported Search Console data', async () => {
    const sp = await import('@/lib/search-performance/service');
    await client.website.update({ where: { id: siteId }, data: { searchConsoleProperty: 'sc-domain:celeb.example' } });
    const t = await client.articleTask.findUniqueOrThrow({ where: { id: ids.evergreen } });
    await client.linkTarget.create({ data: { websiteId: siteId, wpPostId: t.wpPostId!, url: 'https://celeb.example/evergreen/', title: 'x', status: 'ACTIVE', publishedAt: new Date('2026-08-01T10:00:00Z') } });
    await sp.importSearchExport(siteId, [{ name: 'Pages.csv', bytes: Buffer.from('Top pages,Last 28 days Clicks,Previous 28 days Clicks,Last 28 days Impressions,Previous 28 days Impressions\nhttps://celeb.example/evergreen/,20,100,900,3000\n') }], { start: '2026-09-15', end: '2026-10-12' });
    await refresh.evaluateRefresh(siteId, now);
    const c = (await codes(ids.evergreen))!;
    expect(c.codes).toEqual(['DECLINING_TRAFFIC']);
    const reason = JSON.parse((await client.refreshCandidate.findUniqueOrThrow({ where: { id: c.id } })).reasons)[0];
    expect(reason.evidence).toBe('20 clicks vs 100 before (-80 %, compared with the comparison period in the same export)');
  });
});

describe('revisions and the approval gate', () => {
  it('proposes dead links removed (words kept), lets the owner edit, and approves only real, current changes', async () => {
    const c = await client.refreshCandidate.findFirstOrThrow({ where: { title: 'Tom Kaulitz Net Worth 2024' } });
    const { revision, created } = await refresh.proposeRevision(c.id);
    expect(created).toBe(true);
    expect(revision.proposedHtml).toContain('See the interview and');
    expect(revision.proposedHtml).not.toContain('gone.example');
    expect(JSON.parse(revision.changes).map((x: { kind: string }) => x.kind)).toEqual(['LINK_REMOVED', 'TO_EDIT', 'TO_EDIT']);
    expect((await refresh.proposeRevision(c.id)).created).toBe(false);
    expect((await client.refreshCandidate.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('REVISION');
    // Owner edits are sanitized.
    await refresh.updateRevision(revision.id, `${revision.proposedHtml.replace('Net worth in 2024', 'Net worth in 2026')}<script>alert(1)</script>`);
    const edited = await client.contentRevision.findUniqueOrThrow({ where: { id: revision.id } });
    expect(edited.proposedHtml).toContain('Net worth in 2026');
    expect(edited.proposedHtml).not.toContain('<script');
    expect(edited.source).toBe('OWNER');
    // Live post: the site does not allow updates to live posts.
    await expect(refresh.approveRevision(revision.id)).rejects.toMatchObject({ code: 'LIVE_LOCKED' });
    await client.website.update({ where: { id: siteId }, data: { canPublish: true, canPublishAcknowledgedAt: now, allowLiveUpdates: true } });
    await expect(refresh.approveRevision(revision.id, 'yes')).rejects.toMatchObject({ code: 'ACK_REQUIRED' });
    // The article changed in the app after the proposal → stale.
    const task = await client.articleTask.findUniqueOrThrow({ where: { id: edited.taskId } });
    await client.articleTask.update({ where: { id: task.id }, data: { editedHtml: '<p>changed meanwhile</p>' } });
    await expect(refresh.approveRevision(revision.id, refresh.LIVE_ACK_PHRASE)).rejects.toMatchObject({ code: 'STALE' });
    await client.articleTask.update({ where: { id: task.id }, data: { editedHtml: null } });
    const ok = await refresh.approveRevision(revision.id, refresh.LIVE_ACK_PHRASE);
    expect(ok).toEqual({ ok: true, live: true });
    const job = await client.queueJob.findFirstOrThrow({ where: { relatedId: revision.id } });
    expect([job.queue, job.kind, job.status]).toEqual(['control', 'wp.refresh-apply', 'WAITING']);
    await expect(refresh.updateRevision(revision.id, '<p>x</p>')).rejects.toThrow(/Only a proposed revision/);
    // Rejecting cancels the queued update and reopens the candidate.
    await refresh.rejectRevision(revision.id);
    expect((await client.queueJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('CANCELLED');
    expect((await client.refreshCandidate.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('OPEN');
    await expect(refresh.rollbackRevision(revision.id)).rejects.toThrow(/Only an applied revision/);
    expect(await client.auditLog.count({ where: { action: { in: ['refresh.propose', 'refresh.approve', 'refresh.reject', 'refresh.dismiss'] } } })).toBe(4);
  });

  it('a revision that changes nothing cannot be approved', async () => {
    const c = await client.refreshCandidate.findFirstOrThrow({ where: { title: 'Georg Listing', status: 'OPEN' } });
    const { revision } = await refresh.proposeRevision(c.id);
    await expect(refresh.approveRevision(revision.id)).rejects.toThrow(/changes nothing/);
  });
});
