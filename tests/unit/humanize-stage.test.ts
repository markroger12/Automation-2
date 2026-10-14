import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { makeDriver, type ScriptedAnswer } from '../helpers/drive';
import { cannedAnswer } from '../helpers/fake-answers';

/**
 * HUMANIZE stage and Humanizer page runs with the real engine, queue, prompt
 * rendering and ChatGPT bridge (scripted answers, no live ChatGPT).
 */
let client: PrismaClient;
let create: typeof import('@/lib/tasks/create');
let actions: typeof import('@/lib/tasks/actions');
let runs: typeof import('@/lib/humanizer/runs');
let worker: typeof import('@/worker/humanizer');
let siteId: string;
let catId: string;

/** Paragraphs of a HUMANIZE prompt, by label. */
function promptParagraphs(prompt: string): [string, string][] {
  const lines = prompt.slice(prompt.lastIndexOf('Paragraphs:')).split('\n');
  const out: [string, string][] = [];
  lines.forEach((l, i) => {
    const m = /^\[(P\d+)\]$/.exec(l.trim());
    if (m && lines[i + 1]) out.push([m[1], lines[i + 1]]);
  });
  return out;
}

/** An editor that removes "When it comes to" from point 1 (allowed) and changes point 3 into point 4 (a fact). */
function editorAnswer(prompt: string): string {
  return promptParagraphs(prompt)
    .map(([id, text]) => {
      let t = text.replace('When it comes to installation, point 1 often', 'For installation, point 1 often');
      t = t.replace(/point 3 often/, 'point 4 often');
      return `[${id}]\n${t}`;
    })
    .join('\n\n');
}

const tigram = (key: string, keyword = 'How to Install WordPress') =>
  create.createArticleTask({ moduleKey: 'tigram-writer', keyword, websiteId: siteId, categoryId: catId, options: { images: 'off', externalLinks: false, internalLinks: false, saveToWordPress: false }, idempotencyKey: key }, { source: 'SINGLE' });

const stageData = async (taskId: string) => JSON.parse((await client.articleStage.findFirstOrThrow({ where: { taskId, key: 'HUMANIZE' } })).outputJson ?? 'null');
const hz = (taskId: string) => client.chatGPTResponse.findMany({ where: { taskId, stageKey: 'HUMANIZE' }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  const { updateSettings } = await import('@/lib/settings');
  await updateSettings({ content: { humanizerBatchWords: 300 } });
  create = await import('@/lib/tasks/create');
  actions = await import('@/lib/tasks/actions');
  runs = await import('@/lib/humanizer/runs');
  worker = await import('@/worker/humanizer');
  const { registerBuiltInPipelines } = await import('@/worker/pipelines');
  registerBuiltInPipelines();
  const websites = await import('@/lib/websites');
  const site = await websites.createWebsite({ name: 'Tech Blog', publicUrl: 'https://tech.example', language: 'en', targetCountry: 'United States', timezone: 'UTC' });
  siteId = site.id;
  catId = (await client.category.create({ data: { websiteId: siteId, externalId: 3, name: 'Tech & Apps' } })).id;
});

