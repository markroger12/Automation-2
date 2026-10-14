import { z } from 'zod';
import { db } from '../db';
import { AppError } from '../errors';
import { audit } from '../audit';
import { parseJson, stringArray } from '../json';
import { sanitizeArticleHtml } from '../html/sanitize';
import { getManifest } from '@/modules/registry';
import { regenerationPlan } from '@/modules/types';
import { ensureArticleRun } from './lifecycle';
import { runSeoChecks } from '../seo/checks';
import { getSettings, parseSiteOverrides } from '../settings';
import { effectiveTaskConfig, taskOptionsSchema, type EffectiveTaskConfig } from '../settings-schema';

async function loadTask(id: string) {
  const task = await db.articleTask.findUnique({ where: { id } });
  if (!task) throw new AppError(404, 'NOT_FOUND', 'Task not found.');
  if (task.legacy || !getManifest(task.moduleKey)) throw new AppError(409, 'RETIRED_WRITER', 'This task belongs to a retired writer and is read-only.');
  return task;
}

async function assertIdle(taskId: string) {
  const active = await db.queueJob.count({ where: { taskId, status: 'ACTIVE', queue: 'article' } });
  if (active) throw new AppError(409, 'BUSY', 'The worker is processing this task right now. Try again in a few seconds.');
}

export const approveTitleSchema = z.object({ title: z.string().trim().min(5, 'Title is too short').max(200, 'Title is too long') });

export async function approveTitle(taskId: string, raw: unknown) {
  const { title } = approveTitleSchema.parse(raw);
  const task = await loadTask(taskId);
  const research = await db.articleStage.findUnique({ where: { taskId_key: { taskId, key: 'RESEARCH' } } });
  const changed = task.selectedTitle !== title;
  await db.articleTask.update({ where: { id: taskId }, data: { selectedTitle: title, titleApprovedAt: new Date(), version: { increment: 1 } } });
  await audit('task.approve-title', 'ArticleTask', taskId, { title, changed });
  if (task.status === 'AWAITING_TITLE_APPROVAL') await ensureArticleRun(taskId, 'title-approved');
  return { ok: true, note: changed && research?.status === 'COMPLETED' ? 'Research and the article were written with the previous title. Regenerate from RESEARCH if needed.' : null };
}

export async function approveArticle(taskId: string) {
  const task = await loadTask(taskId);
  await db.articleTask.update({ where: { id: taskId }, data: { articleApprovedAt: new Date(), version: { increment: 1 } } });
  await audit('task.approve-article', 'ArticleTask', taskId, {});
  if (task.status === 'AWAITING_ARTICLE_APPROVAL') await ensureArticleRun(taskId, 'article-approved');
  return { ok: true };
}

export const overrideSchema = z.object({ reason: z.string().trim().min(3, 'Give a short reason').max(500) });

/** Owner accepts the current review reasons (audited); the gate is re-run with the override. */
export async function overrideQuality(taskId: string, raw: unknown) {
  const { reason } = overrideSchema.parse(raw);
  const task = await loadTask(taskId);
  await assertIdle(taskId);
  const options = { ...parseJson<Record<string, unknown>>(task.options, {}), qualityOverride: true, qualityOverrideReason: reason };
  await db.articleTask.update({ where: { id: taskId }, data: { options: JSON.stringify(options), status: 'QUEUED', message: 'Owner approved despite review reasons.', nextAction: null } });
  await db.articleStage.updateMany({ where: { taskId, key: { in: ['QUALITY_GATE', 'VERIFIED_COMPLETE'] }, status: { in: ['FAILED', 'WAITING', 'COMPLETED'] } }, data: { status: 'PENDING', error: null } });
  await audit('task.quality-override', 'ArticleTask', taskId, { reason });
  await ensureArticleRun(taskId, 'quality-override');
  return { ok: true };
}

/** Owner confirms an intentional duplicate keyword on the same site. */
export async function allowDuplicate(taskId: string) {
  const task = await loadTask(taskId);
  await assertIdle(taskId);
  const options = { ...parseJson<Record<string, unknown>>(task.options, {}), allowDuplicate: true };
  await db.articleTask.update({ where: { id: taskId }, data: { options: JSON.stringify(options), status: 'QUEUED', message: 'Duplicate allowed by the owner.', nextAction: null, reviewReasons: '[]' } });
  await db.articleStage.updateMany({ where: { taskId, key: 'DUPLICATE_PRECHECK' }, data: { status: 'PENDING', error: null } });
  await audit('task.allow-duplicate', 'ArticleTask', taskId, {});
  await ensureArticleRun(taskId, 'allow-duplicate');
  return { ok: true };
}

