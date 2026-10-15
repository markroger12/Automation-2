import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { makeDriver } from '../helpers/drive';

/**
 * Duplicate Content Detector through the real engine with scripted ChatGPT
 * answers. Scripted answers are identical for every article, which is
 * exactly a duplicated-wording case. The sites are logged out, so articles
 * that pass the quality gate stop at the WordPress draft step.
 */
let client: PrismaClient;
let create: typeof import('@/lib/tasks/create');
let service: typeof import('@/lib/duplicates/service');
let driver: ReturnType<typeof makeDriver>;
let siteA: string;
let siteB: string;

async function tigramTask(websiteId: string, keyword: string, key: string) {
  const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword, websiteId, options: { images: 'off', externalLinks: false, internalLinks: false }, idempotencyKey: key }, { source: 'SINGLE' });
  return driver.drive(task.id);
}

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  create = await import('@/lib/tasks/create');
  service = await import('@/lib/duplicates/service');
  const { registerBuiltInPipelines } = await import('@/worker/pipelines');
  registerBuiltInPipelines();
  driver = makeDriver(client, undefined, { detectDuplicates: true });
  const websites = await import('@/lib/websites');
  siteA = (await websites.createWebsite({ name: 'Tech A', publicUrl: 'https://tech-a.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
  siteB = (await websites.createWebsite({ name: 'Tech B', publicUrl: 'https://tech-b.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
  for (const [i, s] of [siteA, siteB].entries()) await client.category.create({ data: { websiteId: s, externalId: 10 + i, name: 'Guides' } });
  await client.browserProfile.updateMany({ data: { sessionState: 'LOGIN_REQUIRED' } });
});

describe('Duplicate Content Detector in the pipeline', () => {
  let second: string;

  it('the first article passes; a second article repeating its wording stops before WordPress with the evidence', async () => {
    const first = await tigramTask(siteA, 'How to Install WordPress', 'dup-test:1');
    expect(first.status).toBe('LOGIN_REQUIRED');
    const firstReport = await client.articleQualityReport.findFirstOrThrow({ where: { taskId: first.id }, orderBy: { createdAt: 'desc' } });
    expect(JSON.parse(firstReport.sections).duplicates).toMatchObject({ highest: null, compared: 0 });

    const t = await tigramTask(siteA, 'How to Set Up a Static Website', 'dup-test:2');
    second = t.id;
    expect(t.status).toBe('NEEDS_REVIEW');
    expect(t.message).toMatch(/Quality gate stopped before WordPress/);
    expect(JSON.parse(t.reviewReasons).join(' ')).toMatch(/% of the wording .* repeats “How to Install WordPress: The Complete Guide” on Tech A\. See Duplicate Review\. \[DUPLICATES\]/);
    expect(t.wpPostId).toBeNull();
    const matches = await client.duplicateMatch.findMany({ where: { taskId: t.id } });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ otherTaskId: first.id, severity: 'HIGH', status: 'OPEN', sameWebsite: true });
    expect(matches[0].exactParagraphs).toBeGreaterThan(2);
    expect(JSON.parse(matches[0].excerpts)[0]).toMatchObject({ kind: 'wording' });
    expect(await client.contentFingerprint.count({ where: { taskId: t.id } })).toBeGreaterThan(3);
    const report = await client.articleQualityReport.findFirstOrThrow({ where: { taskId: t.id }, orderBy: { createdAt: 'desc' } });
    expect(report.status).toBe('BLOCKED');
    expect(JSON.parse(report.hardStops)[0]).toMatchObject({ code: 'DUPLICATE_WORDING', source: 'DUPLICATES' });
    const reviews = await service.listDuplicateReviews({ status: 'OPEN' });
    expect(reviews.map((r) => r.task.id)).toEqual([t.id]);
  });

  it('keeping it needs a reason; the override is audited, the article continues, and it can be withdrawn', async () => {
    await expect(service.overrideDuplicates(second, { reason: 'ok' })).rejects.toThrow();
    const res = await service.overrideDuplicates(second, { reason: 'Intentional sister guide for a different audience.' });
    expect(res).toMatchObject({ ok: true, overridden: 1, retried: true });
    expect(await client.auditLog.count({ where: { action: 'duplicate.override', entityId: second } })).toBe(1);
    const t = await driver.drive(second);
    expect(t.status).toBe('LOGIN_REQUIRED');
    expect((await client.duplicateMatch.findFirstOrThrow({ where: { taskId: second } })).status).toBe('OVERRIDDEN');
    const report = await client.articleQualityReport.findFirstOrThrow({ where: { taskId: second }, orderBy: { createdAt: 'desc' } });
    expect(report.status).not.toBe('BLOCKED');
    expect(JSON.parse(report.sections).duplicates).toMatchObject({ highest: 'HIGH', overridden: true, overrideReason: 'Intentional sister guide for a different audience.' });
    expect((await service.listDuplicateReviews({ status: 'OVERRIDDEN' }))[0].task.overrideReason).toMatch(/sister guide/);
    await service.withdrawOverride(second);
    expect((await client.duplicateMatch.findFirstOrThrow({ where: { taskId: second } })).status).toBe('OPEN');
  });

  it('precheck: a near-duplicate keyword on the same site pauses before any ChatGPT work; a published post is a warning; another site is a note', async () => {
    const before = await client.chatGPTResponse.count();
    const near = await tigramTask(siteA, 'how to installs wordpress', 'dup-test:3');
    expect(near.status).toBe('NEEDS_REVIEW');
    expect(near.message).toMatch(/very similar to “How to Install WordPress”/);
    expect(await client.chatGPTResponse.count()).toBe(before);

    await client.linkTarget.create({ data: { websiteId: siteB, wpPostId: 77, url: 'https://tech-b.example/wordpress-install-guide/', title: 'The Complete WordPress Install Guide (2026)' } });
    const cross = await tigramTask(siteB, 'WordPress install', 'dup-test:4');
    const pre = await client.articleStage.findUniqueOrThrow({ where: { taskId_key: { taskId: cross.id, key: 'DUPLICATE_PRECHECK' } } });
    expect(pre.status).toBe('COMPLETED');
    const data = JSON.parse(pre.outputJson!);
    expect(data.warnings[0]).toMatch(/A published post on this website already covers “WordPress install”: “The Complete WordPress Install Guide \(2026\)”/);
    // Same scripted wording as the Tech A articles: stopped at the gate, the evidence names the other website.
    expect(cross.status).toBe('NEEDS_REVIEW');
    const m = await client.duplicateMatch.findFirstOrThrow({ where: { taskId: cross.id, severity: 'HIGH' } });
    expect(m).toMatchObject({ sameWebsite: false, otherWebsite: 'Tech A' });
  });

  it('a campaign preview routes by the website’s own rules', async () => {
    const websites = await import('@/lib/websites');
    await expect(websites.saveRoutingRules(siteA, { rules: [{ contains: 'x', writer: 'tigram-writer' }] })).rejects.toThrow(/at least 2 characters/);
    await websites.saveRoutingRules(siteA, { rules: [{ contains: 'net worth', writer: 'celebrity-writer' }, { contains: 'NET WORTH', writer: 'tigram-writer' }] });
    expect(await websites.getRoutingRules(siteA)).toEqual([{ contains: 'net worth', writer: 'celebrity-writer' }]);
    const { previewCampaign } = await import('@/lib/campaigns/service');
    const p = await previewCampaign({ name: 'c', websiteId: siteA, text: 'jaguar net worth\nbest vpn apps', defaultWriter: 'AUTO' });
    expect(p.rows[0]).toMatchObject({ writer: 'celebrity-writer', writerSource: 'SITE_RULE', routerRationale: 'Website rule: keyword contains “net worth”.' });
    expect(p.rows[1].writerSource).toBe('RULE');
  });
});
