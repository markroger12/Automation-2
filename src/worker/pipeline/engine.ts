import type { ArticleStage, ArticleTask, QueueJob, Website } from '@prisma/client';
import { db } from '@/lib/db';
import { log, errorMessage } from '@/lib/log';
import { parseJson } from '@/lib/json';
import { isActiveModuleKey, type TaskStatus } from '@/lib/domain';
import { completeJob, failJob, heartbeatJob, releaseJob } from '@/lib/queue';
import { exponentialBackoffMs } from '@/lib/backoff';
import { getSettings, parseSiteOverrides } from '@/lib/settings';
import { effectiveTaskConfig, taskOptionsSchema, type EffectiveTaskConfig } from '@/lib/settings-schema';
import {
  CancelledError,
  FatalError,
  HumanCheckError,
  LoginRequiredError,
  NeedsReviewError,
  UncertainSideEffectError,
  UsageLimitError,
  isPipelineError,
} from '@/lib/pipeline-errors';
import { recordMetric } from '@/lib/metrics';
import { openIncident } from '@/lib/recovery';
import { getPipeline } from './registry';
import { createContext } from './context';
import type { PipelineDefinition, PipelineStage, StageResult } from './types';

export type RunOutcome = 'completed' | 'waiting' | 'paused' | 'failed' | 'cancelled' | 'retry' | 'lost' | 'review';

export interface EngineOptions {
  workerId: string;
  leaseMs: number;
  /** Fallback wake-up for jobs waiting on ChatGPT if no completion wakes them. */
  waitPollMs?: number;
  random?: () => number;
}

const DONE = new Set(['COMPLETED', 'SKIPPED']);

export async function computeConfig(task: ArticleTask & { website: Website }): Promise<EffectiveTaskConfig> {
  const settings = await getSettings();
  const options = taskOptionsSchema.safeParse(parseJson<unknown>(task.options, {}));
  return effectiveTaskConfig(settings, parseSiteOverrides(task.website.settingsOverrides), options.success ? options.data : taskOptionsSchema.parse({}));
}

export async function ensureStageRows(taskId: string, def: PipelineDefinition): Promise<Map<string, ArticleStage>> {
  const existing = await db.articleStage.findMany({ where: { taskId } });
  const byKey = new Map(existing.map((s) => [s.key, s]));
  let position = 0;
  for (const stage of def.stages) {
    position++;
    if (!byKey.has(stage.key)) {
      const row = await db.articleStage.upsert({
        where: { taskId_key: { taskId, key: stage.key } },
        create: { taskId, key: stage.key, position, label: stage.label, kind: stage.kind },
        update: {},
      });
      byKey.set(stage.key, row);
    }
  }
  return byKey;
}

function inputSnapshot(task: ArticleTask, stage: PipelineStage, rows: Map<string, ArticleStage>, config: EffectiveTaskConfig): string {
  return JSON.stringify({
    keyword: task.keyword,
    secondaryKeywords: parseJson<string[]>(task.secondaryKeywords, []),
    exampleTitle: task.exampleTitle,
    language: task.language,
    country: task.targetCountry,
    websiteId: task.websiteId,
    categoryName: task.categoryName,
    selectedTitle: task.selectedTitle,
    dependsOn: Object.fromEntries(stage.dependsOn.map((k) => [k, rows.get(k)?.updatedAt?.toISOString() ?? null])),
    config: { maxWords: config.maxWords, faqCount: config.faqCount, quickBioRows: config.quickBioRows, images: config.images },
  });
}

