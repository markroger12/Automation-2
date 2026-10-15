import { z } from 'zod';
import { db } from '../db';
import { audit } from '../audit';
import { notFound } from '../errors';
import { parseJson } from '../json';
import { enqueue } from '../queue';
import { changesSinceLastResearch, type EvidenceEntry, type LedgerSummary } from './ledger';

/** Research Evidence page: ledgers per article, owner decisions (sources kept), and re-checks. */

export async function listLedgers() {
  const groups = await db.claimEvidence.groupBy({ by: ['taskId', 'status'], _count: { _all: true }, _max: { researchedAt: true } });
  const ids = [...new Set(groups.map((g) => g.taskId))];
  const tasks = await db.articleTask.findMany({ where: { id: { in: ids } }, select: { id: true, keyword: true, selectedTitle: true, status: true, website: { select: { name: true } } } });
  const open = await db.claimEvidence.groupBy({ by: ['taskId'], where: { highImpact: true, ownerDecision: null, status: { in: ['CONTRADICTED', 'UNVERIFIED', 'DISPUTED'] } }, _count: { _all: true } });
  return tasks
    .map((t) => {
      const mine = groups.filter((g) => g.taskId === t.id);
      return {
        task: { id: t.id, title: t.selectedTitle ?? t.keyword, keyword: t.keyword, status: t.status, website: t.website.name },
        researchedAt: mine.reduce<Date | null>((m, g) => (g._max.researchedAt && (!m || g._max.researchedAt > m) ? g._max.researchedAt : m), null),
        byStatus: Object.fromEntries(mine.map((g) => [g.status, g._count._all])),
        openHighImpact: open.find((o) => o.taskId === t.id)?._count._all ?? 0,
      };
    })
    .sort((a, b) => (b.researchedAt?.getTime() ?? 0) - (a.researchedAt?.getTime() ?? 0));
}

export async function getLedger(taskId: string) {
  const task = await db.articleTask.findUnique({ where: { id: taskId }, select: { id: true, keyword: true, selectedTitle: true, status: true, researchNotes: true, website: { select: { name: true } } } });
  if (!task) throw notFound('Article');
  const claims = await db.claimEvidence.findMany({ where: { taskId }, orderBy: [{ highImpact: 'desc' }, { createdAt: 'asc' }] });
  const stage = await db.articleStage.findUnique({ where: { taskId_key: { taskId, key: 'RESEARCH_EVIDENCE' } }, select: { outputJson: true, completedAt: true } });
  const ledger = parseJson<{ ledger?: LedgerSummary }>(stage?.outputJson, {}).ledger ?? null;
  const parsed = claims.map((c) => ({ ...c, values: parseJson(c.values, { dates: [], amounts: [], names: [] }), citations: parseJson<string[]>(c.citations, []), evidence: parseJson<EvidenceEntry[]>(c.evidence, []) }));
  const cited = [...(task.researchNotes ?? '').matchAll(/https?:\/\/[^\s)\]>"'<]+/g)].map((m) => m[0].replace(/[.,;:]+$/, ''));
  const urls = [...new Set([...cited, ...parsed.flatMap((c) => [...c.citations, ...c.evidence.map((e) => e.url)])])];
  const sources = await db.sourceRecord.findMany({ where: { url: { in: urls } }, select: { id: true, url: true, host: true, title: true, status: true, httpStatus: true, detail: true, fetchedAt: true } });
  const { researchNotes: _notes, ...taskInfo } = task;
  return { task: { ...taskInfo, title: task.selectedTitle ?? task.keyword }, claims: parsed, sources, notes: ledger?.notes ?? [], summary: ledger, changes: await changesSinceLastResearch(taskId), researchedAt: claims[0]?.researchedAt ?? null };
}

export const decisionSchema = z
  .object({
    decision: z.enum(['ACCEPTED', 'OMIT', 'CORRECTED']),
    value: z.string().trim().max(300).optional(),
    note: z.string().trim().min(5, 'Add a short note (at least 5 characters) explaining the decision.').max(1000),
  })
  .refine((d) => d.decision !== 'CORRECTED' || Boolean(d.value), { message: 'Give the corrected value.', path: ['value'] });

/** The owner's decision on one claim. The evidence and source links stay in the ledger. */
export async function decideClaim(claimId: string, raw: unknown) {
  const input = decisionSchema.parse(raw);
  const claim = await db.claimEvidence.findUnique({ where: { id: claimId } });
  if (!claim) throw notFound('Claim');
  const updated = await db.claimEvidence.update({ where: { id: claimId }, data: { ownerDecision: input.decision, ownerValue: input.value ?? null, ownerNote: input.note, decidedAt: new Date() } });
  await audit('research.claim-decision', 'ClaimEvidence', claimId, { taskId: claim.taskId, type: claim.claimType, decision: input.decision, value: input.value ?? null });
  return updated;
}

export async function clearDecision(claimId: string) {
  const claim = await db.claimEvidence.findUnique({ where: { id: claimId } });
  if (!claim) throw notFound('Claim');
  await db.claimEvidence.update({ where: { id: claimId }, data: { ownerDecision: null, ownerValue: null, ownerNote: null, decidedAt: null } });
  await audit('research.claim-decision-cleared', 'ClaimEvidence', claimId, { taskId: claim.taskId });
  return { ok: true };
}

/** Re-fetch the cited sources and rebuild the ledger in the worker (decisions on unchanged claims are kept). */
export async function scheduleRecheck(taskId: string) {
  const task = await db.articleTask.findUnique({ where: { id: taskId }, select: { id: true, researchNotes: true } });
  if (!task) throw notFound('Article');
  if (!task.researchNotes) throw notFound('Research notes for this article');
  await enqueue({ queue: 'workflow', kind: 'research.recheck', idempotencyKey: `research-recheck:${taskId}:${Date.now()}`, relatedId: taskId, payload: { taskId } });
  await audit('research.recheck', 'ArticleTask', taskId, {});
  return { ok: true };
}
