import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { createTask, createWebsite } from '../helpers/fixtures';
import type { PipelineDefinition, PipelineStage } from '@/worker/pipeline/types';

let client: PrismaClient;
let engine: typeof import('@/worker/pipeline/engine');
let registry: typeof import('@/worker/pipeline/registry');
let queue: typeof import('@/lib/queue');
let lifecycle: typeof import('@/lib/tasks/lifecycle');
let chatgpt: typeof import('@/lib/chatgpt/jobs');
let recovery: typeof import('@/worker/recovery');
let errors: typeof import('@/lib/pipeline-errors');

const CONV = 'https://chatgpt.com/c/0123456789abcdef0123456789abcdef';
let flaky: 'ok' | 'transient-once' | 'always-transient' | 'fatal' = 'ok';
let flakyCalls = 0;
let localARuns = 0;

function fakePipeline(): PipelineDefinition {
  const stage = (s: Omit<PipelineStage, 'dependsOn' | 'description'> & { dependsOn?: string[] }): PipelineStage => ({ description: s.label, dependsOn: [], ...s }) as PipelineStage;
  const stages: PipelineStage[] = [
    stage({
      key: 'LOCAL_A',
      label: 'Local A',
      kind: 'local',
      runningStatus: 'OPTIMIZING',
      progress: 5,
      run: async (ctx) => {
        localARuns++;
        return { outcome: 'completed', output: `A:${ctx.task.keyword}` };
      },
    }),
    stage({
      key: 'ASK',
      label: 'Ask ChatGPT',
      kind: 'chatgpt',
      runningStatus: 'GENERATING_TITLES',
      progress: 20,
      prompt: { moduleKey: 'celebrity-writer', stageKey: 'TITLES' },
      dependsOn: ['LOCAL_A'],
      run: async (ctx) => {
        const res = await ctx.askChatGPT('TITLES');
        if (res.status === 'waiting') return { outcome: 'waiting', message: 'Waiting for ChatGPT' };
        return { outcome: 'completed', output: res.text, prompt: res.prompt };
      },
    }),
    stage({
      key: 'GATE',
      label: 'Approval',
      kind: 'gate',
      runningStatus: 'AWAITING_TITLE_APPROVAL',
      progress: 30,
      dependsOn: ['ASK'],
      run: async (ctx) =>
        ctx.task.titleApprovedAt ? { outcome: 'completed' } : { outcome: 'paused', status: 'AWAITING_TITLE_APPROVAL', message: 'Approve the title', nextAction: 'Approve' },
    }),
    stage({
      key: 'FLAKY',
      label: 'Flaky',
      kind: 'local',
      runningStatus: 'ASSEMBLING',
      progress: 60,
      dependsOn: ['GATE'],
      run: async () => {
        flakyCalls++;
        if (flaky === 'fatal') throw new errors.FatalError('bad config');
        if (flaky === 'always-transient' || (flaky === 'transient-once' && flakyCalls === 1)) throw new errors.TransientError('network blip');
        return { outcome: 'completed', output: 'flaky ok' };
      },
    }),
    stage({ key: 'LOCAL_Z', label: 'Local Z', kind: 'local', runningStatus: 'SEO_CHECKING', progress: 90, dependsOn: ['FLAKY'], run: async () => ({ outcome: 'completed', output: 'z' }) }),
  ];
  return {
    moduleKey: 'celebrity-writer',
    manifest: { key: 'celebrity-writer', name: 'Test', shortName: 'T', description: '', icon: 'x', group: 'writer', active: true, stages, exampleTitle: 'always', secondaryKeywordStages: [], highlights: [] },
    stages,
    regenerationPlan: (key) => [key],
    variables: (ctx) => ({ keyword: ctx.task.keyword, example_title: ctx.task.exampleTitle, country: ctx.task.targetCountry, language: ctx.task.language === 'de' ? 'German' : 'English' }),
    contextPrimer: async () => 'PRIMER: saved research',
    finalize: async (ctx) => {
      await ctx.updateTask({ status: 'COMPLETED', percent: 100, message: 'done' });
    },
  };
}