/** Run (or resume) one article job. Never throws; returns what happened. */
export async function runArticleJob(job: QueueJob, options: EngineOptions): Promise<RunOutcome> {
  const owner = options.workerId;
  const taskId = job.taskId;
  if (!taskId) {
    await completeJob(job.id, owner, { error: 'job without task' });
    return 'completed';
  }
  const task = await db.articleTask.findUnique({ where: { id: taskId }, include: { website: true } });
  if (!task) {
    await completeJob(job.id, owner, { orphan: true });
    return 'completed';
  }
  if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
    await completeJob(job.id, owner, { noop: task.status });
    return 'completed';
  }
  const def = getPipeline(task.moduleKey);
  if (task.legacy || !isActiveModuleKey(task.moduleKey) || !def) {
    await db.articleTask.update({
      where: { id: taskId },
      data: {
        status: 'NEEDS_REVIEW',
        legacy: true,
        message: task.legacy || task.moduleKey === 'celebrity-writer-2' ? 'Retired writer — choose a supported writer to create a new task.' : `Writer module "${task.moduleKey}" is not available.`,
        nextAction: 'Create a new task with Celebrity Article Writer or Tigram Article Writer.',
        reviewReasons: JSON.stringify(['Retired or unknown writer module; this task is read-only.']),
      },
    });
    await completeJob(job.id, owner, { retired: true });
    return 'review';
  }
  if (task.cancelRequested) {
    await markCancelled(task.id);
    await completeJob(job.id, owner, { cancelled: true });
    return 'cancelled';
  }

  const controller = new AbortController();
  const hbEvery = Math.max(1000, Math.floor(options.leaseMs / 3));
  const hb = setInterval(() => {
    heartbeatJob(job.id, owner, options.leaseMs)
      .then((ok) => {
        if (!ok) controller.abort();
      })
      .catch(() => {});
  }, hbEvery);

  let current: { stage: PipelineStage; row: ArticleStage } | null = null;
  try {
    let config: EffectiveTaskConfig;
    let fresh = await db.articleTask.findUniqueOrThrow({ where: { id: taskId }, include: { website: true } });
    if (!fresh.startedAt || fresh.configSnapshot === '{}') {
      config = await computeConfig(fresh);
      await db.articleTask.update({ where: { id: taskId }, data: { configSnapshot: JSON.stringify(config), startedAt: fresh.startedAt ?? new Date() } });
    } else {
      config = { ...(await computeConfig(fresh)), ...parseJson<Partial<EffectiveTaskConfig>>(fresh.configSnapshot, {}) };
    }
    const rows = await ensureStageRows(taskId, def);

    for (const stage of def.stages) {
      let row = rows.get(stage.key)!;
      if (DONE.has(row.status)) continue;
      if (controller.signal.aborted) return 'lost';
      const latest = await db.articleTask.findUniqueOrThrow({ where: { id: taskId }, include: { website: true } });
      if (latest.cancelRequested) throw new CancelledError();

      const startingFresh = row.status === 'PENDING' || row.status === 'FAILED';
      row = await db.articleStage.update({
        where: { id: row.id },
        data: {
          status: 'RUNNING',
          startedAt: startingFresh ? new Date() : (row.startedAt ?? new Date()),
          attempts: startingFresh ? row.attempts + 1 : row.attempts,
          error: null,
          inputSnapshot: row.inputSnapshot && !startingFresh ? row.inputSnapshot : inputSnapshot(latest, stage, rows, config),
        },
      });
      rows.set(stage.key, row);
      fresh = await db.articleTask.update({
        where: { id: taskId },
        data: {
          status: stage.runningStatus,
          stage: stage.key,
          percent: Math.max(latest.percent, stage.progress),
          message: row.message && !startingFresh ? row.message : `${stage.label}…`,
          pausedFor: null,
          nextAction: null,
        },
        include: { website: true },
      });
      current = { stage, row };
      const ctx = createContext({ definition: def, stage, row, task: fresh, website: fresh.website, config, stages: rows, workerId: owner, signal: controller.signal });

      if (stage.shouldRun && !(await stage.shouldRun(ctx))) {
        row = await db.articleStage.update({ where: { id: row.id }, data: { status: 'SKIPPED', completedAt: new Date(), durationMs: 0, message: 'Skipped (not applicable for this task/settings).' } });
        rows.set(stage.key, row);
        await recordStageMetric(fresh, stage, row, 'SKIPPED');
        continue;
      }

      const result: StageResult = await stage.run(ctx);
      if (controller.signal.aborted) return 'lost';
      row = await db.articleStage.findUniqueOrThrow({ where: { id: row.id } });

      if (result.outcome === 'completed' || result.outcome === 'skipped') {
        const completedAt = new Date();
        row = await db.articleStage.update({
          where: { id: row.id },
          data:
            result.outcome === 'completed'
              ? {
                  status: 'COMPLETED',
                  completedAt,
                  durationMs: completedAt.getTime() - (row.startedAt ?? completedAt).getTime(),
                  ...(result.prompt !== undefined ? { prompt: result.prompt } : {}),
                  ...(result.output !== undefined ? { output: result.output } : {}),
                  ...(result.outputHtml !== undefined ? { outputHtml: result.outputHtml } : {}),
                  ...(result.data !== undefined ? { outputJson: JSON.stringify(result.data) } : {}),
                  message: result.message ?? 'Completed',
                }
              : { status: 'SKIPPED', completedAt, durationMs: 0, message: result.reason },
        });
        rows.set(stage.key, row);
        await recordStageMetric(ctx.task, stage, row, result.outcome === 'completed' ? 'COMPLETED' : 'SKIPPED');
        continue;
      }
      if (result.outcome === 'waiting') {
        await db.articleStage.update({ where: { id: row.id }, data: { status: 'WAITING', message: result.message } });
        await db.articleTask.update({ where: { id: taskId }, data: { message: result.message } });
        await releaseJob(job.id, owner, { runAt: result.wakeAt ?? new Date(Date.now() + (options.waitPollMs ?? 10 * 60_000)), countAttempt: false });
        return 'waiting';
      }
      // paused (durable gate / human action)
      await db.articleStage.update({ where: { id: row.id }, data: { status: 'WAITING', message: result.message } });
      await db.articleTask.update({ where: { id: taskId }, data: { status: result.status, message: result.message, nextAction: result.nextAction ?? null } });
      await completeJob(job.id, owner, { paused: result.status });
      await log({ category: 'pipeline', taskId, stage: stage.key, message: `Paused: ${result.message}` });
      return 'paused';
    }

    // All stages done: finalize decides COMPLETED / NEEDS_REVIEW / DRAFT_CREATED.
    const finalTask = await db.articleTask.findUniqueOrThrow({ where: { id: taskId }, include: { website: true } });
    const lastStage = def.stages[def.stages.length - 1];
    const ctx = createContext({ definition: def, stage: lastStage, row: rows.get(lastStage.key)!, task: finalTask, website: finalTask.website, config, stages: rows, workerId: owner, signal: controller.signal });
    await def.finalize(ctx);
    await db.articleTask.update({ where: { id: taskId }, data: { completedAt: new Date() } });
    await completeJob(job.id, owner, { finished: true });
    return 'completed';
  } catch (error) {
    if (controller.signal.aborted) return 'lost';
    return handleError(error, job, taskId, current, options);
  } finally {
    clearInterval(hb);
  }
}

