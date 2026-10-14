import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

/**
 * Bulk campaigns with the real queue, task creation and worker handler
 * (spec 02 acceptance: 1,000-row fixture, invalid/duplicate rows detected
 * without losing the original text, restart mid-campaign without loss or
 * duplication).
 */
let client: PrismaClient;
let svc: typeof import('@/lib/campaigns/service');
let siteA: string;
let siteB: string;
let catA: string;

const counts = async () => ({ campaigns: await client.campaign.count(), rows: await client.campaignRow.count(), tasks: await client.articleTask.count(), jobs: await client.queueJob.count() });

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  svc = await import('@/lib/campaigns/service');
  const websites = await import('@/lib/websites');
  siteA = (await websites.createWebsite({ name: 'Celeb News', publicUrl: 'https://celeb.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
  siteB = (await websites.createWebsite({ name: 'Promi Welt', publicUrl: 'https://promi.example', language: 'de', targetCountry: 'Germany', timezone: 'Europe/Berlin' })).id;
  catA = (await client.category.create({ data: { websiteId: siteA, externalId: 7, name: 'Celebrities' } })).id;
  await client.website.update({ where: { id: siteA }, data: { defaultCategoryId: catA } });
});

describe('campaign preview', () => {
  it('validates, routes and de-duplicates without writing anything or changing the input text', async () => {
    const create = await import('@/lib/tasks/create');
    await create.createArticleTask({ moduleKey: 'tigram-writer', keyword: 'How to Install WordPress', websiteId: siteA, idempotencyKey: 'existing-task-1' }, { source: 'SINGLE' });
    await client.linkTarget.create({ data: { websiteId: siteA, wpPostId: 41, url: 'https://celeb.example/selena-gomez-husband/', title: 'Selena Gomez Husband', keyword: 'selena gomez husband', status: 'ACTIVE' } });
    const text = [
      'keyword,secondary_keywords,title,website,kind',
      'Taylor Swift net worth,"Travis Kelce, Eras Tour",Taylor Swift Money,,',
      'taylor swift NET WORTH,,,,',
      'net worth taylor swift,,,,',
      'jaguar,,,,',
      'jaguar,,,Promi Welt,tigram',
      'How to Install WordPress,,,,',
      'Selena Gomez husband,,,,',
      `${'x'.repeat(170)},,,,`,
      'Ok Keyword Here,,,Unknown Site,',
      'Heidi Klum,,,,celebrity-writer-2',
    ].join('\n');
    const before = await counts();
    const p = await svc.previewCampaign({ text, websiteId: siteA });
    expect(await counts()).toEqual(before);
    expect(p.format).toBe('csv');
    const by = (line: number) => p.rows.find((r) => r.line === line)!;
    expect(by(2)).toMatchObject({ status: 'READY', writer: 'celebrity-writer', writerSource: 'RULE', categoryName: 'Celebrities', secondaryKeywords: ['Travis Kelce', 'Eras Tour'], exampleTitle: 'Taylor Swift Money' });
    expect(by(3).status).toBe('DUPLICATE');
    expect(by(3).issues.map((i) => i.kind)).toContain('DUPLICATE');
    expect(by(4).issues.map((i) => i.message).join()).toMatch(/Very similar to line 2/);
    expect(by(5)).toMatchObject({ status: 'NEEDS_WRITER', writer: null });
    expect(by(6)).toMatchObject({ status: 'READY', websiteName: 'Promi Welt', writer: 'tigram-writer', writerSource: 'OVERRIDE', language: 'de' }); // other site: not a duplicate
    expect(by(7).issues.map((i) => i.kind)).toContain('EXISTING_TASK');
    expect(by(7).status).toBe('DUPLICATE');
    expect(by(8).issues.find((i) => i.kind === 'EXISTING_POST')?.ref).toBe('https://celeb.example/selena-gomez-husband/');
    expect(by(9).status).toBe('INVALID');
    expect(by(10).issues[0].message).toMatch(/Unknown website “Unknown Site”/);
    expect(by(11).issues.map((i) => i.message).join()).toMatch(/not an active writer/);
    expect(by(11).writer).toBe('celebrity-writer'); // the 2.0 column is ignored, the rule decides
    expect(p.rows.map((r) => r.raw)).toEqual(text.split('\n').slice(1));
    // Owner corrections are applied by line without touching the text.
    const p2 = await svc.previewCampaign({ text, websiteId: siteA, overrides: { '5': { writer: 'tigram' }, '3': { confirmVariant: true }, '2': { include: false } } });
    expect(p2.rows.find((r) => r.line === 5)).toMatchObject({ status: 'READY', writer: 'tigram-writer' });
    expect(p2.rows.find((r) => r.line === 2)!.status).toBe('SKIPPED');
    expect(p2.rows.find((r) => r.line === 3)!.status).toBe('READY'); // its twin is skipped, and it is confirmed anyway
  });
});

describe('campaign queueing', () => {
  it('imports a 1,000-row fixture and queues exactly one standard task per READY row, idempotently', async () => {
    const text = Array.from({ length: 1000 }, (_, i) => `How to fix error code ${i + 1} | troubleshooting | Error ${i + 1} explained`).join('\n');
    const started = Date.now();
    const { campaign, summary } = await svc.createCampaign({ text, websiteId: siteB, defaultWriter: 'AUTO', name: 'Big import' });
    expect(summary).toMatchObject({ rows: 1000, ready: 1000, tigram: 1000 });
    const r = await svc.queueCampaignRows(campaign.id);
    expect(r).toEqual({ created: 1000, existing: 0, failed: 0 });
    expect(await client.articleTask.count({ where: { campaignId: campaign.id, source: 'BULK' } })).toBe(1000);
    const ids = (await client.articleTask.findMany({ where: { campaignId: campaign.id }, select: { id: true } })).map((t) => t.id);
    let jobs = 0;
    for (let i = 0; i < ids.length; i += 400) jobs += await client.queueJob.count({ where: { queue: 'article', taskId: { in: ids.slice(i, i + 400) } } });
    expect(jobs).toBe(1000);
    const sample = await client.articleTask.findFirstOrThrow({ where: { campaignId: campaign.id, keyword: 'How to fix error code 517' } });
    expect(sample).toMatchObject({ moduleKey: 'tigram-writer', exampleTitle: 'Error 517 explained', secondaryKeywords: JSON.stringify(['troubleshooting']), language: 'de' });
    expect(JSON.parse(sample.routeDecision)).toMatchObject({ source: 'RULE', moduleKey: 'tigram-writer' });
    expect(Date.now() - started).toBeLessThan(60_000);
    // Re-running (e.g. a duplicate worker job) creates nothing.
    expect(await svc.queueCampaignRows(campaign.id)).toEqual({ created: 0, existing: 0, failed: 0 });
    expect((await client.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).inputText).toBe(text);
  }, 120_000);

  it('a restart mid-campaign loses and duplicates nothing (worker job requeued, crashed row reconciled)', async () => {
    const text = Array.from({ length: 120 }, (_, i) => `best free tool number ${i + 1}`).join('\n');
    const { campaign } = await svc.createCampaign({ text, websiteId: siteB });
    // Crash after the first chunk of 50…
    await expect(svc.queueCampaignRows(campaign.id, async () => { throw new Error('worker killed'); })).rejects.toThrow('worker killed');
    expect(await client.articleTask.count({ where: { campaignId: campaign.id } })).toBe(50);
    // …and one row whose task was created just before the crash, without the row being updated.
    const row = await client.campaignRow.findFirstOrThrow({ where: { campaignId: campaign.id, taskId: null }, orderBy: { position: 'asc' } });
    const create = await import('@/lib/tasks/create');
    await create.createArticleTask({ moduleKey: row.writer, keyword: row.keyword, websiteId: siteB, idempotencyKey: `campaign-row:${row.id}` }, { source: 'BULK', campaignId: campaign.id, campaignRowId: row.id });
    // The job that was running is requeued at startup and finishes the rest.
    const job = await client.queueJob.findFirstOrThrow({ where: { queue: 'workflow', relatedId: campaign.id } });
    await client.queueJob.update({ where: { id: job.id }, data: { status: 'ACTIVE', lockedBy: 'dead-worker', attempts: 1 } });
    const { recoverOnStartup } = await import('@/worker/recovery');
    await recoverOnStartup('new-worker');
    expect((await client.queueJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('WAITING');
    const { workflowTick } = await import('@/worker/workflow-queue');
    await workflowTick('new-worker', () => false);
    expect((await client.queueJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('COMPLETED');
    const tasks = await client.articleTask.findMany({ where: { campaignId: campaign.id }, select: { idempotencyKey: true, campaignRowId: true } });
    expect(tasks).toHaveLength(120);
    expect(new Set(tasks.map((t) => t.campaignRowId)).size).toBe(120);
    expect(await client.campaignRow.count({ where: { campaignId: campaign.id, status: 'QUEUED', taskId: { not: null } } })).toBe(120);
    expect((await client.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).message).toMatch(/69 task\(s\) created, 1 already existed/);
  });
});

describe('campaign controls', () => {
  it('pause holds new articles, cancel stops the rest, row corrections queue fixed rows, export and templates work', async () => {
    const { campaign } = await svc.createCampaign({ text: 'jaguar\nhow to draw a zebra\nhow to draw a zebra', websiteId: siteB, name: 'Controls' });
    const rows = await client.campaignRow.findMany({ where: { campaignId: campaign.id }, orderBy: { position: 'asc' } });
    expect(rows.map((r) => r.status)).toEqual(['NEEDS_WRITER', 'READY', 'DUPLICATE']);
    await svc.queueCampaignRows(campaign.id);
    // The paused campaign's article gets the HIGHEST priority, so it would start first if pausing did not hold it.
    await svc.campaignRowAction(campaign.id, { rowIds: [rows[1].id], action: 'priority', priority: 10 });
    await svc.pauseCampaign(campaign.id);
    const create = await import('@/lib/tasks/create');
    const { task: other } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword: 'unrelated topic guide', websiteId: siteB, priority: 9, idempotencyKey: 'other-task-1' }, { source: 'SINGLE' });
    const { registerBuiltInPipelines } = await import('@/worker/pipelines');
    registerBuiltInPipelines();
    const { ArticleDispatcher } = await import('@/worker/dispatcher');
    const d = new ArticleDispatcher('w1');
    await d.tick(() => false);
    await d.drain(10_000);
    const paused = await client.articleTask.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(paused.status).toBe('QUEUED');
    expect((await client.articleTask.findUniqueOrThrow({ where: { id: other.id } })).status).not.toBe('QUEUED');
    // Corrections: choose a writer for row 1, confirm row 3 as an intentional variant; correcting a queued row is refused.
    const fix = await svc.campaignRowAction(campaign.id, { rowIds: [rows[0].id], action: 'writer', writer: 'tigram' });
    expect(fix.changed).toBe(1);
    const refused = await svc.campaignRowAction(campaign.id, { rowIds: [rows[1].id], action: 'writer', writer: 'celebrity' });
    expect(refused.notes[0]).toMatch(/already queued/);
    await svc.campaignRowAction(campaign.id, { rowIds: [rows[2].id], action: 'confirm-variant' });
    const { workflowTick } = await import('@/worker/workflow-queue');
    await workflowTick('w1', () => false);
    const after = await client.campaignRow.findMany({ where: { campaignId: campaign.id }, orderBy: { position: 'asc' } });
    expect(after.map((r) => r.status)).toEqual(['QUEUED', 'QUEUED', 'QUEUED']);
    const variant = await client.articleTask.findUniqueOrThrow({ where: { id: after[2].taskId! } });
    expect(JSON.parse(variant.options).allowDuplicate).toBe(true);
    expect(variant.moduleKey).toBe('tigram-writer');
    // Reprioritize.
    expect((await client.queueJob.findFirstOrThrow({ where: { taskId: after[1].taskId!, queue: 'article' } })).priority).toBe(10);
    // Export.
    const csv = await svc.exportCampaignCsv(campaign.id);
    expect(csv.split('\n')[0]).toBe('line,keyword,secondary_keywords,title,website,writer,writer_source,row_status,task_status,wp_post_id,wp_edit_url,seo_score,rank_math_score,review_reasons,issues');
    expect(csv).toContain('how to draw a zebra');
    // Cancel: nothing deleted, tasks asked to stop.
    const res = await svc.cancelCampaign(campaign.id);
    expect(res.tasks).toBe(3);
    expect(await client.campaignRow.count({ where: { campaignId: campaign.id } })).toBe(3);
    expect((await client.articleTask.findMany({ where: { campaignId: campaign.id } })).every((t) => t.cancelRequested || t.status === 'CANCELLED')).toBe(true);
    // Templates.
    await svc.saveTemplate({ name: 'German tech', websiteId: siteB, defaultWriter: 'tigram-writer', options: { images: 'off' } });
    expect((await svc.listTemplates()).map((t) => t.name)).toEqual(['German tech']);
    await svc.deleteTemplate('German tech');
    expect(await svc.listTemplates()).toEqual([]);
  });

  it('the preview API needs the dashboard CSRF token', async () => {
    const route = await import('../../app/api/campaigns/preview/route');
    const make = (token: string | null) =>
      new Request('http://localhost:3000/api/campaigns/preview', { method: 'POST', headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: 'bas_csrf=tok12345', ...(token ? { 'x-csrf-token': token } : {}), 'content-type': 'application/json' }, body: JSON.stringify({ text: 'best vpn apps', websiteId: siteB }) });
    expect((await route.POST(make(null), { params: Promise.resolve({}) })).status).toBe(403);
    const ok = await route.POST(make('tok12345'), { params: Promise.resolve({}) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).summary).toMatchObject({ rows: 1, ready: 1, tigram: 1 });
  });
});