async function runNext(taskId: string) {
  await client.queueJob.updateMany({ where: { taskId, queue: 'article', status: 'WAITING' }, data: { runAt: new Date(0) } });
  const job = await queue.claimNext({ queue: 'article', owner: 'test-worker', leaseMs: 60_000 });
  if (!job) return 'no-job';
  return engine.runArticleJob(job, { workerId: 'test-worker', leaseMs: 60_000, random: () => 0.5 });
}

async function answerChatGPT(text = 'Option 1\nRecommended Title: Great Title') {
  const claim = await chatgpt.claimChatGPTJob({ installId: 'inst', tabId: 'tab1' });
  if (!('job' in claim)) throw new Error(`no chatgpt job: ${JSON.stringify(claim)}`);
  await chatgpt.completeChatGPTJob({ jobId: claim.job.id, tabId: 'tab1', text, conversationUrl: CONV });
  return claim;
}

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  const { updateSettings } = await import('@/lib/settings');
  await updateSettings({ workflow: { retryAttempts: 2, retryBaseDelaySec: 1 } });
  engine = await import('@/worker/pipeline/engine');
  registry = await import('@/worker/pipeline/registry');
  queue = await import('@/lib/queue');
  lifecycle = await import('@/lib/tasks/lifecycle');
  chatgpt = await import('@/lib/chatgpt/jobs');
  recovery = await import('@/worker/recovery');
  errors = await import('@/lib/pipeline-errors');
  registry.registerPipeline(fakePipeline());
});

beforeEach(async () => {
  flaky = 'ok';
  flakyCalls = 0;
  localARuns = 0;
  await client.queueJob.updateMany({ where: { status: { in: ['WAITING', 'ACTIVE'] } }, data: { status: 'CANCELLED' } });
});

