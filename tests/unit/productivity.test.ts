import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { dayIn, evaluateBenchmark, percentile, rollingWindows, TARGET_PER_HOUR } from '@/lib/analytics/measure';

/** Performance analytics (upgrades 01/15): known timestamps, rolling windows, no double counting, proof per article. */
const T = new Date('2026-10-15T12:00:00Z');
const ago = (min: number) => new Date(T.getTime() - min * 60_000);

describe('measurement helpers', () => {
  it('percentiles use the nearest rank', () => {
    const v = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    expect([percentile(v, 50), percentile(v, 90), percentile(v, 100), percentile([], 50)]).toEqual([5, 9, 10, null]);
  });

  it('rolling windows count (from, now] exactly', () => {
    const times = [ago(5), ago(14.99), ago(15), ago(59), ago(60), ago(61), ago(119), ago(120), ago(121), new Date(T.getTime() + 60_000)];
    expect(rollingWindows(times, T)).toEqual([
      { minutes: 15, count: 2, perHour: 8 },
      { minutes: 60, count: 4, perHour: 4 },
      { minutes: 120, count: 7, perHour: 3.5 },
    ]);
  });

  it('days are counted in the given time zone', () => {
    expect(dayIn(new Date('2026-10-14T20:00:00Z'), 'Asia/Karachi')).toBe('2026-10-15');
    expect(dayIn(new Date('2026-10-14T18:59:59Z'), 'Asia/Karachi')).toBe('2026-10-14');
  });

  it('the 2-hour target needs 6 in EACH hour; outside causes suspend the claim instead of failing it', () => {
    const six = (startMin: number) => Array.from({ length: TARGET_PER_HOUR }, (_, i) => ago(startMin - i * 9));
    const both = [...six(115), ...six(55)];
    expect(evaluateBenchmark(both, T, [], true).claim).toBe('PASS');
    expect(evaluateBenchmark(both, T, ['ChatGPT rate or usage limits 2×'], true).claim).toBe('PASS');
    const short = [...six(115), ...six(55).slice(1)];
    const fail = evaluateBenchmark(short, T, [], true);
    expect([fail.claim, fail.windows.map((w) => w.count)]).toEqual(['FAIL', [6, 5]]);
    const suspended = evaluateBenchmark(short, T, ['3 article(s) paused for chatgpt login'], true);
    expect([suspended.claim, suspended.explanation]).toEqual(['SUSPENDED', 'Target temporarily unattainable: 3 article(s) paused for chatgpt login.']);
    expect(evaluateBenchmark([], T, [], false).claim).toBe('NO_WORK');
    // 12 drafts all in the second hour still miss the first hour.
    expect(evaluateBenchmark([...six(55), ...six(54)], T, [], true).claim).toBe('FAIL');
  });
});

