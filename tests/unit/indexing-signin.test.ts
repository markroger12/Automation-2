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