async function recordStageMetric(task: ArticleTask, stage: PipelineStage, row: ArticleStage, outcome: string) {
  const end = row.completedAt ?? new Date();
  const start = row.startedAt ?? end;
  await recordMetric({
    kind: 'STAGE',
    taskId: task.id,
    stageKey: stage.key,
    moduleKey: task.moduleKey,
    websiteId: task.websiteId,
    attempt: row.attempts,
    outcome,
    startedAt: start,
    endedAt: end,
    details: { kind: stage.kind },
    dedupeKey: `stage:${task.id}:${stage.key}:a${row.attempts}:${outcome}`,
  });
}

export async function markCancelled(taskId: string) {
  await db.articleStage.updateMany({ where: { taskId, status: { in: ['RUNNING', 'WAITING'] } }, data: { status: 'PENDING', message: 'Cancelled' } });
  await db.articleTask.update({ where: { id: taskId }, data: { status: 'CANCELLED', message: 'Cancelled by the owner. Completed content is preserved.', pausedFor: null } });
  await db.queueJob.updateMany({ where: { taskId, status: 'WAITING' }, data: { status: 'CANCELLED', finishedAt: new Date(), errorCode: 'CANCELLED' } });
  await log({ category: 'task', taskId, message: 'Task cancelled; completed stage outputs were kept.' });
  // Deleted by the owner while it was running: removed now that it stopped.
  const { deleteIfRequested } = await import('@/lib/tasks/delete');
  await deleteIfRequested(taskId);
}