/** Task fields cleared when a stage is regenerated (old values are kept as stage revisions). */
const REGEN_RESETS: Record<string, Record<string, unknown>> = {
  TITLES: { titleOptions: '[]', recommendedTitle: null, selectedTitle: null, titleApprovedAt: null },
  TITLE_APPROVAL: { titleApprovedAt: null },
  RESEARCH: { researchNotes: null },
  FINAL_ARTICLE: { bodyHtml: null },
  ARTICLE: { bodyHtml: null, seoTitle: null, metaDescription: null, slug: null },
  FAQS: { faqs: '[]' },
  QUICK_BIO: { quickBio: '[]', quickBioHtml: null },
  ASSEMBLY: { assembledHtml: null },
  SEO_CHECK: { seoScore: null },
  ARTICLE_APPROVAL: { articleApprovedAt: null },
};

export async function regenerationPreview(taskId: string, stageKey: string) {
  const task = await loadTask(taskId);
  const manifest = getManifest(task.moduleKey)!;
  const stage = manifest.stages.find((s) => s.key === stageKey);
  if (!stage) throw new AppError(400, 'VALIDATION', `Unknown stage ${stageKey}.`);
  return { stage: stageKey, plan: regenerationPlan(manifest, stageKey) };
}

/**
 * Regenerate a stage and ONLY its genuine dependents (manifest dependency
 * graph). Previous outputs are preserved as ArticleStageRevision rows; owner
 * edits are kept as a revision too. Unaffected research/editorial work stays.
 */
export async function regenerateStage(taskId: string, stageKey: string) {
  const task = await loadTask(taskId);
  await assertIdle(taskId);
  const manifest = getManifest(task.moduleKey)!;
  const stage = manifest.stages.find((s) => s.key === stageKey);
  if (!stage) throw new AppError(400, 'VALIDATION', `Unknown stage ${stageKey}.`);
  if (!stage.regenerable) throw new AppError(400, 'VALIDATION', `${stage.label} cannot be regenerated directly; regenerate an earlier stage.`);
  const plan = regenerationPlan(manifest, stageKey);
  const rows = await db.articleStage.findMany({ where: { taskId, key: { in: plan } } });
  const resets: Record<string, unknown> = {};
  for (const row of rows) {
    if (row.output || row.outputHtml || row.outputJson) {
      await db.articleStageRevision.create({ data: { stageId: row.id, taskId, key: row.key, reason: `regenerate:${stageKey}`, prompt: row.prompt, output: row.output, outputHtml: row.outputHtml, outputJson: row.outputJson } });
    }
    await db.articleStage.update({
      where: { id: row.id },
      data: { status: 'PENDING', output: null, outputHtml: null, outputJson: null, error: null, message: `Regeneration requested (${stageKey})`, startedAt: null, completedAt: null, durationMs: null, privateState: JSON.stringify({ regenerated: true }) },
    });
    Object.assign(resets, REGEN_RESETS[row.key] ?? {});
  }
  if (task.editedHtml && plan.includes('ASSEMBLY')) {
    const asm = rows.find((r) => r.key === 'ASSEMBLY');
    if (asm) await db.articleStageRevision.create({ data: { stageId: asm.id, taskId, key: 'EDITOR', reason: `owner edits before regenerate:${stageKey}`, outputHtml: task.editedHtml } });
    resets.editedHtml = null;
    resets.editedAt = null;
  }
  await db.chatGPTResponse.updateMany({ where: { taskId, stageKey: { in: plan }, status: { in: ['COMPLETED', 'PENDING'] } }, data: { status: 'SUPERSEDED' } });
  await db.queueJob.updateMany({ where: { taskId, queue: 'chatgpt', status: 'WAITING' }, data: { status: 'CANCELLED', errorCode: 'SUPERSEDED' } });
  await db.articleTask.update({
    where: { id: taskId },
    data: { ...resets, status: 'QUEUED', message: `Regenerating ${stage.label} and ${plan.length - 1} dependent stage(s).`, nextAction: null, reviewReasons: '[]', verifiedCompleteAt: null, version: { increment: 1 } },
  });
  await audit('task.regenerate', 'ArticleTask', taskId, { stageKey, plan });
  await ensureArticleRun(taskId, `regenerate:${stageKey}`);
  return { ok: true, plan };
}

export const contentSchema = z.object({ html: z.string().max(2_000_000), baseVersion: z.number().int().min(0) });

/** Save owner edits (optimistic concurrency on task.version). The generated original stays untouched. */
export async function saveEditedContent(taskId: string, raw: unknown) {
  const { html, baseVersion } = contentSchema.parse(raw);
  const task = await loadTask(taskId);
  if (task.version !== baseVersion) throw new AppError(409, 'CONFLICT', 'This article changed since you opened it (the worker or another tab updated it). Copy your edits, reload, and apply them again.');
  const clean = sanitizeArticleHtml(html);
  if (task.editedHtml) {
    const asm = await db.articleStage.findUnique({ where: { taskId_key: { taskId, key: 'ASSEMBLY' } } });
    if (asm) await db.articleStageRevision.create({ data: { stageId: asm.id, taskId, key: 'EDITOR', reason: 'previous owner edit', outputHtml: task.editedHtml } });
  }
  const updated = await db.articleTask.update({ where: { id: taskId }, data: { editedHtml: clean, editedAt: new Date(), version: { increment: 1 } } });
  await audit('task.edit-content', 'ArticleTask', taskId, { length: clean.length });
  return { ok: true, version: updated.version, html: clean };
}

