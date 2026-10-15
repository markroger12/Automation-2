import { z } from 'zod';
import { db } from '../db';
import { audit } from '../audit';
import { badRequest, notFound } from '../errors';
import { parseJson } from '../json';
import { getSettings } from '../settings';
import { enqueue } from '../queue';
import { pastedToHtml } from '../humanizer/runs';
import { buildTextModel, inputSegments } from './text';
import { LIMITS, searchConfigured } from './sources';
import type { PlagiarismOptions, PlagiarismResult } from './types';

/** Plagiarism Evidence Checker: owner-facing operations (the check itself runs in the worker). */

export const MIN_WORDS = 50;

export const createCheckSchema = z.object({
  source: z.enum(['ARTICLE', 'PASTE']),
  taskId: z.string().max(40).optional(),
  html: z.string().max(300_000).optional(),
  title: z.string().trim().max(200).optional(),
  language: z.enum(['en', 'de']).optional(),
  keyword: z.string().trim().max(200).optional(),
  urls: z.array(z.string().trim().max(2000)).max(LIMITS.userUrls).default([]),
  ownerArticles: z.boolean().default(true),
  linkedPages: z.boolean().default(true),
  wikipedia: z.boolean().default(true),
  search: z.boolean().default(false),
});

function checkUrls(urls: string[]): string[] {
  const out: string[] = [];
  const bad: string[] = [];
  for (const raw of urls.filter(Boolean)) {
    try {
      const u = new URL(raw);
      if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) throw new Error('scheme');
      u.hash = '';
      if (!out.includes(u.toString())) out.push(u.toString());
    } catch {
      bad.push(raw.slice(0, 80));
    }
  }
  if (bad.length) throw badRequest(`Use full http(s) addresses (not: ${bad.join(', ')}).`);
  return out;
}

export async function createPlagiarismCheck(raw: unknown) {
  const input = createCheckSchema.parse(raw);
  const settings = await getSettings();
  let data: { taskId: string | null; source: string; title: string; language: string; keyword: string; inputHtml: string };
  if (input.source === 'ARTICLE') {
    if (!input.taskId) throw badRequest('Choose an article.');
    const task = await db.articleTask.findUnique({ where: { id: input.taskId } });
    if (!task) throw notFound('Article');
    const html = task.editedHtml ?? task.assembledHtml ?? task.bodyHtml;
    if (!html) throw badRequest('This article has no text yet.');
    data = { taskId: task.id, source: 'ARTICLE', title: task.selectedTitle ?? task.seoTitle ?? task.keyword, language: task.language, keyword: task.keyword, inputHtml: html };
  } else {
    const html = pastedToHtml(input.html ?? '');
    if (!html.trim()) throw badRequest('Paste the text or HTML to check.');
    data = { taskId: null, source: 'PASTE', title: input.title || 'Pasted text', language: input.language ?? settings.content.defaultLanguage, keyword: input.keyword ?? '', inputHtml: html };
  }
  const words = buildTextModel(inputSegments(data.inputHtml)).tokens.length;
  if (words < MIN_WORDS) throw badRequest(`The text is too short to check (${words} words; at least ${MIN_WORDS}).`);
  const options: PlagiarismOptions = { ownerArticles: input.ownerArticles, linkedPages: input.linkedPages, wikipedia: input.wikipedia, search: input.search, urls: checkUrls(input.urls) };
  if (!options.ownerArticles && !options.linkedPages && !options.wikipedia && !options.search && !options.urls.length) throw badRequest('Choose at least one source to compare with.');
  const check = await db.plagiarismCheck.create({ data: { ...data, options: JSON.stringify(options), message: 'Queued.' } });
  await enqueue({ queue: 'workflow', kind: 'plagiarism.check', idempotencyKey: `plagiarism:${check.id}`, relatedId: check.id, payload: { checkId: check.id } });
  await audit('plagiarism.check', 'PlagiarismCheck', check.id, { source: check.source, taskId: check.taskId, urls: options.urls.length, search: options.search && searchConfigured() });
  return check;
}

export async function cancelPlagiarismCheck(id: string) {
  const check = await db.plagiarismCheck.findUnique({ where: { id } });
  if (!check) throw notFound('Plagiarism check');
  if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(check.status)) return { ok: true, status: check.status };
  await db.queueJob.updateMany({ where: { queue: 'workflow', kind: 'plagiarism.check', relatedId: id, status: 'WAITING' }, data: { status: 'CANCELLED', errorCode: 'CANCELLED', finishedAt: new Date() } });
  await db.plagiarismCheck.update({ where: { id }, data: { status: 'CANCELLED', message: 'Cancelled by you.', progress: null, finishedAt: new Date() } });
  await audit('plagiarism.cancel', 'PlagiarismCheck', id, {});
  return { ok: true, status: 'CANCELLED' };
}

export async function failPlagiarismCheck(id: string, message: string) {
  await db.plagiarismCheck.updateMany({ where: { id, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'FAILED', message: `Failed: ${message.slice(0, 400)}`, progress: null, finishedAt: new Date() } });
}

export async function listPlagiarismChecks(filter: { taskId?: string } = {}) {
  return db.plagiarismCheck.findMany({ where: filter.taskId ? { taskId: filter.taskId } : {}, orderBy: { createdAt: 'desc' }, take: 50, select: { id: true, taskId: true, source: true, title: true, language: true, status: true, message: true, progress: true, createdAt: true, finishedAt: true } });
}

export async function getPlagiarismCheck(id: string) {
  const check = await db.plagiarismCheck.findUnique({ where: { id } });
  if (!check) throw notFound('Plagiarism check');
  const { inputHtml, ...rest } = check;
  return { ...rest, inputWords: buildTextModel(inputSegments(inputHtml)).tokens.length, options: parseJson<PlagiarismOptions>(check.options, { ownerArticles: true, linkedPages: true, wikipedia: true, search: false, urls: [] }), result: check.status === 'COMPLETED' ? parseJson<PlagiarismResult | null>(check.result, null) : null };
}

export function plagiarismMeta() {
  return { searchConfigured: searchConfigured(), limits: { userUrls: LIMITS.userUrls, linkedPages: LIMITS.linkedPages, searchQueries: LIMITS.searchQueries, searchResults: LIMITS.searchResults, minWords: MIN_WORDS } };
}