describe('HUMANIZE stage', () => {
  let taskId: string;

  it('keeps fact-changing rewrites out, applies faithful ones, and assembles the result', async () => {
    const driver = makeDriver(client, (stage, prompt, lang, kw) => (stage === 'HUMANIZE' ? editorAnswer(prompt) : cannedAnswer(stage, prompt, lang, kw)));
    const { task } = await tigram('hz:stage-1');
    taskId = task.id;
    const t = await driver.drive(task.id);
    const data = await stageData(t.id);
    expect(data.batches).toBeGreaterThanOrEqual(2);
    const byStatus = (s: string) => data.paragraphs.filter((p: { status: string }) => p.status === s);
    expect(byStatus('rewritten').length).toBeGreaterThanOrEqual(1);
    const rejected = byStatus('kept').find((p: { original: string }) => p.original.includes('point 3 often'));
    expect(rejected.reasons.join(' ')).toMatch(/Numbers changed/);
    expect(rejected.edited).toContain('point 4 often');
    expect(t.assembledHtml).toContain('For installation, point 1 often decides');
    // Every rejected rewrite stays out; its original paragraph stays in.
    for (const p of byStatus('kept') as { original: string; edited: string | null }[]) {
      expect(t.assembledHtml).toContain(p.original);
      if (p.edited) expect(t.assembledHtml).not.toContain(p.edited);
    }
    expect(data.summary.before.fillerPhrases).toBeGreaterThan(data.summary.after.fillerPhrases);
    expect((await hz(t.id)).length).toBe(data.batches);
  });

  it('regeneration starts again from the unedited text, never from the humanized output', async () => {
    const before = (await hz(taskId)).filter((r) => r.operationId.includes(':b1:'));
    await actions.regenerateStage(taskId, 'HUMANIZE');
    const driver = makeDriver(client, (stage, prompt, lang, kw) => (stage === 'HUMANIZE' ? editorAnswer(prompt) : cannedAnswer(stage, prompt, lang, kw)));
    await driver.drive(taskId);
    const b1 = (await hz(taskId)).filter((r) => r.operationId.includes(':b1:'));
    expect(b1).toHaveLength(2);
    expect(b1[1].renderedPrompt).toBe(before[0].renderedPrompt);
    expect(b1[1].renderedPrompt).toContain('When it comes to installation, point 1');
    expect(b1[0].status).toBe('SUPERSEDED');
  });

  it('a failed batch is retried alone; the accepted batch is never re-sent or overwritten', async () => {
    let failed = false;
    const answer = (stage: string, prompt: string, lang: 'en' | 'de', kw: string): ScriptedAnswer => {
      if (stage !== 'HUMANIZE') return cannedAnswer(stage, prompt, lang, kw);
      if (!prompt.includes('[P1]') && !failed) {
        failed = true;
        return { fail: 'network error' };
      }
      return editorAnswer(prompt);
    };
    const { task } = await tigram('hz:stage-retry', 'How to Back Up WordPress');
    const t = await makeDriver(client, answer).drive(task.id);
    expect(failed).toBe(true);
    const responses = await hz(t.id);
    expect(responses.filter((r) => r.operationId.includes(':b1:'))).toHaveLength(1);
    const b2 = responses.filter((r) => r.operationId.includes(':b2:'));
    expect(b2.map((r) => r.status)).toEqual(['FAILED', 'COMPLETED']);
    expect((await client.articleStage.findFirstOrThrow({ where: { taskId: t.id, key: 'HUMANIZE' } })).attempts).toBe(2);
    expect(t.assembledHtml).toContain('For installation, point 1 often decides');
  });

  it('flagged-only mode sends just the paragraphs the local editor flagged; off skips the stage', async () => {
    const { updateSettings } = await import('@/lib/settings');
    await updateSettings({ content: { humanizerScope: 'flagged', humanizerBatchWords: 1200 } });
    const sent: string[] = [];
    const answer = (stage: string, prompt: string, lang: 'en' | 'de', kw: string) => {
      if (stage === 'HUMANIZE') sent.push(...promptParagraphs(prompt).map(([, text]) => text));
      return stage === 'HUMANIZE' ? editorAnswer(prompt) : cannedAnswer(stage, prompt, lang, kw);
    };
    const t = await makeDriver(client, answer).drive((await tigram('hz:flagged', 'How to Speed Up WordPress')).task.id);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.every((p) => /When it comes to/.test(p))).toBe(true);
    const data = await stageData(t.id);
    // Nothing unflagged was sent.
    expect(data.paragraphs.filter((p: { status: string; flags: string[] }) => p.flags.length === 0 && p.status !== 'skipped')).toEqual([]);
    await updateSettings({ content: { humanizerScope: 'all', humanizerEnabled: false } });
    const off = await makeDriver(client).drive((await tigram('hz:stage-off', 'How to Secure WordPress')).task.id);
    expect((await client.articleStage.findFirstOrThrow({ where: { taskId: off.id, key: 'HUMANIZE' } })).status).toBe('SKIPPED');
    expect((await hz(off.id)).length).toBe(0);
    await updateSettings({ content: { humanizerEnabled: true, humanizerBatchWords: 300 } });
  });
});