export async function discardEdits(taskId: string) {
  const task = await loadTask(taskId);
  if (task.editedHtml) {
    const asm = await db.articleStage.findUnique({ where: { taskId_key: { taskId, key: 'ASSEMBLY' } } });
    if (asm) await db.articleStageRevision.create({ data: { stageId: asm.id, taskId, key: 'EDITOR', reason: 'discarded owner edit', outputHtml: task.editedHtml } });
  }
  const updated = await db.articleTask.update({ where: { id: taskId }, data: { editedHtml: null, editedAt: null, version: { increment: 1 } } });
  return { ok: true, version: updated.version };
}

async function taskConfig(task: { options: string; configSnapshot: string; websiteId: string }): Promise<EffectiveTaskConfig> {
  const snap = parseJson<Partial<EffectiveTaskConfig>>(task.configSnapshot, {});
  const site = await db.website.findUniqueOrThrow({ where: { id: task.websiteId } });
  const options = taskOptionsSchema.safeParse(parseJson(task.options, {}));
  return { ...effectiveTaskConfig(await getSettings(), parseSiteOverrides(site.settingsOverrides), options.success ? options.data : taskOptionsSchema.parse({})), ...snap };
}

/** Re-run the transparent SEO checks on the current (possibly edited) article. */
export async function rerunSeo(taskId: string) {
  const task = await loadTask(taskId);
  const html = task.editedHtml ?? task.assembledHtml;
  if (!html) throw new AppError(409, 'NOT_READY', 'There is no assembled article yet.');
  const config = await taskConfig(task);
  const range = config.tigramWordRange.split(/\s*[-–]\s*/).map(Number) as [number, number];
  const report = runSeoChecks({
    html,
    moduleKey: task.moduleKey,
    language: task.language,
    keyword: task.focusKeyword ?? task.keyword,
    title: task.selectedTitle,
    seoTitle: task.seoTitle,
    metaDescription: task.metaDescription,
    slug: task.slug,
    categoryName: task.categoryName,
    tags: stringArray(task.tags),
    expectedFaqCount: task.moduleKey === 'tigram-writer' ? config.tigramFaqCount : config.faqCount,
    quickBioRows: config.quickBioRows,
    maxWords: config.maxWords,
    wordRange: task.moduleKey === 'tigram-writer' ? range : null,
    minKeywordOccurrences: config.minKeywordOccurrences,
    maxKeywordOccurrences: config.maxKeywordOccurrences,
    densityCeilingPct: config.keywordDensityCeilingPct,
    externalLinksEnabled: config.externalLinks,
    internalLinksEnabled: config.internalLinks,
    imagesExpected: config.images && config.imagesRequired,
  });
  await db.sEOReport.create({ data: { taskId, source: 'INTERNAL', score: report.score, checks: JSON.stringify(report.checks), metrics: JSON.stringify(report.metrics) } });
  await db.articleTask.update({ where: { id: taskId }, data: { seoScore: report.score } });
  return { score: report.score };
}

export const metadataSchema = z.object({
  seoTitle: z.string().trim().max(120).optional(),
  metaDescription: z.string().trim().max(300).optional(),
  slug: z.string().trim().max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens').optional(),
  focusKeyword: z.string().trim().max(160).optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(15).optional(),
  baseVersion: z.number().int().min(0),
});

export async function saveMetadata(taskId: string, raw: unknown) {
  const input = metadataSchema.parse(raw);
  const task = await loadTask(taskId);
  if (task.version !== input.baseVersion) throw new AppError(409, 'CONFLICT', 'This article changed since you opened it. Reload and try again.');
  const updated = await db.articleTask.update({
    where: { id: taskId },
    data: {
      ...(input.seoTitle !== undefined ? { seoTitle: input.seoTitle } : {}),
      ...(input.metaDescription !== undefined ? { metaDescription: input.metaDescription } : {}),
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.focusKeyword !== undefined ? { focusKeyword: input.focusKeyword } : {}),
      ...(input.tags !== undefined ? { tags: JSON.stringify(input.tags) } : {}),
      version: { increment: 1 },
    },
  });
  await audit('task.edit-metadata', 'ArticleTask', taskId, { fields: Object.keys(input).filter((k) => k !== 'baseVersion') });
  return { ok: true, version: updated.version };
}