describe('stage engine', () => {
  it('runs stages in order, waits for ChatGPT without holding a lease, pauses at a gate and finishes after approval', async () => {
    const site = await createWebsite(client);
    const task = await createTask(client, site.id, { keyword: 'Tom Kaulitz Heidi Klum', exampleTitle: 'Example title' });
    expect(await lifecycle.ensureArticleRun(task.id, 'test')).toBe('enqueued');

    expect(await runNext(task.id)).toBe('waiting');
    let t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('GENERATING_TITLES');
    const articleJob = await client.queueJob.findFirstOrThrow({ where: { taskId: task.id, queue: 'article' } });
    expect(articleJob.status).toBe('WAITING');
    expect(articleJob.attempts).toBe(0);
    const pending = await client.chatGPTResponse.findMany({ where: { taskId: task.id } });
    expect(pending).toHaveLength(1);
    expect(pending[0].renderedPrompt).toContain('Tom Kaulitz Heidi Klum');
    expect(pending[0].renderedPrompt).toContain('Reference title for direction only: "Example title"');
    expect(pending[0].renderedPrompt.endsWith('Write in English for readers in the United States.')).toBe(true);

    // Re-running before the answer arrives must not create a second prompt.
    expect(await runNext(task.id)).toBe('waiting');
    expect(await client.chatGPTResponse.count({ where: { taskId: task.id } })).toBe(1);
    expect(await client.queueJob.count({ where: { taskId: task.id, queue: 'chatgpt' } })).toBe(1);

    await answerChatGPT();
    const woken = await client.queueJob.findFirstOrThrow({ where: { taskId: task.id, queue: 'article', status: 'WAITING' } });
    expect(woken.runAt.getTime()).toBeLessThanOrEqual(Date.now());

    expect(await runNext(task.id)).toBe('paused');
    t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('AWAITING_TITLE_APPROVAL');
    expect(t.conversationUrl).toBe(CONV);
    expect(await client.queueJob.count({ where: { taskId: task.id, queue: 'article', status: { in: ['WAITING', 'ACTIVE'] } } })).toBe(0);

    await client.articleTask.update({ where: { id: task.id }, data: { titleApprovedAt: new Date() } });
    await lifecycle.ensureArticleRun(task.id, 'approved');
    expect(await runNext(task.id)).toBe('completed');
    t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('COMPLETED');
    expect(localARuns).toBe(1);
    const stages = await client.articleStage.findMany({ where: { taskId: task.id }, orderBy: { position: 'asc' } });
    expect(stages.map((s) => s.status)).toEqual(['COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED', 'COMPLETED']);
    expect(stages[1].output).toContain('Recommended Title: Great Title');
    const metrics = await client.productionMetric.count({ where: { taskId: task.id, kind: 'STAGE' } });
    expect(metrics).toBe(5);
  });

  it('retries transient errors with backoff and keeps completed stages', async () => {
    flaky = 'transient-once';
    const site = await createWebsite(client);
    const task = await createTask(client, site.id);
    await client.articleTask.update({ where: { id: task.id }, data: { titleApprovedAt: new Date() } });
    await lifecycle.ensureArticleRun(task.id, 'test');
    expect(await runNext(task.id)).toBe('waiting');
    await answerChatGPT();
    expect(await runNext(task.id)).toBe('retry');
    let t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.message).toMatch(/Retry 1\/2/);
    const job = await client.queueJob.findFirstOrThrow({ where: { taskId: task.id, queue: 'article', status: 'WAITING' } });
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(await runNext(task.id)).toBe('completed');
    t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('COMPLETED');
    expect(localARuns).toBe(1);
    expect(await client.chatGPTResponse.count({ where: { taskId: task.id } })).toBe(1);
  });

  it('fails after the retry budget; manual retry resumes from the failed stage only', async () => {
    flaky = 'always-transient';
    const site = await createWebsite(client);
    const task = await createTask(client, site.id);
    await client.articleTask.update({ where: { id: task.id }, data: { titleApprovedAt: new Date() } });
    await lifecycle.ensureArticleRun(task.id, 'test');
    await runNext(task.id);
    await answerChatGPT();
    expect(await runNext(task.id)).toBe('retry');
    expect(await runNext(task.id)).toBe('retry');
    expect(await runNext(task.id)).toBe('failed');
    let t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('FAILED');
    expect(t.message).toMatch(/after 3 attempt/);
    flaky = 'ok';
    await lifecycle.retryTask(task.id);
    expect(await runNext(task.id)).toBe('completed');
    t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('COMPLETED');
    expect(localARuns).toBe(1);
    expect(await client.chatGPTResponse.count({ where: { taskId: task.id } })).toBe(1);
  });

  it('does not retry fatal errors', async () => {
    flaky = 'fatal';
    const site = await createWebsite(client);
    const task = await createTask(client, site.id);
    await client.articleTask.update({ where: { id: task.id }, data: { titleApprovedAt: new Date() } });
    await lifecycle.ensureArticleRun(task.id, 'test');
    await runNext(task.id);
    await answerChatGPT();
    expect(await runNext(task.id)).toBe('failed');
    expect(flakyCalls).toBe(1);
    const t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('FAILED');
  });

  it('cancels cooperatively and keeps completed outputs', async () => {
    const site = await createWebsite(client);
    const task = await createTask(client, site.id);
    await lifecycle.ensureArticleRun(task.id, 'test');
    expect(await runNext(task.id)).toBe('waiting');
    const res = await lifecycle.requestCancel(task.id);
    expect(res.status).toBe('CANCELLED');
    const t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('CANCELLED');
    const a = await client.articleStage.findFirstOrThrow({ where: { taskId: task.id, key: 'LOCAL_A' } });
    expect(a.output).toBe(`A:${task.keyword}`);
    expect(await client.queueJob.count({ where: { taskId: task.id, status: 'WAITING' } })).toBe(0);
    const claim = await chatgpt.claimChatGPTJob({ installId: 'inst', tabId: 'tab9' });
    expect('job' in claim && claim.job.taskId === task.id).toBe(false);
  });

  it('ensureArticleRun is safe under concurrent double-submits', async () => {
    const site = await createWebsite(client);
    const task = await createTask(client, site.id);
    const results = await Promise.all(Array.from({ length: 6 }, () => lifecycle.ensureArticleRun(task.id, 'double')));
    expect(results.filter((r) => r === 'enqueued')).toHaveLength(1);
    expect(await client.queueJob.count({ where: { taskId: task.id, queue: 'article', status: { in: ['WAITING', 'ACTIVE'] } } })).toBe(1);
  });

  it('recovers after a worker crash without duplicating the sent prompt', async () => {
    const site = await createWebsite(client);
    const task = await createTask(client, site.id);
    await lifecycle.ensureArticleRun(task.id, 'test');
    expect(await runNext(task.id)).toBe('waiting');
    // Simulate: extension claimed and SENT the prompt, then the whole app crashed.
    const claim = await chatgpt.claimChatGPTJob({ installId: 'inst', tabId: 'tabX' });
    if (!('job' in claim)) throw new Error('expected claim');
    await chatgpt.reportChatGPTProgress({ jobId: claim.job.id, tabId: 'tabX', progress: { step: 'sent', sent: true, sentAt: new Date().toISOString(), conversationUrl: CONV } });
    // Article job was mid-run under the old worker when it died.
    const art = await client.queueJob.findFirstOrThrow({ where: { taskId: task.id, queue: 'article' } });
    await client.queueJob.update({ where: { id: art.id }, data: { status: 'ACTIVE', lockedBy: 'dead-worker', leaseUntil: new Date(Date.now() - 1000), attempts: 1 } });
    await client.queueJob.update({ where: { id: claim.job.id }, data: { leaseUntil: new Date(Date.now() - 1000) } });

    const r = await recovery.recoverOnStartup('new-worker');
    expect(r.article).toBeGreaterThanOrEqual(1);
    expect(r.chatgpt).toBe(1);
    const incident = await client.recoveryIncident.findFirst({ where: { taskId: task.id, kind: 'UNCERTAIN_PROMPT' } });
    expect(incident).not.toBeNull();
    // Next claim must carry reconcile info so the extension checks the conversation first.
    const reclaim = await chatgpt.claimChatGPTJob({ installId: 'inst', tabId: 'tabY' });
    if (!('job' in reclaim)) throw new Error('expected reclaim');
    expect(reclaim.job.id).toBe(claim.job.id);
    expect(reclaim.reconcile).toEqual(expect.objectContaining({ conversationUrl: CONV }));
    await chatgpt.completeChatGPTJob({ jobId: reclaim.job.id, tabId: 'tabY', text: 'Recommended Title: Recovered', conversationUrl: CONV, recovered: true });
    expect(await runNext(task.id)).toBe('paused');
    expect(await client.chatGPTResponse.count({ where: { taskId: task.id } })).toBe(1);
    const resp = await client.chatGPTResponse.findFirstOrThrow({ where: { taskId: task.id } });
    expect(resp.recovered).toBe(true);
  });

  it('opens a new chat with a context primer when the conversation is lost', async () => {
    const site = await createWebsite(client);
    const task = await createTask(client, site.id);
    await lifecycle.ensureArticleRun(task.id, 'test');
    await runNext(task.id);
    const claim = await chatgpt.claimChatGPTJob({ installId: 'inst', tabId: 'tabL' });
    if (!('job' in claim)) throw new Error('expected claim');
    await chatgpt.failChatGPTJob({ jobId: claim.job.id, tabId: 'tabL', code: 'CONVERSATION_LOST', message: 'conversation 404' });
    expect(await runNext(task.id)).toBe('waiting');
    const responses = await client.chatGPTResponse.findMany({ where: { taskId: task.id }, orderBy: { createdAt: 'asc' } });
    expect(responses).toHaveLength(2);
    expect(responses[1].conversationSwitch).toBe(true);
    expect(responses[1].renderedPrompt.startsWith('PRIMER: saved research')).toBe(true);
    const job = await client.queueJob.findFirstOrThrow({ where: { relatedId: responses[1].id } });
    expect(JSON.parse(job.payload).newChat).toBe(true);
  });

  it('login and usage-limit failures pause the task instead of failing it', async () => {
    const site = await createWebsite(client);
    const task = await createTask(client, site.id);
    await lifecycle.ensureArticleRun(task.id, 'test');
    await runNext(task.id);
    let claim = await chatgpt.claimChatGPTJob({ installId: 'inst', tabId: 'tabP' });
    if (!('job' in claim)) throw new Error('expected claim');
    await chatgpt.failChatGPTJob({ jobId: claim.job.id, tabId: 'tabP', code: 'LOGIN', message: 'login page shown' });
    let t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('LOGIN_REQUIRED');
    expect(t.pausedFor).toBe('chatgpt-login');
    expect(t.nextAction).toMatch(/sign in/i);
    await client.queueJob.updateMany({ where: { id: claim.job.id }, data: { runAt: new Date(0) } });
    claim = await chatgpt.claimChatGPTJob({ installId: 'inst', tabId: 'tabP' });
    if (!('job' in claim)) throw new Error('expected claim');
    await chatgpt.failChatGPTJob({ jobId: claim.job.id, tabId: 'tabP', code: 'USAGE_LIMIT', message: 'Too many requests', retryAfterSec: 120 });
    t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('PAUSED');
    expect(t.pausedFor).toBe('usage-limit');
    const refused = await chatgpt.claimChatGPTJob({ installId: 'inst', tabId: 'tabQ' });
    expect(refused).toEqual(expect.objectContaining({ reason: 'backoff' }));
    const { getRateState } = await import('@/lib/chatgpt/rate');
    const rate = await getRateState();
    expect(rate.concurrency).toBe(1);
    expect(new Date(rate.backoffUntil!).getTime()).toBeGreaterThanOrEqual(Date.now() + 119_000);
    await client.setting.delete({ where: { key: 'chatgpt.rate' } });
  });

  it('refuses unresolved required placeholders before anything is sent', async () => {
    const site = await createWebsite(client);
    const task = await createTask(client, site.id);
    const pr = await client.promptTemplate.findUniqueOrThrow({ where: { moduleKey_stageKey: { moduleKey: 'celebrity-writer', stageKey: 'TITLES' } } });
    await client.promptTemplate.update({ where: { id: pr.id }, data: { content: pr.content + '\nNeeds: {{nonexistent_required}}' } });
    // An undocumented variable is treated as required.
    await lifecycle.ensureArticleRun(task.id, 'test');
    expect(await runNext(task.id)).toBe('failed');
    const t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.message).toMatch(/unresolved required placeholders: nonexistent_required/);
    expect(await client.chatGPTResponse.count({ where: { taskId: task.id } })).toBe(0);
    await client.promptTemplate.update({ where: { id: pr.id }, data: { content: pr.content } });
  });

  it('marks retired-writer tasks for review instead of executing them', async () => {
    const site = await createWebsite(client);
    const task = await createTask(client, site.id, { moduleKey: 'celebrity-writer-2' });
    await lifecycle.ensureArticleRun(task.id, 'test');
    expect(await runNext(task.id)).toBe('review');
    const t = await client.articleTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(t.status).toBe('NEEDS_REVIEW');
    expect(t.message).toMatch(/Retired writer/);
  });
});

