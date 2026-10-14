import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

/**
 * Celebrity Writer 2.0 retirement (spec §7.2, §21A-D) on a database that
 * already holds 2.0 history: an "existing installation" built with raw rows.
 */
let client: PrismaClient;
let siteId: string;
let doneId: string;
let runningId: string;
let reviewId: string;

async function legacyTask(data: Record<string, unknown>) {
  return client.articleTask.create({
    data: {
      moduleKey: 'celebrity-writer-2',
      keyword: 'Old Keyword',
      normalizedKeyword: 'old keyword',
      websiteId: siteId,
      language: 'en',
      targetCountry: 'United States',
      idempotencyKey: `legacy-${Math.random()}`,
      ...data,
    },
  });
}

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedSettings } = await import('@/lib/settings');
  await seedSettings(client);
  const site = await client.website.create({ data: { name: 'Old Site', slug: 'old-site', publicUrl: 'https://old.example', adminUrl: 'https://old.example/wp-admin/', language: 'en', targetCountry: 'United States', timezone: 'UTC', settingsOverrides: JSON.stringify({ content: {}, seo: {}, workflow: { workflowCelebrityWriter: '2.0' }, router: { writers: ['celebrity-writer-2', 'celebrity-writer', 'tigram-writer'] } }) } });
  siteId = site.id;
  const done = await legacyTask({ status: 'COMPLETED', wpPostId: 4711, wpEditUrl: 'https://old.example/wp-admin/post.php?post=4711&action=edit', assembledHtml: '<p>Old article</p>', conversationUrl: 'https://chatgpt.com/c/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  doneId = done.id;
  await client.articleStage.create({ data: { taskId: done.id, key: 'FINAL', label: 'Final', kind: 'chatgpt', position: 1, status: 'COMPLETED', output: 'old output' } });
  await client.chatGPTResponse.create({ data: { taskId: done.id, stageKey: 'FINAL', attempt: 1, operationId: `${done.id}:FINAL:a1`, promptHash: 'x', renderedPrompt: 'old prompt', resultText: 'old answer', status: 'COMPLETED' } });
  await client.log.create({ data: { taskId: done.id, category: 'task', level: 'info', message: 'legacy log line' } });
  const running = await legacyTask({ status: 'WRITING_ARTICLE', stage: 'LONG_ARTICLE', bodyHtml: '<p>half written</p>' });
  runningId = running.id;
  await client.queueJob.create({ data: { queue: 'article', kind: 'article.run', taskId: running.id, websiteId: siteId, idempotencyKey: `article:${running.id}` } });
  await client.queueJob.create({ data: { queue: 'chatgpt', kind: 'chatgpt.prompt', taskId: running.id, websiteId: siteId, idempotencyKey: `chatgpt:${running.id}:x`, payload: '{"prompt":"half"}' } });
  reviewId = (await legacyTask({ status: 'NEEDS_REVIEW', reviewReasons: JSON.stringify(['Older reason']) })).id;
  await client.promptTemplate.create({ data: { moduleKey: 'celebrity-writer-2', stageKey: 'WRITE', name: 'Old 2.0 prompt', description: 'owner text', content: 'My custom 2.0 prompt', defaultHash: 'h', defaultVersion: 1, customized: true } });
  // Stored global settings from the old installation: 2.0 preferred, plus an owner value that must survive.
  const row = await client.setting.findUniqueOrThrow({ where: { key: 'global' } });
  const stored = JSON.parse(row.value);
  stored.workflow.workflowCelebrityWriter = '2.0';
  stored.content.faqCount = 9;
  await client.setting.update({ where: { key: 'global' }, data: { value: JSON.stringify(stored) } });
});