async function handleError(
  error: unknown,
  job: QueueJob,
  taskId: string,
  current: { stage: PipelineStage; row: ArticleStage } | null,
  options: EngineOptions,
): Promise<RunOutcome> {
  const owner = options.workerId;
  const message = errorMessage(error);
  const stageKey = current?.stage.key ?? null;
  const stageUpdate = async (data: Record<string, unknown>) => {
    if (current) await db.articleStage.update({ where: { id: current.row.id }, data });
  };
  const pause = async (status: TaskStatus, pausedFor: string | null, msg: string, nextAction: string) => {
    await stageUpdate({ status: 'WAITING', message: msg });
    await db.articleTask.update({ where: { id: taskId }, data: { status, pausedFor, message: msg, nextAction } });
    await completeJob(job.id, owner, { paused: status });
    await log({ level: 'warn', category: 'pipeline', taskId, stage: stageKey, message: `${status}: ${msg}` });
  };

  if (error instanceof CancelledError) {
    await markCancelled(taskId);
    await completeJob(job.id, owner, { cancelled: true });
    return 'cancelled';
  }
  if (error instanceof LoginRequiredError) {
    await pause(
      'LOGIN_REQUIRED',
      error.scope === 'wordpress' ? 'wordpress-login' : 'chatgpt-login',
      error.message,
      error.scope === 'wordpress' ? 'Open Websites → this site → Log in, sign in manually, then the task resumes.' : 'Sign in to ChatGPT in the Automation Chrome window; the task resumes automatically.',
    );
    return 'paused';
  }
  if (error instanceof HumanCheckError) {
    await pause('PAUSED', 'chatgpt-human-check', error.message, 'Complete the human verification yourself in the visible browser window.');
    return 'paused';
  }
  if (error instanceof UsageLimitError) {
    await stageUpdate({ status: 'WAITING', message: error.message });
    await db.articleTask.update({ where: { id: taskId }, data: { status: 'PAUSED', pausedFor: 'usage-limit', message: error.message, nextAction: `Resumes automatically after ${error.retryAt.toLocaleTimeString()}, or press Resume to try ChatGPT now.` } });
    await releaseJob(job.id, owner, { runAt: error.retryAt, countAttempt: false });
    return 'waiting';
  }
  if (error instanceof UncertainSideEffectError) {
    await stageUpdate({ status: 'FAILED', error: message });
    await db.articleTask.update({
      where: { id: taskId },
      data: { status: 'NEEDS_REVIEW', message, nextAction: 'Open Recovery Center: confirm whether the action happened, then resume or retry.', reviewReasons: JSON.stringify([message]) },
    });
    await openIncident({ kind: stageKey === 'WORDPRESS_DRAFT' ? 'UNCERTAIN_WP_CREATE' : 'UNCERTAIN_PROMPT', severity: 'critical', jobId: job.id, taskId, stageKey, description: message, evidence: error.evidence, dedupeKey: `uncertain:${taskId}:${stageKey}:${current?.row.attempts ?? 0}` });
    await completeJob(job.id, owner, { uncertain: true });
    return 'review';
  }
  if (error instanceof NeedsReviewError) {
    await stageUpdate({ status: 'FAILED', error: message });
    const existing = await db.articleTask.findUnique({ where: { id: taskId }, select: { reviewReasons: true } });
    const reasons = Array.from(new Set([...parseJson<string[]>(existing?.reviewReasons, []), ...error.reasons]));
    await db.articleTask.update({ where: { id: taskId }, data: { status: 'NEEDS_REVIEW', message, nextAction: error.nextAction ?? 'Review the reasons, edit or regenerate the stage, then retry.', reviewReasons: JSON.stringify(reasons) } });
    await completeJob(job.id, owner, { review: true });
    return 'review';
  }
  if (error instanceof FatalError) {
    await stageUpdate({ status: 'FAILED', error: message });
    await db.articleTask.update({ where: { id: taskId }, data: { status: 'FAILED', message, nextAction: error.nextAction ?? null } });
    await appendTaskError(taskId, stageKey, message);
    await failJob(job.id, owner, { error: message, errorCode: 'FATAL', retryable: false });
    await log({ level: 'error', category: 'pipeline', taskId, stage: stageKey, message: `Fatal: ${message}` });
    return 'failed';
  }
  // Transient or unexpected error: bounded retries with exponential backoff.
  const task = await db.articleTask.findUnique({ where: { id: taskId } });
  const config = parseJson<Partial<EffectiveTaskConfig>>(task?.configSnapshot, {});
  const settings = await getSettings();
  const retryAttempts = config.retryAttempts ?? settings.workflow.retryAttempts;
  const attempts = current?.row.attempts ?? 1;
  await stageUpdate({ status: 'FAILED', error: message });
  await appendTaskError(taskId, stageKey, message);
  const kind = isPipelineError(error) ? error.kind : 'unexpected';
  if (attempts <= retryAttempts) {
    const retryAfter = isPipelineError(error) && 'retryAfterMs' in error && error.retryAfterMs ? error.retryAfterMs : null;
    const delay = retryAfter ?? exponentialBackoffMs(attempts, settings.workflow.retryBaseDelaySec * 1000, settings.workflow.retryMaxDelaySec * 1000, options.random);
    const runAt = new Date(Date.now() + delay);
    await db.articleTask.update({ where: { id: taskId }, data: { message: `${current?.stage.label ?? 'Stage'} failed (${message.slice(0, 160)}). Retry ${attempts}/${retryAttempts} at ${runAt.toLocaleTimeString()}.` } });
    await releaseJob(job.id, owner, { runAt, countAttempt: false, error: message });
    await log({ level: 'warn', category: 'pipeline', taskId, stage: stageKey, message: `${kind} error, retry scheduled in ${Math.round(delay / 1000)}s: ${message}` });
    return 'retry';
  }
  await db.articleTask.update({
    where: { id: taskId },
    data: { status: 'FAILED', message: `${current?.stage.label ?? 'Stage'} failed after ${attempts} attempt(s): ${message}`, nextAction: 'Check Logs for details, then Retry. Completed stages will not be repeated.' },
  });
  await failJob(job.id, owner, { error: message, errorCode: 'RETRIES_EXHAUSTED', retryable: false });
  await log({ level: 'error', category: 'pipeline', taskId, stage: stageKey, message: `Stage failed permanently after ${attempts} attempt(s): ${message}` });
  return 'failed';
}

async function appendTaskError(taskId: string, stageKey: string | null, message: string) {
  const task = await db.articleTask.findUnique({ where: { id: taskId }, select: { errors: true } });
  const errors = parseJson<{ at: string; stage: string | null; message: string }[]>(task?.errors, []);
  errors.push({ at: new Date().toISOString(), stage: stageKey, message: message.slice(0, 1000) });
  await db.articleTask.update({ where: { id: taskId }, data: { errors: JSON.stringify(errors.slice(-30)) } });
}
