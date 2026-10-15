import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

/** The 2-hour benchmark report: exact articles per window, WordPress evidence, stage timings, honest verdict. */
let client: PrismaClient;
let bench: typeof import('@/lib/analytics/benchmark');
const START = new Date('2026-10-15T09:00:00Z');
const at = (min: number) => new Date(START.getTime() + min * 60_000);

beforeAll(async () => {
  ({ client } = await setupTestDb());
  bench = await import('@/lib/analytics/benchmark');
  const metrics = await import('@/lib/metrics');
  const websites = await import('@/lib/websites');
  const create = await import('@/lib/tasks/create');
  const siteId = (await websites.createWebsite({ name: 'Celeb News', publicUrl: 'https://celeb.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
  const cat = await client.category.create({ data: { websiteId: siteId, externalId: 7, name: 'Stars' } });
  // 6 verified in the first hour, 5 in the second, one just outside, one stopped for a WordPress login.
  const minutes = [5, 15, 25, 35, 45, 55, 65, 75, 85, 95, 105, 125];
  for (const [i, m] of minutes.entries()) {
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: `Benchmark ${i + 1}`, websiteId: siteId, categoryId: cat.id, idempotencyKey: `benchmark:${i + 1}` }, { source: 'SINGLE' });
    await metrics.recordMetric({ kind: 'ARTICLE_VERIFIED', taskId: task.id, moduleKey: 'celebrity-writer', websiteId: siteId, outcome: 'COMPLETED', startedAt: at(m - 12), endedAt: at(m), details: { wpPostId: 700 + i, wpEditUrl: `https://celeb.example/wp-admin/post.php?post=${700 + i}&action=edit`, chatgptInteractions: 7 }, dedupeKey: `verified:${task.id}` });
    await metrics.recordMetric({ kind: 'STAGE', taskId: task.id, stageKey: 'LONG_ARTICLE', moduleKey: 'celebrity-writer', websiteId: siteId, attempt: i === 3 ? 2 : 1, outcome: 'COMPLETED', startedAt: at(m - 10), endedAt: at(m - 6), dedupeKey: `stage:${task.id}:LONG_ARTICLE` });
  }
  const { task: stuck } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Stuck article', websiteId: siteId, categoryId: cat.id, idempotencyKey: 'benchmark:stuck' }, { source: 'SINGLE' });
  await client.articleTask.update({ where: { id: stuck.id }, data: { status: 'LOGIN_REQUIRED', pausedFor: 'wordpress-login', message: 'Celeb News: not logged in to WordPress.', updatedAt: at(80) } });
  await client.workerStatus.create({ data: { id: 'worker', kind: 'WORKER', version: '3.0.0', status: 'RUNNING', lastSeenAt: at(119) } });
});

describe('2-hour benchmark report', () => {
  it('lists the verified articles of each window with evidence, and suspends the claim when a login stopped work', async () => {
    const r = await bench.benchmarkReport(START);
    expect([r.from, r.to]).toEqual(['2026-10-15T09:00:00.000Z', '2026-10-15T11:00:00.000Z']);
    expect(r.benchmark.windows.map((w) => w.count)).toEqual([6, 5]);
    expect(r.benchmark.claim).toBe('SUSPENDED');
    expect(r.benchmark.explanation).toBe('Target temporarily unattainable: 1 article(s) paused for a login or check.');
    expect(r.articles).toHaveLength(11);
    expect(r.articles.filter((a) => a.window === 1)).toHaveLength(6);
    expect(r.articles[0]).toMatchObject({ title: 'Benchmark 1', wpPostId: 700, minutes: 12, chatgptInteractions: 7, stages: [{ stageKey: 'LONG_ARTICLE', seconds: 240, attempts: 1 }] });
    expect(r.stageSummary).toEqual([{ stageKey: 'LONG_ARTICLE', runs: 11, p50Seconds: 240, p90Seconds: 240, retries: 1 }]);
    expect(r.failedOrStopped).toEqual([{ taskId: expect.any(String), title: 'Stuck article', status: 'LOGIN_REQUIRED', reason: 'Celeb News: not logged in to WordPress.' }]);
    expect(r.versions).toMatchObject({ app: '3.0.0', worker: '3.0.0', extension: null });
    const md = bench.benchmarkMarkdown(r);
    expect(md).toContain('**Result: SUSPENDED**');
    expect(md).toContain('| 1 | 1 | 2026-10-15T09:05:00.000Z | Benchmark 1 (');
    expect(md).toContain('https://celeb.example/wp-admin/post.php?post=700&action=edit');
  });

  it('without the stopped article the same numbers are a FAIL (5 < 6 in the second hour); with one more, a PASS', async () => {
    await client.articleTask.updateMany({ where: { keyword: 'Stuck article' }, data: { status: 'CANCELLED', pausedFor: null } });
    expect((await bench.benchmarkReport(START)).benchmark.claim).toBe('FAIL');
    const metrics = await import('@/lib/metrics');
    await metrics.recordMetric({ kind: 'ARTICLE_VERIFIED', taskId: null, outcome: 'COMPLETED', startedAt: at(100), endedAt: at(115), details: { wpPostId: 799 }, dedupeKey: 'verified:extra' });
    const r = await bench.benchmarkReport(START);
    expect([r.benchmark.claim, r.benchmark.windows.map((w) => w.count)]).toEqual(['PASS', [6, 6]]);
  });
});