describe('Humanizer page runs', () => {
  const tick = () => worker.humanizerTick('test-worker', () => false);
  const finish = async (runId: string, answer: (stage: string, prompt: string, lang: 'en' | 'de', kw: string) => ScriptedAnswer = (s, p) => editorAnswer(p)) => {
    const driver = makeDriver(client, answer);
    for (let i = 0; i < 10; i++) {
      await tick();
      const run = await client.humanizerRun.findUniqueOrThrow({ where: { id: runId } });
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) return run;
      await driver.respond();
    }
    throw new Error('run did not finish');
  };

  it('pasted text runs through the same bridge (prompt owned by the run, not a task) with fact locks', async () => {
    const text = 'When it comes to installation, point 1 often decides whether users are happy. Check the official information and compare it with your own needs before you decide.\n\nWhen it comes to pricing, point 3 often decides whether users are happy. Check the official information and compare it with your own needs before you decide.\n\nShort.';
    const run = await runs.createHumanizerRun({ source: 'PASTE', html: text, title: 'My notes', language: 'en', scope: 'all' });
    await tick();
    const pending = await client.chatGPTResponse.findMany({ where: { runId: run.id } });
    expect(pending).toHaveLength(1);
    expect(pending[0].taskId).toBeNull();
    const job = await client.queueJob.findFirstOrThrow({ where: { queue: 'chatgpt', relatedId: pending[0].id } });
    expect(job.taskId).toBeNull();
    const done = await finish(run.id);
    expect(done.status).toBe('COMPLETED');
    const result = JSON.parse(done.result);
    expect(result.paragraphs.map((p: { status: string }) => p.status)).toEqual(['rewritten', 'kept', 'skipped']);
    expect(done.outputHtml).toContain('<p>For installation, point 1 often decides');
    expect(done.outputHtml).toContain('point 3 often decides');
    expect(done.outputHtml).toContain('<p>Short.</p>');
    await expect(runs.applyHumanizerRun(run.id)).rejects.toThrow(/Only runs started from a saved article/);
  });

  it('uses an edited prompt for this run only, and validates it', async () => {
    await expect(runs.createHumanizerRun({ source: 'PASTE', html: 'A paragraph that is long enough to be edited by the humanizer in this test run today.', language: 'en', promptOverride: 'Just edit it.' })).rejects.toThrow(/must contain \{\{paragraphs\}\}/);
    await expect(runs.createHumanizerRun({ source: 'PASTE', html: 'x', language: 'en' })).rejects.toThrow(/No paragraph is long enough/);
    await expect(runs.createHumanizerRun({ source: 'PASTE', html: 'A calm and clear paragraph that already reads well and needs no editing at all today.', language: 'en', scope: 'flagged' })).rejects.toThrow(/No paragraph was flagged/);
    const run = await runs.createHumanizerRun({ source: 'PASTE', html: 'When it comes to installation, point 1 often decides whether users are happy with their new website today.', language: 'en', promptOverride: 'Edit gently, please.\n{{#if problems}}Issues: {{problems}}{{/if}}\n\n{{paragraphs}}' });
    await tick();
    const r = await client.chatGPTResponse.findFirstOrThrow({ where: { runId: run.id } });
    expect(r.renderedPrompt).toMatch(/^Edit gently, please\./);
    expect(r.renderedPrompt).toContain('Issues: [P1] empty phrase “when it comes to”');
    expect(r.renderedPrompt).toContain('Write in English for readers in the United States.');
    const saved = await client.promptTemplate.findFirstOrThrow({ where: { moduleKey: 'shared', stageKey: 'HUMANIZE' } });
    expect(saved.content).not.toContain('Edit gently');
    // Cancelling stops waiting prompts.
    await runs.cancelHumanizerRun(run.id);
    expect((await client.humanizerRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe('CANCELLED');
    expect((await client.queueJob.findFirstOrThrow({ where: { queue: 'chatgpt', relatedId: r.id } })).status).toBe('CANCELLED');
  });

  it('a saved article run is applied only on request, as an owner edit with history; WordPress is untouched; stale runs are refused', async () => {
    const { task } = await tigram('hz:page-article', 'Best Free VPN Apps');
    const t = await makeDriver(client, (stage, prompt, lang, kw) => (stage === 'HUMANIZE' ? promptParagraphs(prompt).map(([id, text]) => `[${id}]\n${text}`).join('\n\n') : cannedAnswer(stage, prompt, lang, kw))).drive(task.id);
    expect(t.assembledHtml).toContain('When it comes to installation, point 1');
    const run = await runs.createHumanizerRun({ source: 'ARTICLE', taskId: t.id, scope: 'all' });
    const done = await finish(run.id);
    expect(done.status).toBe('COMPLETED');
    const unchanged = await client.articleTask.findUniqueOrThrow({ where: { id: t.id } });
    expect(unchanged.editedHtml).toBeNull(); // nothing applied yet
    const applied = await runs.applyHumanizerRun(run.id);
    expect(applied.message).toMatch(/WordPress draft was not changed/);
    const after = await client.articleTask.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.editedHtml).toBe(done.outputHtml);
    expect(after.editedHtml).toContain('For installation, point 1 often decides');
    expect(after.wpPostId).toBe(unchanged.wpPostId);
    expect(await client.articleStageRevision.count({ where: { taskId: t.id, key: 'HUMANIZER' } })).toBe(1);
    await expect(runs.applyHumanizerRun(run.id)).rejects.toThrow(/already applied/);
    // A run on an older version cannot overwrite newer owner edits.
    const second = await runs.createHumanizerRun({ source: 'ARTICLE', taskId: t.id, scope: 'all' });
    await finish(second.id);
    await actions.saveEditedContent(t.id, { html: `${after.editedHtml}<p>My own new closing paragraph.</p>`, baseVersion: after.version });
    await expect(runs.applyHumanizerRun(second.id)).rejects.toThrow(/changed after this run started/);
    expect((await runs.getHumanizerRun(second.id)).articleChanged).toBe(true);
    expect((await runs.listHumanizerRuns({ taskId: t.id })).map((r) => r.id)).toEqual([second.id, run.id]);
  });
});
