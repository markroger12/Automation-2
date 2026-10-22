import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

/**
 * Owner report (2026-10-22): four published keywords said “Sign in to Google (Search Console) in Automation Chrome …”;
 * “how do I know the request was made? I never signed in there — set something up.” The workflow page now shows
 * what was requested and what waits, opens Google's sign-in in Automation Chrome, and makes the waiting requests now.
 */
let client: PrismaClient;
let ri: typeof import('@/lib/gsc/request-indexing');
let siteId: string;
let workflowId: string;

async function published(keyword: string) {
  const kw = await client.workflowKeyword.create({ data: { workflowId, keyword, normalizedKeyword: keyword.toLowerCase(), position: 1, status: 'PUBLISHED', publishedUrl: `https://techeflux.example/${keyword.toLowerCase().replace(/\W+/g, '-')}/`, publishedAt: new Date() } });
  const { job } = await ri.queueIndexingRequest({ keywordId: kw.id, url: kw.publishedUrl!, property: 'sc-domain:techeflux.example', websiteId: siteId });
  return { kw, job };
}

const post = (body: unknown) =>
  new Request('http://localhost:3000/api/search-console/indexing', { method: 'POST', headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: 'bas_csrf=tok12345', 'x-csrf-token': 'tok12345', 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  ({ client } = await setupTestDb());
  ri = await import('@/lib/gsc/request-indexing');
  const websites = await import('@/lib/websites');
  siteId = (await websites.createWebsite({ name: 'Techeflux', publicUrl: 'https://techeflux.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
  workflowId = (await client.workflow.create({ data: { websiteId: siteId, name: 'wf', requestIndexing: true } })).id;
});

describe('owner request: know whether indexing was requested, and sign in to Google from the app', () => {
  it('signed out: the overview says so and counts what waits; after signing in, “Request now” makes them now (not the daily limit)', async () => {
    const t0 = new Date();
    expect(await ri.indexingOverview()).toMatchObject({ waiting: 0, requested: 0, signedIn: null, last: null });
    const a = await published('Andre Rock');
    const b = await published('Andi Rock');
    const q = await published('Jordan Rock');
    // Automation Chrome takes each one: two land on Google's sign-in page, one on the daily limit.
    for (let i = 0; i < 3; i++) {
      const claimed = await ri.claimIndexingRequest('install-1', new Date(t0.getTime() + 1000));
      expect([a.job.id, b.job.id, q.job.id]).toContain(claimed?.id);
      await ri.reportIndexingRequest({ jobId: claimed!.id, installId: 'install-1', outcome: claimed!.id === q.job.id ? 'QUOTA' : 'NOT_SIGNED_IN' }, new Date(t0.getTime() + 2000));
    }
    let o = await ri.indexingOverview();
    expect(o).toMatchObject({ waiting: 3, notSignedIn: 2, quota: 1, requested: 0 });
    expect(o.last?.outcome).toMatch(/NOT_SIGNED_IN|QUOTA/);

    // The page's “Request now”: the two that waited for the sign-in are due now; the daily limit still waits.
    const { POST } = await import('../../app/api/search-console/indexing/route');
    const res = await POST(post({ action: 'now' }) as never, { params: Promise.resolve({}) } as never);
    expect(await res.json()).toEqual({ count: 2 });
    expect(await ri.waitingIndexingRequests(new Date())).toBe(2);
    const quotaJob = await client.queueJob.findUniqueOrThrow({ where: { id: q.job.id } });
    expect(quotaJob.runAt.getTime()).toBeGreaterThan(Date.now() + 19 * 3600_000);

    // Signed in now: the first request goes through, and anything still waiting for the sign-in is made next.
    const c = await published('Lola Simone Rock');
    await client.queueJob.update({ where: { id: c.job.id }, data: { errorCode: 'NOT_SIGNED_IN', error: 'Sign in…', status: 'WAITING', runAt: new Date(Date.now() + 3600_000) } });
    const first = await ri.claimIndexingRequest('install-1');
    await ri.reportIndexingRequest({ jobId: first!.id, installId: 'install-1', outcome: 'REQUESTED', message: 'Indexing requested' });
    expect((await client.queueJob.findUniqueOrThrow({ where: { id: c.job.id } })).runAt.getTime()).toBeLessThanOrEqual(Date.now());
    o = await ri.indexingOverview();
    expect(o).toMatchObject({ requested: 1, signedIn: true, last: { outcome: 'REQUESTED' } });
  });

  it('“Sign in to Google in Automation Chrome” asks the worker to open Google’s sign-in (once at a time); the worker has that job', async () => {
    const { POST } = await import('../../app/api/search-console/indexing/route');
    const one = await (await POST(post({ action: 'signin' }) as never, { params: Promise.resolve({}) } as never)).json();
    const two = await (await POST(post({ action: 'signin' }) as never, { params: Promise.resolve({}) } as never)).json();
    expect(two.jobId).toBe(one.jobId);
    expect(await client.queueJob.findUniqueOrThrow({ where: { id: one.jobId } })).toMatchObject({ queue: 'control', kind: 'chrome.google-signin', status: 'WAITING' });
    const bad = await POST(post({ action: 'open-anything' }) as never, { params: Promise.resolve({}) } as never);
    expect(bad.status).toBe(400);
    const { registerBuiltInControlHandlers } = await import('@/worker/handlers');
    const { controlKinds } = await import('@/worker/control');
    registerBuiltInControlHandlers();
    expect(controlKinds()).toContain('chrome.google-signin');
    expect(ri.GOOGLE_SIGNIN_URL).toBe('https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fsearch.google.com%2Fsearch-console');
  });
});

describe('owner request: a screenshot as proof of the request — what the upload accepts', () => {
  it('only the extension holding the open request may upload, only an MHTML page copy; then the worker gets a render job', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { createConnectionKey } = await import('@/lib/agent/keys');
    const { handleGscProof } = await import('@/lib/gsc/proof');
    const { dataPaths } = await import('@/lib/paths');
    const key = (await createConnectionKey()).key;
    const upload = (body: unknown) =>
      handleGscProof(new Request('http://127.0.0.1:3000/api/extension/gsc-proof', { method: 'POST', headers: { host: '127.0.0.1:3000', origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const { kw, job } = await published('Proof Person');
    // Only this request is open (the requests of the test above are set aside).
    await client.queueJob.updateMany({ where: { queue: 'gsc', id: { not: job.id }, status: { in: ['WAITING', 'ACTIVE'] } }, data: { status: 'CANCELLED' } });
    const mhtml = Buffer.from('From: <Saved by Blink>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/related;\r\n\r\n<h2>Indexing requested</h2>').toString('base64');
    // Not taken by this extension yet.
    expect((await upload({ installId: 'install-1', jobId: job.id, mhtmlBase64: mhtml })).status).toBe(403);
    const claimed = await ri.claimIndexingRequest('install-1');
    expect(claimed?.id).toBe(job.id);
    expect((await upload({ installId: 'someone-else', jobId: job.id, mhtmlBase64: mhtml })).status).toBe(403);
    expect((await upload({ installId: 'install-1', jobId: job.id, mhtmlBase64: Buffer.from('<html>not a page copy</html>').toString('base64') })).status).toBe(400);
    const ok = await upload({ installId: 'install-1', jobId: job.id, mhtmlBase64: mhtml });
    expect(ok.status).toBe(200);
    expect(fs.readFileSync(path.join(dataPaths.uploads(), 'gsc-proof', `${job.id}.mhtml`), 'utf8')).toContain('Indexing requested');
    expect(await client.queueJob.findFirstOrThrow({ where: { queue: 'control', kind: 'gsc.proof' } })).toMatchObject({ relatedId: kw.id, status: 'WAITING' });
    // A wrong key never gets in.
    const denied = await handleGscProof(new Request('http://127.0.0.1:3000/api/extension/gsc-proof', { method: 'POST', headers: { host: '127.0.0.1:3000', authorization: 'Bearer wrong', 'content-type': 'application/json' }, body: JSON.stringify({ installId: 'install-1', jobId: job.id, mhtmlBase64: mhtml }) }));
    expect(denied.status).toBe(401);
  });
});

describe('owner request: “Request indexing” on the keyword queue', () => {
  it('the selected published keywords are requested now by Automation Chrome, also after an earlier answer; a second proof screenshot is made', async () => {
    const { createConnectionKey } = await import('@/lib/agent/keys');
    const { handleGscProof } = await import('@/lib/gsc/proof');
    const service = await import('@/lib/workflow/service');
    const key = (await createConnectionKey()).key;
    const mhtml = Buffer.from('From: <Saved by Blink>\r\nMIME-Version: 1.0\r\n\r\n<h2>Indexing requested</h2>').toString('base64');
    const upload = (jobId: string) =>
      handleGscProof(new Request('http://127.0.0.1:3000/api/extension/gsc-proof', { method: 'POST', headers: { host: '127.0.0.1:3000', authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ installId: 'install-1', jobId, mhtmlBase64: mhtml }) }));
    // Only the requests of this test are open.
    await client.queueJob.updateMany({ where: { queue: 'gsc', status: { in: ['WAITING', 'ACTIVE'] } }, data: { status: 'CANCELLED' } });

    // Andre Rock: requested before, with its proof. Andi Rock: published while nothing was queued for it (e.g. the
    // workflow switch was off). One indexed, one not published yet.
    const andre = await published('Andre Rock');
    expect((await ri.claimIndexingRequest('install-1'))?.id).toBe(andre.job.id);
    expect((await upload(andre.job.id)).status).toBe(200);
    await ri.reportIndexingRequest({ jobId: andre.job.id, installId: 'install-1', outcome: 'REQUESTED', message: 'Indexing requested' });
    const andi = await client.workflowKeyword.create({ data: { workflowId, keyword: 'Andi Rock', normalizedKeyword: 'andi rock', position: 2, status: 'PUBLISHED', publishedUrl: 'https://techeflux.example/andi-rock/', publishedAt: new Date(), indexingStatus: 'Index status not checked: fetch failed' } });
    const indexed = await client.workflowKeyword.create({ data: { workflowId, keyword: 'Malaak Compton-Rock', normalizedKeyword: 'malaak compton-rock', position: 3, status: 'INDEXED', publishedUrl: 'https://techeflux.example/malaak/', publishedAt: new Date() } });
    const writing = await client.workflowKeyword.create({ data: { workflowId, keyword: 'Not Yet', normalizedKeyword: 'not yet', position: 4, status: 'WAITING' } });

    const r = await service.keywordAction(siteId, { keywordIds: [andre.kw.id, andi.id, indexed.id, writing.id], action: 'request-indexing' });
    expect(r.changed).toBe(2);
    expect(r.notes.join(' ')).toMatch(/“Malaak Compton-Rock” is already on Google/);
    expect(r.notes.join(' ')).toMatch(/“Not Yet” is not published yet/);
    expect(await ri.waitingIndexingRequests(new Date())).toBe(2);
    // The earlier request is asked again (still one request per keyword); the other is queued, with the website's property.
    expect(await client.queueJob.findUniqueOrThrow({ where: { id: andre.job.id } })).toMatchObject({ status: 'WAITING', attempts: 0, lockedBy: null, error: null, finishedAt: null });
    const andiJob = await client.queueJob.findUniqueOrThrow({ where: { idempotencyKey: `gsc-index:${andi.id}` } });
    expect(JSON.parse(andiJob.payload)).toMatchObject({ keywordId: andi.id, url: 'https://techeflux.example/andi-rock/', property: 'https://techeflux.example/', websiteId: siteId });
    // Each keyword says so (it said “fetch failed” before); an indexed one is not touched.
    for (const id of [andre.kw.id, andi.id]) expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id } })).indexingStatus).toMatch(/^Waiting for Automation Chrome to request indexing in Search Console \(asked by you/);
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: indexed.id } })).status).toBe('INDEXED');
    expect(await client.auditLog.count({ where: { action: 'workflow.keywords.action', details: { contains: 'request-indexing' } } })).toBe(1);

    // A request Automation Chrome is making right now is left alone.
    const taken = await ri.claimIndexingRequest('install-1');
    expect(taken?.id).toBe(andre.job.id);
    const busy = await service.keywordAction(siteId, { keywordIds: [andre.kw.id], action: 'request-indexing' });
    expect(busy).toMatchObject({ changed: 0, notes: ['“Andre Rock”: Automation Chrome is requesting indexing for it right now.'] });
    // The second run's proof is made too (before: taken as a repeat of the first one and never rendered).
    expect((await upload(andre.job.id)).status).toBe(200);
    expect(await client.queueJob.count({ where: { queue: 'control', kind: 'gsc.proof', relatedId: andre.kw.id } })).toBe(2);
  });
});
