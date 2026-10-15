import { z } from 'zod';
import { db } from '../db';
import { audit } from '../audit';
import { AppError, badRequest, notFound } from '../errors';
import { parseJson } from '../json';
import { retryTask } from '../tasks/lifecycle';
import { buildTextModel, htmlSegments } from '../plagiarism/text';
import { blockFingerprint, boilerplateTokens } from '../plagiarism/match';
import { compareArticles, paragraphHashes, type DuplicateComparison, type Severity } from './compare';

/**
 * Duplicate Content Detector, persistence and owner actions. Runs at the
 * quality gate against every saved article on all websites; records
 * paragraph fingerprints and the overlaps found. HIGH overlap pauses the
 * article before WordPress unless the owner overrides it with a reason
 * (audited). Nothing is deleted or rewritten automatically.
 */

const CORPUS_LIMIT = 500;
const RANK: Record<Severity, number> = { HIGH: 3, MEDIUM: 2, LOW: 1 };
const textOf = (t: { editedHtml: string | null; assembledHtml: string | null; bodyHtml: string | null }) => t.editedHtml ?? t.assembledHtml ?? t.bodyHtml ?? '';

export interface DuplicateCheckResult {
  highest: Severity | null;
  overridden: boolean;
  overrideReason: string | null;
  comparisons: (DuplicateComparison & { otherTitle: string; otherWebsite: string; sameWebsite: boolean })[];
  compared: number;
}

export async function runDuplicateCheck(taskId: string, html: string, highShare: number): Promise<DuplicateCheckResult> {
  const task = await db.articleTask.findUniqueOrThrow({ where: { id: taskId }, select: { id: true, websiteId: true, options: true } });
  const options = parseJson<{ duplicateOverride?: { reason: string; at: string } }>(task.options, {});
  const article = buildTextModel(htmlSegments(html));
  const others = await db.articleTask.findMany({
    where: { id: { not: taskId }, status: { not: 'CANCELLED' }, OR: [{ editedHtml: { not: null } }, { assembledHtml: { not: null } }, { bodyHtml: { not: null } }] },
    orderBy: { createdAt: 'desc' },
    take: CORPUS_LIMIT,
    select: { id: true, websiteId: true, keyword: true, selectedTitle: true, editedHtml: true, assembledHtml: true, bodyHtml: true, website: { select: { name: true } } },
  });
  const models = others.map((o) => ({ o, model: buildTextModel(htmlSegments(textOf(o))) }));
  // Text that recurs across this website (calls to action, link lines) is not duplication.
  const counts = new Map<string, number>();
  for (const { o, model } of models) {
    if (o.websiteId !== task.websiteId) continue;
    for (const fp of new Set(model.blocks.map((b) => blockFingerprint(model, b)))) counts.set(fp, (counts.get(fp) ?? 0) + 1);
  }
  const boilerplate = boilerplateTokens(article, counts, 3).tokens;
  const comparisons: DuplicateCheckResult['comparisons'] = [];
  for (const { o, model } of models) {
    const c = compareArticles(article, model, o.id, { highShare, boilerplate });
    if (c) comparisons.push({ ...c, otherTitle: o.selectedTitle ?? o.keyword, otherWebsite: o.website.name, sameWebsite: o.websiteId === task.websiteId });
  }
  comparisons.sort((a, b) => RANK[b.severity] - RANK[a.severity] || b.wordingWords - a.wordingWords);
  const overridden = Boolean(options.duplicateOverride);

  await db.$transaction([
    db.contentFingerprint.deleteMany({ where: { taskId } }),
    db.contentFingerprint.createMany({ data: paragraphHashes(article).map((p) => ({ taskId, websiteId: task.websiteId, hash: p.hash, words: p.words, position: p.position })) }),
    db.duplicateMatch.deleteMany({ where: { taskId } }),
    db.duplicateMatch.createMany({
      data: comparisons.slice(0, 50).map((c) => ({
        taskId,
        otherTaskId: c.otherTaskId,
        otherTitle: c.otherTitle.slice(0, 300),
        otherWebsite: c.otherWebsite,
        sameWebsite: c.sameWebsite,
        severity: c.severity,
        wordingWords: c.wordingWords,
        factWords: c.factWords,
        longestRun: c.longestRun,
        nearSentences: c.nearSentences,
        exactParagraphs: c.exactParagraphs,
        wordingShare: c.wordingShare,
        excerpts: JSON.stringify(c.excerpts),
        status: overridden ? 'OVERRIDDEN' : c.severity === 'LOW' ? 'CLEARED' : 'OPEN',
      })),
    }),
  ]);
  return { highest: comparisons[0]?.severity ?? null, overridden, overrideReason: options.duplicateOverride?.reason ?? null, comparisons, compared: others.length };
}

