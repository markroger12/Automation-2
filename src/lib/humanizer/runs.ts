import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db';
import { audit } from '../audit';
import { AppError, badRequest, notFound } from '../errors';
import { parseJson } from '../json';
import { getSettings } from '../settings';
import { enqueue } from '../queue';
import { isActiveModuleKey } from '../domain';
import { sanitizeArticleHtml } from '../html/sanitize';
import { languageInstruction } from '../chatgpt/language';
import { createRunChatGPTRequest } from '../chatgpt/jobs';
import { loadPromptTemplate } from '../prompts/load';
import { validatePromptContent } from '../prompts/manage';
import { renderTemplate } from '../prompts/template';
import { findPromptDefault } from '@/modules/prompt-defaults';
import { applyResults, batchVariables, evaluateBatch, planHumanize, skippedResults, summarize, type ParagraphResult } from './plan';

/**
 * Humanizer page runs: a saved article or pasted text, edited with the same
 * planning, prompts and fact locks as the HUMANIZE stage, through the same
 * ChatGPT bridge. A result is never pushed to WordPress: applying it to an
 * article saves an owner edit (with history); the owner then re-saves the
 * draft explicitly.
 */

export const createRunSchema = z.object({
  source: z.enum(['ARTICLE', 'PASTE']),
  taskId: z.string().max(40).optional(),
  html: z.string().max(300_000).optional(),
  title: z.string().trim().max(200).optional(),
  language: z.enum(['en', 'de']).optional(),
  keyword: z.string().trim().max(200).optional(),
  scope: z.enum(['all', 'flagged']).default('all'),
  promptOverride: z.string().max(50_000).nullable().optional(),
});

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Pasted plain text becomes paragraphs (blank-line separated); HTML is sanitized. */
export function pastedToHtml(input: string): string {
  if (/<\/?(p|h[1-6]|ul|ol|table|strong|em|a)\b/i.test(input)) return sanitizeArticleHtml(input);
  return input
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p)}</p>`)
    .join('');
}

const articleBaseline = (t: { editedHtml: string | null; assembledHtml: string | null }) => t.editedHtml ?? t.assembledHtml ?? '';

export async function createHumanizerRun(raw: unknown) {
  const input = createRunSchema.parse(raw);
  const settings = await getSettings();
  let data: { taskId: string | null; source: string; title: string; language: string; keyword: string; inputHtml: string; baselineHash: string | null };
  if (input.source === 'ARTICLE') {
    if (!input.taskId) throw badRequest('Choose an article.');
    const task = await db.articleTask.findUnique({ where: { id: input.taskId } });
    if (!task) throw notFound('Article');
    if (task.legacy || !isActiveModuleKey(task.moduleKey)) throw new AppError(409, 'RETIRED_WRITER', 'Articles of the retired Celebrity Writer 2.0 are read-only.');
    const baseline = articleBaseline(task);
    if (!baseline) throw badRequest('This article has no assembled text yet.');
    data = { taskId: task.id, source: 'ARTICLE', title: task.selectedTitle ?? task.seoTitle ?? task.keyword, language: task.language, keyword: task.keyword, inputHtml: baseline, baselineHash: hash(baseline) };
  } else {
    const html = pastedToHtml(input.html ?? '');
    if (!html.trim()) throw badRequest('Paste the text or HTML to edit.');
    data = { taskId: null, source: 'PASTE', title: input.title || 'Pasted text', language: input.language ?? settings.content.defaultLanguage, keyword: input.keyword ?? '', inputHtml: html, baselineHash: null };
  }
  const plan = planHumanize(data.inputHtml, { language: data.language, scope: input.scope, batchWords: settings.content.humanizerBatchWords });
  if (!plan.paragraphs.length) throw badRequest('No paragraphs found. Paste text with paragraphs separated by blank lines, or HTML with <p> paragraphs.');
  if (!plan.batches.length) throw badRequest(input.scope === 'flagged' && plan.paragraphs.some((p) => p.skip?.startsWith('no issues')) ? 'No paragraph was flagged by the local editor. Choose “All eligible paragraphs” to edit anyway.' : 'No paragraph is long enough to edit (at least 12 words, plain text with links, bold or italic).');
  const override = input.promptOverride?.trim() ? input.promptOverride.replace(/\r\n/g, '\n') : null;
  if (override) {
    const check = validatePromptContent(override, findPromptDefault('shared', 'HUMANIZE')?.variables ?? []);
    if (check.errors.length) throw badRequest(`Prompt: ${check.errors[0]}`);
    if (!override.includes('{{paragraphs}}')) throw badRequest('The prompt must contain {{paragraphs}}.');
  }
  const run = await db.humanizerRun.create({ data: { ...data, scope: input.scope, promptOverride: override, message: `Queued: ${plan.batches.length} batch(es), ${plan.paragraphs.filter((p) => !p.skip).length} paragraph(s) to edit.` } });
  await enqueue({ queue: 'humanizer', kind: 'humanizer.run', idempotencyKey: `humanizer:${run.id}`, relatedId: run.id, payload: { runId: run.id } });
  await audit('humanizer.run', 'HumanizerRun', run.id, { source: run.source, taskId: run.taskId, scope: run.scope, customPrompt: Boolean(override) });
  return run;
}

/** One worker pass over a run: sends missing batch prompts, or finishes when every batch has an answer. */
export async function processHumanizerRun(runId: string): Promise<{ state: 'waiting' | 'done'; message: string }> {
  const run = await db.humanizerRun.findUnique({ where: { id: runId }, include: { task: { include: { website: true } } } });
  if (!run) return { state: 'done', message: 'Run no longer exists.' };
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) return { state: 'done', message: `Run is ${run.status}.` };
  const settings = await getSettings();
  const plan = planHumanize(run.inputHtml, { language: run.language, scope: run.scope === 'flagged' ? 'flagged' : 'all', batchWords: settings.content.humanizerBatchWords });
  const template = run.promptOverride ?? (await loadPromptTemplate('shared', 'HUMANIZE', run.task?.website ?? null)).content;
  const country = run.task?.targetCountry ?? (run.language === 'de' ? 'Germany' : 'United States');
  const answers: (string | { error: string } | null)[] = [];
  for (const b of plan.batches) {
    const vars = { keyword: run.keyword || 'the primary keyword (none given)', ...batchVariables(plan, b.index) };
    const prompt = `${renderTemplate(template, vars).text}\n\n${languageInstruction(run.language, country)}`;
    const operationId = `hz:${run.id}:b${b.index + 1}`;
    const response = await db.chatGPTResponse.findUnique({ where: { operationId } });
    if (!response) {
      await createRunChatGPTRequest({ runId: run.id, language: run.language, operationId, prompt, timeoutSec: settings.browser.generationTimeoutSec });
      answers.push(null);
    } else if (response.status === 'COMPLETED' && response.resultText !== null) answers.push(response.resultText);
    else if (response.status === 'PENDING') answers.push(null);
    else answers.push({ error: response.error ?? `prompt ${response.status.toLowerCase()}` });
  }
  const pending = answers.filter((a) => a === null).length;
  if (pending) {
    const message = `Waiting for ChatGPT: ${pending} of ${plan.batches.length} batch(es).`;
    await db.humanizerRun.update({ where: { id: run.id }, data: { status: 'WAITING', message } });
    return { state: 'waiting', message };
  }
  const lock = { keyword: run.keyword, language: run.language, names: run.keyword && /\p{Lu}/u.test(run.keyword) && run.task?.moduleKey === 'celebrity-writer' ? [run.keyword] : [], tolerancePct: settings.content.humanizerLengthTolerancePct };
  const results: ParagraphResult[] = [];
  answers.forEach((a, i) => results.push(...evaluateBatch(plan, i, a!, lock)));
  results.push(...skippedResults(plan));
  results.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  const outputHtml = sanitizeArticleHtml(applyResults(run.inputHtml, plan, results));
  const summary = summarize(plan, results, run.language);
  const message = plan.batches.length ? `${summary.rewritten} edited, ${summary.kept} kept by fact locks, ${summary.unchanged} unchanged, ${summary.skipped} not sent.` : 'No paragraph needed editing.';
  await db.humanizerRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', message, outputHtml, result: JSON.stringify({ paragraphs: results, summary, observations: plan.observations, batches: plan.batches.length }) } });
  return { state: 'done', message };
}

export async function failHumanizerRun(runId: string, message: string) {
  await db.humanizerRun.updateMany({ where: { id: runId, status: { notIn: ['COMPLETED', 'CANCELLED'] } }, data: { status: 'FAILED', message: message.slice(0, 1000) } });
}

/** Stop a run: waiting prompts are cancelled (an answer already received is kept on the response). */
export async function cancelHumanizerRun(id: string) {
  const run = await db.humanizerRun.findUnique({ where: { id } });
  if (!run) throw notFound('Humanizer run');
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)) return { ok: true, status: run.status };
  const responses = await db.chatGPTResponse.findMany({ where: { runId: id, status: 'PENDING' }, select: { id: true } });
  await db.queueJob.updateMany({ where: { queue: 'chatgpt', relatedId: { in: responses.map((r) => r.id) }, status: 'WAITING' }, data: { status: 'CANCELLED', errorCode: 'CANCELLED', finishedAt: new Date() } });
  await db.chatGPTResponse.updateMany({ where: { runId: id, status: 'PENDING' }, data: { status: 'SUPERSEDED', error: 'Run cancelled' } });
  await db.queueJob.updateMany({ where: { queue: 'humanizer', relatedId: id, status: 'WAITING' }, data: { status: 'CANCELLED', errorCode: 'CANCELLED', finishedAt: new Date() } });
  await db.humanizerRun.update({ where: { id }, data: { status: 'CANCELLED', message: 'Cancelled by you.' } });
  await audit('humanizer.cancel', 'HumanizerRun', id, {});
  return { ok: true, status: 'CANCELLED' };
}

/**
 * Apply a finished run to its article as an owner edit (previous edit kept in
 * history). Refused when the article changed since the run started. The
 * WordPress draft is NOT touched — the owner re-saves it explicitly.
 */
export async function applyHumanizerRun(id: string) {
  const run = await db.humanizerRun.findUnique({ where: { id } });
  if (!run) throw notFound('Humanizer run');
  if (run.source !== 'ARTICLE' || !run.taskId) throw badRequest('Only runs started from a saved article can be applied to it. Copy or export pasted results instead.');
  if (run.status !== 'COMPLETED' || !run.outputHtml) throw badRequest('The run has not finished.');
  if (run.appliedAt) throw new AppError(409, 'ALREADY_APPLIED', 'This run was already applied.');
  const task = await db.articleTask.findUnique({ where: { id: run.taskId } });
  if (!task) throw notFound('Article');
  if (task.legacy || !isActiveModuleKey(task.moduleKey)) throw new AppError(409, 'RETIRED_WRITER', 'Retired writer tasks are read-only.');
  if (hash(articleBaseline(task)) !== run.baselineHash) throw new AppError(409, 'CONFLICT', 'The article changed after this run started. Run the humanizer again on the current version.');
  const asm = await db.articleStage.findUnique({ where: { taskId_key: { taskId: task.id, key: 'ASSEMBLY' } } });
  if (asm && task.editedHtml) await db.articleStageRevision.create({ data: { stageId: asm.id, taskId: task.id, key: 'EDITOR', reason: 'owner edit before humanizer run', outputHtml: task.editedHtml } });
  if (asm) await db.articleStageRevision.create({ data: { stageId: asm.id, taskId: task.id, key: 'HUMANIZER', reason: `humanizer run ${run.id} applied`, outputHtml: run.outputHtml } });
  await db.articleTask.update({ where: { id: task.id }, data: { editedHtml: run.outputHtml, editedAt: new Date(), version: { increment: 1 } } });
  await db.humanizerRun.update({ where: { id }, data: { appliedAt: new Date() } });
  await audit('humanizer.apply', 'ArticleTask', task.id, { runId: run.id });
  return { ok: true, message: 'Applied to the article as your edit (the previous version is kept in its history). The WordPress draft was not changed — use “Save again” on the article’s WordPress tab when you are ready.' };
}

export async function listHumanizerRuns(filter: { taskId?: string } = {}) {
  const runs = await db.humanizerRun.findMany({ where: filter.taskId ? { taskId: filter.taskId } : {}, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, taskId: true, source: true, title: true, language: true, scope: true, status: true, message: true, appliedAt: true, createdAt: true, promptOverride: true } });
  return runs.map(({ promptOverride, ...r }) => ({ ...r, customPrompt: Boolean(promptOverride) }));
}

export async function getHumanizerRun(id: string) {
  const run = await db.humanizerRun.findUnique({ where: { id }, include: { task: { select: { id: true, keyword: true, editedHtml: true, assembledHtml: true, legacy: true } } } });
  if (!run) throw notFound('Humanizer run');
  const { task, ...rest } = run;
  return {
    ...rest,
    result: parseJson<Record<string, unknown>>(run.result, {}),
    articleChanged: task ? hash(articleBaseline(task)) !== run.baselineHash : false,
    task: task ? { id: task.id, keyword: task.keyword } : null,
  };
}
