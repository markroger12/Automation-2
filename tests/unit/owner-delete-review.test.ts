import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { makeDriver } from '../helpers/drive';

/**
 * Owner requests (2026-10-21): delete queued and completed articles and campaigns; a duplicate keyword that was
 * approved continues; the review system is off by default. Real engine, scripted ChatGPT; the sites are logged out,
 * so an article that passes the quality gate stops at the WordPress draft step.
 */
let client: PrismaClient;
let dir: string;
let create: typeof import('@/lib/tasks/create');
let driver: ReturnType<typeof makeDriver>;
let site: string;

async function tigramTask(keyword: string, key: string, extra: Record<string, unknown> = {}) {
  const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword, websiteId: site, options: { images: 'off', externalLinks: false, internalLinks: false }, idempotencyKey: key, ...extra }, { source: 'SINGLE' });
  return task;
}

beforeAll(async () => {
  ({ client, dir } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  create = await import('@/lib/tasks/create');
  const { registerBuiltInPipelines } = await import('@/worker/pipelines');
  registerBuiltInPipelines();
  driver = makeDriver(client, undefined, { detectDuplicates: true });
  const websites = await import('@/lib/websites');
  site = (await websites.createWebsite({ name: 'Owner Site', publicUrl: 'https://owner-site.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' })).id;
  await client.category.create({ data: { websiteId: site, externalId: 5, name: 'Guides' } });
  await client.browserProfile.updateMany({ data: { sessionState: 'LOGIN_REQUIRED' } });
});

describe('owner requests: delete, duplicate approval, no review hold', () => {
  it('review off (default): a second article repeating the wording is not held; the draft step runs and it is never published automatically', async () => {
    const first = await driver.drive((await tigramTask('How to Install WordPress', 'odr-test:1')).id);
    expect(first.status).toBe('LOGIN_REQUIRED');
    const second = await driver.drive((await tigramTask('How to Set Up a Static Website', 'odr-test:2')).id);
    // Before: NEEDS_REVIEW “Quality gate stopped before WordPress”.
    expect(second.status).toBe('LOGIN_REQUIRED');
    const gate = await client.articleStage.findUniqueOrThrow({ where: { taskId_key: { taskId: second.id, key: 'QUALITY_GATE' } } });
    expect(gate.status).toBe('COMPLETED');
    expect(gate.message).toMatch(/serious problem\(s\) noted — saved as a draft only, never published automatically/);
    expect(JSON.parse(second.options).publishBlocked.join(' ')).toMatch(/wording/);
  });

  it('a duplicate keyword approved with “Approve selected” continues (owner report: it was held again)', async () => {
    const t = await driver.drive((await tigramTask('how to installs wordpress', 'odr-test:3')).id);
    expect(t.status).toBe('NEEDS_REVIEW');
    expect(JSON.parse(t.reviewReasons)[0]).toMatch(/^Possible duplicate on this website/);
    const { approveWaiting } = await import('@/lib/tasks/actions');
    expect(await approveWaiting(t.id, '')).toBe('duplicate');
    const after = await driver.drive(t.id);
    expect((await client.articleStage.findUniqueOrThrow({ where: { taskId_key: { taskId: t.id, key: 'DUPLICATE_PRECHECK' } } })).status).toBe('COMPLETED');
    expect(after.status).not.toBe('NEEDS_REVIEW');
  });

  it('“Approve despite review reasons” on a duplicate hold allows the duplicate too', async () => {
    const t = await driver.drive((await tigramTask('how to install wordpres', 'odr-test:4')).id);
    expect(t.status).toBe('NEEDS_REVIEW');
    const { overrideQuality } = await import('@/lib/tasks/actions');
    await overrideQuality(t.id, { reason: 'intentional second version' });
    const after = await driver.drive(t.id);
    expect((await client.articleStage.findUniqueOrThrow({ where: { taskId_key: { taskId: t.id, key: 'DUPLICATE_PRECHECK' } } })).status).toBe('COMPLETED');
    expect(after.status).not.toBe('NEEDS_REVIEW');
  });

  it('finalize: a verified draft with review reasons is COMPLETED, the reasons are notes', async () => {
    const task = await tigramTask('Notes Only Article', 'odr-test:5');
    await client.articleTask.update({ where: { id: task.id }, data: { wpPostId: 501, wpDraftAt: new Date(), wpVerifiedAt: new Date(), reviewReasons: JSON.stringify(['“Not publicly confirmed” appears 6 times. [FINAL_ARTICLE]']) } });
    await client.articleStage.upsert({ where: { taskId_key: { taskId: task.id, key: 'VERIFIED_COMPLETE' } }, update: { status: 'COMPLETED', outputJson: JSON.stringify({ verified: true }) }, create: { taskId: task.id, key: 'VERIFIED_COMPLETE', position: 99, label: 'Verified complete', kind: 'local', status: 'COMPLETED', outputJson: JSON.stringify({ verified: true }) } });
    const { finalizeTask } = await import('@/worker/pipelines/common');
    await finalizeTask({ taskId: task.id, config: { holdForReview: false } } as never);
    const t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('COMPLETED');
    expect(t.message).toBe('Verified WordPress draft #501. 1 note(s) on the article page.');
    expect(JSON.parse(t.reviewReasons)).toHaveLength(1);
    await finalizeTask({ taskId: task.id, config: { holdForReview: true } } as never);
    expect((await client.articleTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('NEEDS_REVIEW');
  });

  it('data migration: articles held only for review reasons with a verified draft become COMPLETED (backup first)', async () => {
    const task = await tigramTask('Held Before Update', 'odr-test:6');
    await client.articleTask.update({ where: { id: task.id }, data: { status: 'NEEDS_REVIEW', wpPostId: 777, wpDraftAt: new Date(), wpVerifiedAt: new Date(), reviewReasons: JSON.stringify(['a', 'b']) } });
    await client.articleStage.upsert({ where: { taskId_key: { taskId: task.id, key: 'VERIFIED_COMPLETE' } }, update: { status: 'COMPLETED', outputJson: JSON.stringify({ verified: true }) }, create: { taskId: task.id, key: 'VERIFIED_COMPLETE', position: 99, label: 'Verified complete', kind: 'local', status: 'COMPLETED', outputJson: JSON.stringify({ verified: true }) } });
    const noDraft = await tigramTask('Held Without Draft', 'odr-test:7');
    await client.articleTask.update({ where: { id: noDraft.id }, data: { status: 'NEEDS_REVIEW' } });
    const { reviewReasonsBecomeNotes } = await import('@/lib/review-notes-migration');
    const res = await reviewReasonsBecomeNotes(client);
    expect(res.completed).toBe(2); // this one, and the one the finalize test left held for review
    expect((await client.articleTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('COMPLETED');
    expect((await client.articleTask.findUniqueOrThrow({ where: { id: noDraft.id } })).status).toBe('NEEDS_REVIEW');
    expect(fs.existsSync(path.join(dir, 'backups', 'migrations', '2026-10-21-review-reasons-become-notes.json'))).toBe(true);
  });

  it('deletes a queued and a completed article from the app: report backed up, campaign row and workflow keyword released', async () => {
    const { deleteTask } = await import('@/lib/tasks/delete');
    const queued = await tigramTask('Queued To Delete', 'odr-test:8');
    expect(await client.queueJob.count({ where: { taskId: queued.id } })).toBeGreaterThan(0);
    expect(await deleteTask(queued.id)).toEqual({ status: 'deleted' });
    expect(await client.articleTask.findUnique({ where: { id: queued.id } })).toBeNull();
    expect(await client.queueJob.count({ where: { taskId: queued.id } })).toBe(0);
    const backups = fs.readdirSync(path.join(dir, 'backups', 'deleted-articles'));
    expect(backups.some((f) => f.startsWith(queued.id))).toBe(true);

    const done = await tigramTask('Completed To Delete', 'odr-test:9');
    await client.articleTask.update({ where: { id: done.id }, data: { status: 'COMPLETED', wpPostId: 900 } });
    const wf = await client.workflow.create({ data: { websiteId: site, name: 'wf' } });
    const kw = await client.workflowKeyword.create({ data: { workflowId: wf.id, keyword: 'Completed To Delete', normalizedKeyword: 'completed to delete', position: 1, status: 'WRITING', taskId: done.id } });
    expect(await deleteTask(done.id)).toEqual({ status: 'deleted' });
    const k = await client.workflowKeyword.findUniqueOrThrow({ where: { id: kw.id } });
    expect(k).toMatchObject({ taskId: null, status: 'SKIPPED', lastError: 'The article was deleted by you.' });
    expect(await client.auditLog.count({ where: { action: 'task.delete' } })).toBe(2);
  });

  it('a running article is cancelled and deleted as soon as it stops', async () => {
    const { deleteTask } = await import('@/lib/tasks/delete');
    const t = await tigramTask('Running To Delete', 'odr-test:10');
    await client.queueJob.updateMany({ where: { taskId: t.id }, data: { status: 'ACTIVE' } });
    await client.articleTask.update({ where: { id: t.id }, data: { status: 'RUNNING' } });
    expect(await deleteTask(t.id)).toEqual({ status: 'deleting' });
    expect(await client.articleTask.findUnique({ where: { id: t.id } })).not.toBeNull();
    const { markCancelled } = await import('@/worker/pipeline/engine');
    await markCancelled(t.id);
    expect(await client.articleTask.findUnique({ where: { id: t.id } })).toBeNull();
  });

  it('deletes a campaign, with or without its articles', async () => {
    const { createCampaign, deleteCampaign, queueCampaignRows } = await import('@/lib/campaigns/service');
    const make = async (name: string) => {
      const c = await createCampaign({ name, websiteId: site, text: `${name} alpha keyword\n${name} beta keyword`, defaultWriter: 'tigram-writer' });
      const id = (c as { id?: string; campaign?: { id: string } }).id ?? (c as { campaign: { id: string } }).campaign.id;
      await queueCampaignRows(id);
      return { id };
    };
    const a = await make('camp one');
    const tasksA = await client.articleTask.findMany({ where: { campaignId: a.id } });
    expect(tasksA.length).toBe(2);
    const resA = await deleteCampaign(a.id, true);
    expect(resA).toMatchObject({ ok: true, articles: 2, deleted: 2 });
    expect(await client.campaign.findUnique({ where: { id: a.id } })).toBeNull();
    expect(await client.articleTask.count({ where: { id: { in: tasksA.map((t) => t.id) } } })).toBe(0);
    const b = await make('camp two');
    const tasksB = await client.articleTask.findMany({ where: { campaignId: b.id } });
    await deleteCampaign(b.id, false);
    expect(await client.campaignRow.count({ where: { campaignId: b.id } })).toBe(0);
    expect(await client.articleTask.count({ where: { id: { in: tasksB.map((t) => t.id) }, campaignId: null } })).toBe(2);
  });

  it('humanizer off by default: the global switch saved as on is turned off once; a website can switch it on', async () => {
    const { updateSettings, getSettings } = await import('@/lib/settings');
    await updateSettings({ content: { humanizerEnabled: true } });
    const { humanizerOffByDefault } = await import('@/lib/humanizer-default-migration');
    expect(await humanizerOffByDefault(client)).toMatchObject({ changed: true, before: true });
    expect((await getSettings()).content.humanizerEnabled).toBe(false);
    expect(await humanizerOffByDefault(client)).toMatchObject({ changed: false });
    const { effectiveTaskConfig, siteOverridesSchema, taskOptionsSchema } = await import('@/lib/settings-schema');
    const global = await getSettings();
    const on = effectiveTaskConfig(global, siteOverridesSchema.parse({ content: { humanizerEnabled: true } }), taskOptionsSchema.parse({}));
    const inherit = effectiveTaskConfig(global, siteOverridesSchema.parse({}), taskOptionsSchema.parse({}));
    expect(on.humanizerEnabled).toBe(true);
    expect(inherit.humanizerEnabled).toBe(false);
  });
});