export const overrideSchema = z.object({ reason: z.string().trim().min(10, 'Give a reason of at least 10 characters.').max(500) });

/** Keep the article despite the overlap: reason recorded (audit), matches marked overridden, the paused task retried. */
export async function overrideDuplicates(taskId: string, raw: unknown) {
  const { reason } = overrideSchema.parse(raw);
  const task = await db.articleTask.findUnique({ where: { id: taskId } });
  if (!task) throw notFound('Article');
  const options = parseJson<Record<string, unknown>>(task.options, {});
  await db.articleTask.update({ where: { id: taskId }, data: { options: JSON.stringify({ ...options, duplicateOverride: { reason, at: new Date().toISOString() } }) } });
  const changed = await db.duplicateMatch.updateMany({ where: { taskId, status: 'OPEN' }, data: { status: 'OVERRIDDEN' } });
  await audit('duplicate.override', 'ArticleTask', taskId, { reason, matches: changed.count });
  let retried = false;
  if (task.status === 'NEEDS_REVIEW') {
    const gate = await db.articleStage.findUnique({ where: { taskId_key: { taskId, key: 'QUALITY_GATE' } } });
    if (gate && gate.status !== 'COMPLETED') {
      await retryTask(taskId);
      retried = true;
    }
  }
  return { ok: true, overridden: changed.count, retried };
}

/** Withdraw an override: the next quality gate pauses again for HIGH overlap. */
export async function withdrawOverride(taskId: string) {
  const task = await db.articleTask.findUnique({ where: { id: taskId } });
  if (!task) throw notFound('Article');
  const { duplicateOverride, ...rest } = parseJson<Record<string, unknown>>(task.options, {});
  if (!duplicateOverride) throw new AppError(409, 'CONFLICT', 'No override to withdraw.');
  await db.articleTask.update({ where: { id: taskId }, data: { options: JSON.stringify(rest) } });
  await db.duplicateMatch.updateMany({ where: { taskId, status: 'OVERRIDDEN' }, data: { status: 'OPEN' } });
  await audit('duplicate.override-withdrawn', 'ArticleTask', taskId, {});
  return { ok: true };
}

export async function listDuplicateReviews(filter: { status?: 'OPEN' | 'OVERRIDDEN' | 'ALL'; websiteId?: string }) {
  const status = filter.status ?? 'OPEN';
  const matches = await db.duplicateMatch.findMany({
    where: { ...(status === 'ALL' ? {} : { status }), severity: { in: ['HIGH', 'MEDIUM'] }, ...(filter.websiteId ? { task: { websiteId: filter.websiteId } } : {}) },
    orderBy: [{ updatedAt: 'desc' }],
    take: 300,
    include: { task: { select: { id: true, keyword: true, selectedTitle: true, status: true, moduleKey: true, options: true, website: { select: { id: true, name: true } } } } },
  });
  const byTask = new Map<string, { task: { id: string; title: string; status: string; moduleKey: string; website: string; websiteId: string; overrideReason: string | null }; matches: ReturnType<typeof shape>[] }>();
  for (const m of matches) {
    const entry = byTask.get(m.taskId) ?? {
      task: { id: m.task.id, title: m.task.selectedTitle ?? m.task.keyword, status: m.task.status, moduleKey: m.task.moduleKey, website: m.task.website.name, websiteId: m.task.website.id, overrideReason: parseJson<{ duplicateOverride?: { reason: string } }>(m.task.options, {}).duplicateOverride?.reason ?? null },
      matches: [],
    };
    entry.matches.push(shape(m));
    byTask.set(m.taskId, entry);
  }
  return [...byTask.values()];
}

function shape(m: { id: string; otherTaskId: string; otherTitle: string; otherWebsite: string; sameWebsite: boolean; severity: string; wordingWords: number; factWords: number; longestRun: number; nearSentences: number; exactParagraphs: number; wordingShare: number; excerpts: string; status: string; updatedAt: Date }) {
  return { ...m, excerpts: parseJson<DuplicateComparison['excerpts']>(m.excerpts, []) };
}

export async function duplicatesForTask(taskId: string) {
  const rows = await db.duplicateMatch.findMany({ where: { taskId }, orderBy: [{ wordingWords: 'desc' }] });
  return rows.map(shape);
}

export const validateOverrideBody = (raw: unknown) => {
  const r = overrideSchema.safeParse(raw);
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? 'Invalid reason.');
  return r.data;
};