describe('productivity report (database)', () => {
  let client: PrismaClient;
  let productivity: typeof import('@/lib/analytics/productivity');
  let metrics: typeof import('@/lib/metrics');
  const sites: Record<string, string> = {};

  beforeAll(async () => {
    ({ client } = await setupTestDb());
    productivity = await import('@/lib/analytics/productivity');
    metrics = await import('@/lib/metrics');
    const websites = await import('@/lib/websites');
    const create = await import('@/lib/tasks/create');
    for (const [name, lang] of [['Celeb News', 'en'], ['Promi Welt', 'de']] as const) {
      sites[name] = (await websites.createWebsite({ name, publicUrl: `https://${name.replace(' ', '').toLowerCase()}.example`, language: lang, targetCountry: lang === 'de' ? 'Germany' : 'United States', timezone: 'UTC' })).id;
      await client.category.create({ data: { websiteId: sites[name], externalId: 7, name: 'Stars' } });
    }
    // 5 verified articles at known times: 3 on Celeb News (celebrity), 2 on Promi Welt (tigram).
    const plan: [string, string, number][] = [
      ['Celeb News', 'celebrity-writer', 10],
      ['Celeb News', 'celebrity-writer', 50],
      ['Celeb News', 'celebrity-writer', 90],
      ['Promi Welt', 'tigram-writer', 100],
      ['Promi Welt', 'tigram-writer', 3 * 24 * 60],
    ];
    let i = 0;
    for (const [site, moduleKey, minAgo] of plan) {
      const cat = await client.category.findFirstOrThrow({ where: { websiteId: sites[site] } });
      const { task } = await create.createArticleTask({ moduleKey, keyword: `Article ${++i}`, websiteId: sites[site], categoryId: cat.id, idempotencyKey: `productivity:${i}` }, { source: 'SINGLE' });
      await client.articleTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', wpPostId: 500 + i, verifiedCompleteAt: ago(minAgo) } });
      const m = { kind: 'ARTICLE_VERIFIED', taskId: task.id, moduleKey, websiteId: sites[site], outcome: 'COMPLETED', startedAt: ago(minAgo + 20), endedAt: ago(minAgo), details: { wpPostId: 500 + i, wpEditUrl: `https://x.example/wp-admin/post.php?post=${500 + i}` }, dedupeKey: `verified:${task.id}` };
      expect(await metrics.recordMetric(m)).toBe(true);
      // A retry or restart records the same event again: it is not counted twice.
      expect(await metrics.recordMetric({ ...m, endedAt: T })).toBe(false);
      for (const [stageKey, ms, attempt, outcome] of [['TITLES', 30_000, 1, 'COMPLETED'], ['LONG_ARTICLE', 240_000 + i * 10_000, i === 2 ? 2 : 1, 'COMPLETED'], ['WORDPRESS_DRAFT', 8_000, 1, 'COMPLETED']] as const) {
        await metrics.recordMetric({ kind: 'STAGE', taskId: task.id, stageKey, moduleKey, websiteId: sites[site], attempt, outcome, startedAt: ago(minAgo + 5), endedAt: new Date(ago(minAgo + 5).getTime() + ms), dedupeKey: `stage:${task.id}:${stageKey}:a${attempt}:${outcome}` });
      }
    }
    // The fixtures' own article jobs are not real work waiting in a queue.
    await client.queueJob.updateMany({ where: { queue: 'article' }, data: { status: 'CANCELLED', finishedAt: T } });
    await client.workerStatus.create({ data: { id: 'worker', kind: 'WORKER', status: 'RUNNING', lastSeenAt: T } });
  });

  it('counts each verified draft once, with its WordPress proof, by window, site, writer and day', async () => {
    const r = await productivity.productivityReport(T);
    expect(r.rolling).toEqual([
      { minutes: 15, count: 1, perHour: 4 },
      { minutes: 60, count: 2, perHour: 2 },
      { minutes: 120, count: 4, perHour: 2 },
    ]);
    expect(r.week).toBe(5);
    expect(r.bySite).toEqual([
      { websiteId: sites['Celeb News'], name: 'Celeb News', count: 3 },
      { websiteId: sites['Promi Welt'], name: 'Promi Welt', count: 2 },
    ]);
    expect(r.byWriter).toEqual([
      { moduleKey: 'celebrity-writer', count: 3 },
      { moduleKey: 'tigram-writer', count: 2 },
    ]);
    expect(r.recent.map((v) => [v.title, v.wpPostId, v.minutes])).toEqual([
      ['Article 1', 501, 20],
      ['Article 2', 502, 20],
      ['Article 3', 503, 20],
      ['Article 4', 504, 20],
      ['Article 5', 505, 20],
    ]);
    expect(r.days.at(-1)).toEqual({ day: '2026-10-15', count: 4 });
    expect(r.days.reduce((n, d) => n + d.count, 0)).toBe(5);
    expect(r.benchmark).toMatchObject({ claim: 'FAIL', windows: [{ count: 2 }, { count: 2 }] });
    expect(r.alerts).toEqual([]);
  });

  it('stage percentiles, retries, the article median and a labelled capacity estimate', async () => {
    const r = await productivity.productivityReport(T);
    expect(r.stages[0]).toMatchObject({ stageKey: 'LONG_ARTICLE', count: 5, p50Ms: 270_000, p90Ms: 290_000, retries: 1 });
    expect(r.stages.map((s) => s.stageKey)).toEqual(['LONG_ARTICLE', 'TITLES', 'WORDPRESS_DRAFT']);
    expect(r.articleMinutes).toEqual({ p50: 20, p90: 20, samples: 5 });
    expect(r.capacityEstimate.perHour).toBe(9); // 3 slots (high-throughput default) × 60 ÷ 20 min
    expect(r.capacityEstimate.basis).toMatch(/An estimate, not a measurement/);
    const csv = await productivity.productivityCsv('verified', T);
    expect(csv.split('\r\n')[0]).toBe('verified_at_utc,article_task_id,title,website,wordpress_post_id,wordpress_edit_url,minutes_from_start');
    expect(csv.split('\r\n')).toHaveLength(1 + 5 + 1);
  });

  it('a stopped worker and a waiting queue raise alerts; paused logins suspend the target claim', async () => {
    await client.workerStatus.update({ where: { id: 'worker' }, data: { lastSeenAt: ago(10) } });
    let r = await productivity.productivityReport(T);
    expect(r.alerts.map((a) => a.level)).toEqual(['critical']);
    expect(r.benchmark).toMatchObject({ claim: 'SUSPENDED', conditions: ['the worker is not running'] });
    await client.workerStatus.update({ where: { id: 'worker' }, data: { lastSeenAt: T } });
    const t = await client.articleTask.findFirstOrThrow({ where: { keyword: 'Article 1' } });
    await client.queueJob.create({ data: { queue: 'article', kind: 'article.run', idempotencyKey: 'stalled-1', taskId: t.id, websiteId: t.websiteId, status: 'WAITING', runAt: ago(40) } });
    await client.articleTask.update({ where: { id: t.id }, data: { status: 'LOGIN_REQUIRED', pausedFor: 'wordpress-login', updatedAt: ago(30) } });
    r = await productivity.productivityReport(T);
    expect(r.alerts.map((a) => a.message)).toEqual([expect.stringMatching(/waited 40 min past its start time/)]);
    expect(r.benchmark.conditions).toEqual(['1 article(s) paused for wordpress login']);
    expect(r.review.paused).toBe(1);
    expect(r.failureReasons).toEqual([{ reason: 'Paused: wordpress login', count: 1 }]);
  });
});