describe('Celebrity Writer 2.0 retirement', () => {
  it('a leftover invalid preference does not wipe the other owner settings', async () => {
    const { getSettings } = await import('@/lib/settings');
    const s = await getSettings();
    expect(s.content.faqCount).toBe(9);
    expect(s.workflow.workflowCelebrityWriter).toBe('1.0');
  });

  it('migrates once with a backup: history read-only, unfinished tasks to review, jobs cancelled, preferences moved, prompts kept', async () => {
    const { seedAll } = await import('@/lib/seed');
    const report = await seedAll(client);
    expect(report.join('\n')).toMatch(/Data migration 2026-10-14-retire-celebrity-writer-2: applied ✓/);
    const done = await client.articleTask.findUniqueOrThrow({ where: { id: doneId } });
    expect(done).toMatchObject({ legacy: true, status: 'COMPLETED', wpPostId: 4711, assembledHtml: '<p>Old article</p>' });
    const running = await client.articleTask.findUniqueOrThrow({ where: { id: runningId } });
    expect(running).toMatchObject({ legacy: true, status: 'NEEDS_REVIEW', bodyHtml: '<p>half written</p>' });
    expect(running.message).toMatch(/Retired writer — choose a supported writer/);
    expect(JSON.parse((await client.articleTask.findUniqueOrThrow({ where: { id: reviewId } })).reviewReasons)).toEqual(['Older reason', 'Retired writer — choose a supported writer to create a new task.']);
    const jobs = await client.queueJob.findMany({ where: { taskId: runningId } });
    expect(jobs.map((j) => [j.status, j.errorCode])).toEqual([
      ['CANCELLED', 'RETIRED_WRITER'],
      ['CANCELLED', 'RETIRED_WRITER'],
    ]);
    expect((await client.promptTemplate.findFirstOrThrow({ where: { moduleKey: 'celebrity-writer-2' } })).content).toBe('My custom 2.0 prompt');
    const stored = JSON.parse((await client.setting.findUniqueOrThrow({ where: { key: 'global' } })).value);
    expect(stored.workflow.workflowCelebrityWriter).toBe('1.0');
    expect(stored.content.faqCount).toBe(9);
    const overrides = JSON.parse((await client.website.findUniqueOrThrow({ where: { id: siteId } })).settingsOverrides);
    expect(overrides.workflow.workflowCelebrityWriter).toBe('1.0');
    expect(overrides.router.writers).toEqual(['celebrity-writer', 'tigram-writer']);
    const record = JSON.parse((await client.dataMigration.findUniqueOrThrow({ where: { id: '2026-10-14-retire-celebrity-writer-2' } })).details);
    expect(record).toMatchObject({ legacyTasks: 3, unfinishedMarkedForReview: 2, jobsCancelled: 2, settingsMigrated: 1, sitesMigrated: 1, legacyPromptsKept: 1 });
    expect(fs.existsSync(path.join(process.env.BAS_DATA_DIR!, 'backups', 'migrations', record.backupFile))).toBe(true);
  });

  it('re-running setup neither re-creates nor deletes anything', async () => {
    const counts = async () => Promise.all([client.articleTask.count(), client.queueJob.count(), client.chatGPTResponse.count(), client.log.count({ where: { taskId: doneId } }), client.promptTemplate.count(), client.dataMigration.count()]);
    const before = await counts();
    const { seedAll } = await import('@/lib/seed');
    expect((await seedAll(client)).join('\n')).toMatch(/retire-celebrity-writer-2: already applied ✓/);
    expect(await counts()).toEqual(before);
  });

  it('2.0 cannot be selected or queued; exactly two writers are offered', async () => {
    const { ACTIVE_MODULE_KEYS } = await import('@/lib/domain');
    const { writerOptions, getManifest } = await import('@/modules/registry');
    expect([...ACTIVE_MODULE_KEYS]).toEqual(['celebrity-writer', 'tigram-writer']);
    expect(writerOptions().map((w) => w.key)).toEqual(['celebrity-writer', 'tigram-writer']);
    expect(getManifest('celebrity-writer-2')).toBeUndefined();
    const create = await import('@/lib/tasks/create');
    await expect(create.createArticleTask({ moduleKey: 'celebrity-writer-2', keyword: 'New', websiteId: siteId, idempotencyKey: 'new-2' }, { source: 'SINGLE' })).rejects.toThrow();
    // A stale browser tab posting to the API gets a validation error, not a task.
    const route = await import('../../app/api/tasks/route');
    const res = await route.POST(new Request('http://localhost:3000/api/tasks', { method: 'POST', headers: { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: 'bas_csrf=tok12345', 'x-csrf-token': 'tok12345', 'content-type': 'application/json' }, body: JSON.stringify({ moduleKey: 'celebrity-writer-2', keyword: 'Stale tab', websiteId: siteId, idempotencyKey: 'stale-tab' }) }));
    expect(res.status).toBe(400);
    expect(await client.articleTask.count({ where: { keyword: 'Stale tab' } })).toBe(0);
    // Even a job injected behind the API is refused by the engine and the task goes to review.
    const injected = await legacyTask({ status: 'QUEUED' });
    const job = await client.queueJob.create({ data: { queue: 'article', kind: 'article.run', taskId: injected.id, websiteId: siteId, idempotencyKey: `article:${injected.id}` } });
    const queue = await import('@/lib/queue');
    const engine = await import('@/worker/pipeline/engine');
    const { registerBuiltInPipelines } = await import('@/worker/pipelines');
    registerBuiltInPipelines();
    const claimed = await queue.claimNext({ queue: 'article', owner: 'w', leaseMs: 60_000 });
    expect(claimed?.id).toBe(job.id);
    await engine.runArticleJob(claimed!, { workerId: 'w', leaseMs: 60_000 });
    const after = await client.articleTask.findUniqueOrThrow({ where: { id: injected.id } });
    expect(after.status).toBe('NEEDS_REVIEW');
    expect(await client.chatGPTResponse.count({ where: { taskId: injected.id } })).toBe(0);
  });

  it('old 2.0 records stay readable with their outputs, post IDs, conversation, prompts and logs; actions are refused', async () => {
    const { getTaskDetail } = await import('@/lib/tasks/detail');
    const d = (await getTaskDetail(doneId))!;
    expect(d.writerName).toMatch(/2\.0 \(retired\)/);
    expect(d.wpPostId).toBe(4711);
    expect(d.stages[0].output).toBe('old output');
    expect(d.responses[0].resultText).toBe('old answer');
    expect(d.logs.some((l) => l.message === 'legacy log line')).toBe(true);
    const { listTasks, taskListQuerySchema } = await import('@/lib/tasks/query');
    const list = await listTasks(taskListQuerySchema.parse({ moduleKey: 'celebrity-writer-2' }));
    expect(list.rows.every((r) => r.legacy)).toBe(true);
    expect(list.rows.length).toBeGreaterThanOrEqual(3);
    const actions = await import('@/lib/tasks/actions');
    await expect(actions.regenerateStage(doneId, 'FINAL')).rejects.toThrow(/retired writer/i);
    // The custom 2.0 prompt is listed as a read-only archive and cannot be edited.
    const prompts = await import('@/lib/prompts/manage');
    const archived = (await prompts.listPrompts()).find((p) => p.moduleKey === 'celebrity-writer-2')!;
    expect(archived.archived).toBe(true);
    expect((await prompts.listPrompts()).filter((p) => p.archived)).toHaveLength(1);
    await expect(prompts.savePrompt(archived.id, { content: 'changed' })).rejects.toThrow(/read-only as an archive/);
    expect((await client.promptTemplate.findUniqueOrThrow({ where: { id: archived.id } })).content).toBe('My custom 2.0 prompt');
  });

  it('rollback restores the backed-up values; the next setup applies the retirement again', async () => {
    const { rollbackRetirement } = await import('@/lib/retirement');
    const record = JSON.parse((await client.dataMigration.findUniqueOrThrow({ where: { id: '2026-10-14-retire-celebrity-writer-2' } })).details);
    const restored = await rollbackRetirement(client, path.join(process.env.BAS_DATA_DIR!, 'backups', 'migrations', record.backupFile));
    expect(restored).toEqual({ settings: 1, sites: 1, tasks: 3, jobs: 2 });
    expect((await client.articleTask.findUniqueOrThrow({ where: { id: runningId } })).status).toBe('WRITING_ARTICLE');
    expect(JSON.parse((await client.setting.findUniqueOrThrow({ where: { key: 'global' } })).value).workflow.workflowCelebrityWriter).toBe('2.0');
    expect(await client.dataMigration.count({ where: { id: '2026-10-14-retire-celebrity-writer-2' } })).toBe(0);
    const { seedAll } = await import('@/lib/seed');
    await seedAll(client);
    expect((await client.articleTask.findUniqueOrThrow({ where: { id: runningId } })).status).toBe('NEEDS_REVIEW');
  });
});