describe('dispatcher', () => {
  it('starts no more new tasks than the article slots and is fair across sites', async () => {
    const { updateSettings } = await import('@/lib/settings');
    await updateSettings({ workflow: { taskConcurrency: 2, highThroughputMode: true } });
    await client.articleTask.updateMany({ where: { status: { notIn: ['COMPLETED', 'CANCELLED', 'FAILED'] } }, data: { status: 'CANCELLED' } });
    const s1 = await createWebsite(client);
    const s2 = await createWebsite(client);
    const tasks = [await createTask(client, s1.id), await createTask(client, s1.id), await createTask(client, s1.id), await createTask(client, s2.id)];
    for (const t of tasks) await lifecycle.ensureArticleRun(t.id, 'test');
    const { ArticleDispatcher } = await import('@/worker/dispatcher');
    const d = new ArticleDispatcher('disp-worker');
    await d.tick(() => false);
    await d.drain(10_000);
    await d.tick(() => false);
    await d.drain(10_000);
    const started = await client.articleTask.findMany({ where: { id: { in: tasks.map((t) => t.id) }, status: { not: 'QUEUED' } } });
    expect(started).toHaveLength(2);
    expect(new Set(started.map((t) => t.websiteId)).size).toBe(2);
    await updateSettings({ workflow: { taskConcurrency: 3 } });
  });
});
