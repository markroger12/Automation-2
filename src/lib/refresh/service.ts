import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { AppError, badRequest, notFound } from '@/lib/errors';
import { audit } from '@/lib/audit';
import { enqueue } from '@/lib/queue';
import { parseJson } from '@/lib/json';
import { log } from '@/lib/log';
import { sanitizeArticleHtml } from '@/lib/html/sanitize';
import { getSource } from '@/lib/research/ledger';
import { compareVersions } from '@/wordpress/compare';
import { searchPerformance } from '@/lib/search-performance/service';
import { externalLinks, needsRefresh, outdatedYears, priorityOf, unlinkUrls, type RefreshReason } from './signals';

/**
 * Auto Content Refresh (upgrade 11). Evaluation is read-only: it records
 * RefreshCandidates with reasons and evidence. A ContentRevision is a
 * separate proposal that the owner edits and approves; only an approved
 * revision is written to WordPress (control job `wp.refresh-apply`), to the SAME
 * post, content only. Live (published/scheduled) posts additionally need the
 * site's “approved updates to live posts” switch. Nothing is changed
 * silently, and the article's local text changes only after WordPress
 * confirmed the update.
 */

export const REFRESH_AGE_MONTHS = 12;
const LINKS_PER_ARTICLE = 15;
const LINKS_PER_RUN = 200;
export const LIVE_ACK_PHRASE = 'UPDATE LIVE POST';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const articleHtml = (t: { editedHtml: string | null; assembledHtml: string | null }) => t.editedHtml ?? t.assembledHtml ?? '';
const signatureOf = (reasons: RefreshReason[]) => sha(JSON.stringify(reasons.map((r) => [r.code, r.evidence]).sort()));

export interface EvaluationResult {
  evaluated: number;
  open: number;
  created: number;
  resolved: number;
  notes: string[];
}

/** Evaluate every verified app article of a website (non-destructive). */
export async function evaluateRefresh(websiteId: string, now = new Date()): Promise<EvaluationResult> {
  const site = await db.website.findUnique({ where: { id: websiteId } });
  if (!site) throw notFound('Website');
  const tasks = await db.articleTask.findMany({
    where: { websiteId, legacy: false, status: 'COMPLETED', wpPostId: { not: null } },
    select: { id: true, keyword: true, selectedTitle: true, editedHtml: true, assembledHtml: true, wpPostId: true, wpEditUrl: true, verifiedCompleteAt: true, wpDraftAt: true, createdAt: true },
  });
  const notes: string[] = [];
  const host = new URL(site.publicUrl).hostname;

  // Links: one check per URL (7-day cache shared with Research Evidence).
  const linksByTask = new Map(tasks.map((t) => [t.id, externalLinks(articleHtml(t), host).slice(0, LINKS_PER_ARTICLE)]));
  const unique = [...new Set([...linksByTask.values()].flat().map((l) => l.url))].slice(0, LINKS_PER_RUN);
  const sources = new Map<string, { status: string; httpStatus: number | null; detail: string | null }>();
  for (const url of unique) {
    const s = await getSource(url, now);
    sources.set(url, { status: s.status, httpStatus: s.httpStatus, detail: s.detail });
  }
  // A missing domain only counts as a dead link when other links answered (otherwise the computer may be offline).
  const online = [...sources.values()].some((s) => s.httpStatus != null);
  if (unique.length && !online) notes.push(`None of the ${unique.length} linked page(s) answered; dead-link checks were skipped (no internet connection?).`);
  const deadOf = (url: string) => {
    const s = sources.get(url);
    if (!s || s.status !== 'DEAD') return null;
    if (s.httpStatus === 404 || s.httpStatus === 410) return `HTTP ${s.httpStatus}`;
    if (s.httpStatus == null && online && /dns|not found|ENOTFOUND/i.test(s.detail ?? '')) return 'the domain no longer resolves';
    return null;
  };

  // Search performance, only when real data was imported.
  const declining = new Map<string, string>();
  const zero = new Map<string, string>();
  try {
    const sp = await searchPerformance(websiteId);
    if (sp.state === 'DATA') {
      for (const d of sp.declining) if (d.taskId) declining.set(d.taskId, `${d.clicks} clicks vs ${d.prevClicks} before (${d.changePct} %, compared with the ${d.basis})`);
      for (const z of sp.zero) zero.set(z.taskId, z.detail);
    }
  } catch (error) {
    notes.push(`Search data not used: ${(error as Error).message}`);
  }

  const live = new Map((await db.linkTarget.findMany({ where: { websiteId, status: 'ACTIVE' }, select: { wpPostId: true, url: true } })).map((t) => [t.wpPostId, t.url]));
  const ageCutoff = new Date(now);
  ageCutoff.setUTCMonth(ageCutoff.getUTCMonth() - REFRESH_AGE_MONTHS);
  let created = 0;
  let resolved = 0;
  let open = 0;
  for (const t of tasks) {
    const html = articleHtml(t);
    const title = t.selectedTitle ?? t.keyword;
    const reasons: RefreshReason[] = [...outdatedYears(html, title, now)];
    for (const l of linksByTask.get(t.id) ?? []) {
      const dead = deadOf(l.url);
      if (dead) reasons.push({ code: 'BROKEN_LINK', detail: `The link “${l.text || l.url}” is dead (${dead}).`, evidence: l.url });
    }
    const contradicted = await db.claimEvidence.findMany({ where: { taskId: t.id, status: 'CONTRADICTED', highImpact: true, ownerDecision: null, articleParagraph: { not: null } }, take: 5 });
    for (const c of contradicted) {
      const ev = parseJson<{ verdict?: string; url?: string; excerpt?: string }[]>(c.evidence, []).find((e) => e.verdict === 'CONTRADICTS');
      reasons.push({ code: 'FACTS_CHANGED', detail: `A source now contradicts: “${c.claimText.slice(0, 160)}”.`, evidence: ev ? `${ev.url ?? ''} — ${ev.excerpt ?? ''}`.slice(0, 400) : c.claimText.slice(0, 200) });
    }
    if (declining.has(t.id)) reasons.push({ code: 'DECLINING_TRAFFIC', detail: 'Search clicks fell.', evidence: declining.get(t.id)! });
    if (zero.has(t.id)) reasons.push({ code: 'ZERO_IMPRESSIONS', detail: 'The published post gets no search impressions.', evidence: zero.get(t.id)! });
    const written = t.verifiedCompleteAt ?? t.wpDraftAt ?? t.createdAt;
    if (written < ageCutoff) reasons.push({ code: 'AGE', detail: `Written ${written.toISOString().slice(0, 10)} (over ${REFRESH_AGE_MONTHS} months ago).`, evidence: written.toISOString() });

    const existing = await db.refreshCandidate.findFirst({ where: { taskId: t.id, status: { in: ['OPEN', 'REVISION', 'DISMISSED'] } }, orderBy: { createdAt: 'desc' } });
    const signature = signatureOf(reasons);
    if (!needsRefresh(reasons)) {
      if (existing && existing.status === 'OPEN') {
        await db.refreshCandidate.update({ where: { id: existing.id }, data: { status: 'RESOLVED', reasons: JSON.stringify(reasons), evaluatedAt: now, note: 'No reason left at the last evaluation.' } });
        resolved++;
      }
      continue;
    }
    const data = { reasons: JSON.stringify(reasons), priority: priorityOf(reasons), signature, evaluatedAt: now, live: live.has(t.wpPostId!), url: live.get(t.wpPostId!) ?? null, title };
    if (existing?.status === 'DISMISSED' && existing.signature === signature) continue; // the owner already decided on exactly this evidence
    if (existing && existing.status !== 'DISMISSED') await db.refreshCandidate.update({ where: { id: existing.id }, data });
    else {
      await db.refreshCandidate.create({ data: { ...data, websiteId, taskId: t.id, wpPostId: t.wpPostId, status: 'OPEN' } });
      created++;
    }
    open++;
  }
  await log({ category: 'refresh', message: `${site.name}: refresh evaluation — ${tasks.length} article(s), ${open} need a refresh (${created} new), ${resolved} resolved.${notes.length ? ` ${notes.join(' ')}` : ''}` });
  return { evaluated: tasks.length, open, created, resolved, notes };
}

/** Once a day per active website with verified articles (idempotent per UTC day; enqueues only). */
export async function scheduleDailyEvaluations(now = new Date()): Promise<number> {
  const day = now.toISOString().slice(0, 10);
  const sites = await db.website.findMany({ where: { active: true, paused: false, tasks: { some: { status: 'COMPLETED', wpPostId: { not: null }, legacy: false } } }, select: { id: true } });
  let queued = 0;
  for (const s of sites) {
    const { created } = await enqueue({ queue: 'workflow', kind: 'refresh.evaluate', websiteId: s.id, idempotencyKey: `refresh.evaluate:${s.id}:${day}`, payload: { websiteId: s.id }, maxAttempts: 2 });
    if (created) queued++;
  }
  return queued;
}

export async function requestEvaluation(websiteId: string) {
  if (!(await db.website.findUnique({ where: { id: websiteId }, select: { id: true } }))) throw notFound('Website');
  const n = await db.queueJob.count({ where: { kind: 'refresh.evaluate', websiteId } });
  const { job, created } = await enqueue({ queue: 'workflow', kind: 'refresh.evaluate', websiteId, idempotencyKey: `refresh.evaluate:${websiteId}:manual:${n + 1}`, payload: { websiteId }, maxAttempts: 2 });
  return { jobId: job.id, created };
}

export async function listRefreshCandidates(filter: { websiteId?: string | null; status?: string | null } = {}) {
  const rows = await db.refreshCandidate.findMany({
    where: { ...(filter.websiteId ? { websiteId: filter.websiteId } : {}), status: filter.status ? filter.status : { in: ['OPEN', 'REVISION'] } },
    orderBy: [{ priority: 'desc' }, { evaluatedAt: 'desc' }],
    take: 200,
    include: { website: { select: { id: true, name: true, allowLiveUpdates: true } }, revisions: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true } } },
  });
  return rows.map((r) => ({ ...r, reasons: parseJson<RefreshReason[]>(r.reasons, []) }));
}

export async function getRefreshCandidate(id: string) {
  const c = await db.refreshCandidate.findUnique({ where: { id }, include: { website: { select: { id: true, name: true, allowLiveUpdates: true, canPublish: true } }, task: { select: { id: true, keyword: true, selectedTitle: true, wpPostId: true, wpEditUrl: true, editedHtml: true, assembledHtml: true } }, revisions: { orderBy: { createdAt: 'desc' } } } });
  if (!c) throw notFound('Refresh candidate');
  return {
    ...c,
    reasons: parseJson<RefreshReason[]>(c.reasons, []),
    revisions: c.revisions.map((r) => ({ ...r, changes: parseJson<{ kind: string; detail: string }[]>(r.changes, []), result: parseJson<Record<string, unknown>>(r.result, {}), comparison: compareVersions(r.baseHtml, r.proposedHtml) })),
  };
}

export async function dismissCandidate(id: string, note: string) {
  const c = await db.refreshCandidate.findUnique({ where: { id } });
  if (!c) throw notFound('Refresh candidate');
  if (note.trim().length < 5) throw badRequest('Say in a few words why this article needs no refresh (at least 5 characters).');
  await db.refreshCandidate.update({ where: { id }, data: { status: 'DISMISSED', note: note.trim().slice(0, 500) } });
  await audit('refresh.dismiss', 'RefreshCandidate', id, { note: note.trim().slice(0, 500) });
  return { ok: true };
}

/** A proposal from the article's current text: dead links removed (their words kept); everything else is for the owner to edit. */
export async function proposeRevision(candidateId: string) {
  const c = await db.refreshCandidate.findUnique({ where: { id: candidateId }, include: { task: true } });
  if (!c || !c.task) throw notFound('Refresh candidate');
  if (!['OPEN', 'REVISION'].includes(c.status)) throw new AppError(409, 'CONFLICT', `This candidate is ${c.status.toLowerCase()}.`);
  const open = await db.contentRevision.findFirst({ where: { candidateId, status: { in: ['PROPOSED', 'APPROVED', 'APPLYING'] } } });
  if (open) return { revision: open, created: false };
  const base = articleHtml(c.task);
  const reasons = parseJson<RefreshReason[]>(c.reasons, []);
  const dead = reasons.filter((r) => r.code === 'BROKEN_LINK').map((r) => r.evidence);
  const fixed = unlinkUrls(base, dead);
  const changes = [
    ...fixed.removed.map((r) => ({ kind: 'LINK_REMOVED', detail: `Removed the dead link to ${r.url}; the words “${r.text}” stay.` })),
    ...reasons.filter((r) => r.code === 'OUTDATED_YEAR' || r.code === 'FACTS_CHANGED').map((r) => ({ kind: 'TO_EDIT', detail: `${r.detail} Edit the text below (not changed automatically).` })),
  ];
  const revision = await db.contentRevision.create({
    data: { candidateId, taskId: c.task.id, websiteId: c.websiteId, wpPostId: c.task.wpPostId, kind: 'REFRESH', source: 'AUTOMATIC', status: 'PROPOSED', baseHtml: base, baseHash: sha(base), proposedHtml: fixed.html, changes: JSON.stringify(changes) },
  });
  await db.refreshCandidate.update({ where: { id: candidateId }, data: { status: 'REVISION' } });
  await audit('refresh.propose', 'ContentRevision', revision.id, { candidateId, automaticChanges: fixed.removed.length });
  return { revision, created: true };
}

export async function updateRevision(id: string, html: string, note?: string | null) {
  const r = await db.contentRevision.findUnique({ where: { id } });
  if (!r) throw notFound('Revision');
  if (r.status !== 'PROPOSED') throw new AppError(409, 'CONFLICT', `Only a proposed revision can be edited (this one is ${r.status.toLowerCase()}).`);
  const clean = sanitizeArticleHtml(html);
  if (!clean.trim()) throw badRequest('The revised article is empty.');
  await db.contentRevision.update({ where: { id }, data: { proposedHtml: clean, source: 'OWNER', note: note?.trim().slice(0, 500) || r.note } });
  return { ok: true, changed: clean !== r.baseHtml };
}

export async function rejectRevision(id: string) {
  const r = await db.contentRevision.findUnique({ where: { id } });
  if (!r) throw notFound('Revision');
  if (!['PROPOSED', 'APPROVED', 'CONFLICT', 'BLOCKED', 'FAILED'].includes(r.status)) throw new AppError(409, 'CONFLICT', `This revision is ${r.status.toLowerCase()}.`);
  await db.contentRevision.update({ where: { id }, data: { status: 'REJECTED' } });
  await db.queueJob.updateMany({ where: { kind: 'wp.refresh-apply', relatedId: id, status: 'WAITING' }, data: { status: 'CANCELLED', finishedAt: new Date() } });
  if (r.candidateId) await db.refreshCandidate.updateMany({ where: { id: r.candidateId, status: 'REVISION' }, data: { status: 'OPEN' } });
  await audit('refresh.reject', 'ContentRevision', id, {});
  return { ok: true };
}

/**
 * Approve → the worker writes it to the same WordPress post. A live post
 * needs the site's live-update switch AND the typed acknowledgement.
 */
export async function approveRevision(id: string, acknowledgement?: string | null) {
  const r = await db.contentRevision.findUnique({ where: { id }, include: { candidate: true } });
  if (!r) throw notFound('Revision');
  if (!['PROPOSED', 'CONFLICT', 'FAILED', 'APPROVED'].includes(r.status)) throw new AppError(409, 'CONFLICT', `This revision is ${r.status.toLowerCase()}.`);
  // “Try again” after a failed attempt; never while an update for it is queued or running.
  if (r.status === 'APPROVED' && (await db.queueJob.count({ where: { kind: 'wp.refresh-apply', relatedId: id, status: { in: ['WAITING', 'ACTIVE'] } } }))) {
    throw new AppError(409, 'BUSY', 'The update of this revision is already queued or running.');
  }
  if (r.proposedHtml === r.baseHtml) throw badRequest('The revision changes nothing yet. Edit the text first.');
  const site = await db.website.findUniqueOrThrow({ where: { id: r.websiteId } });
  const task = await db.articleTask.findUniqueOrThrow({ where: { id: r.taskId } });
  if (sha(articleHtml(task)) !== r.baseHash) throw new AppError(409, 'STALE', 'The article changed after this revision was proposed. Reject it and propose a new one from the current text.');
  const live = r.candidate?.live ?? false;
  if (live) {
    if (!site.allowLiveUpdates) throw new AppError(409, 'LIVE_LOCKED', `This post is live. ${site.name} does not allow updates to live posts (Websites → ${site.name} → Publishing permission).`);
    if (acknowledgement !== LIVE_ACK_PHRASE) throw new AppError(400, 'ACK_REQUIRED', `Type "${LIVE_ACK_PHRASE}" to update the live post.`);
  }
  await db.contentRevision.update({ where: { id }, data: { status: 'APPROVED', approvedAt: new Date(), result: '{}' } });
  // WordPress work runs on the control queue (one browser session per site at a time).
  const n = await db.queueJob.count({ where: { kind: 'wp.refresh-apply', relatedId: id } });
  await enqueue({ queue: 'control', kind: 'wp.refresh-apply', websiteId: r.websiteId, taskId: r.taskId, relatedId: id, idempotencyKey: `wp.refresh-apply:${id}:${n + 1}`, payload: { revisionId: id }, maxAttempts: 3 });
  await audit('refresh.approve', 'ContentRevision', id, { live, wpPostId: r.wpPostId });
  return { ok: true, live };
}

/** Undo an applied revision: a new proposal that restores the text before it (approved and applied like any other). */
export async function rollbackRevision(id: string) {
  const r = await db.contentRevision.findUnique({ where: { id } });
  if (!r) throw notFound('Revision');
  if (r.status !== 'APPLIED') throw new AppError(409, 'CONFLICT', 'Only an applied revision can be rolled back.');
  const task = await db.articleTask.findUniqueOrThrow({ where: { id: r.taskId } });
  const current = articleHtml(task);
  const revision = await db.contentRevision.create({
    data: { candidateId: r.candidateId, taskId: r.taskId, websiteId: r.websiteId, wpPostId: r.wpPostId, kind: 'ROLLBACK', source: 'OWNER', status: 'PROPOSED', baseHtml: current, baseHash: sha(current), proposedHtml: r.baseHtml, changes: JSON.stringify([{ kind: 'ROLLBACK', detail: `Restores the text before revision ${r.id} (applied ${r.appliedAt?.toISOString() ?? ''}).` }]) },
  });
  await audit('refresh.rollback.propose', 'ContentRevision', revision.id, { of: r.id });
  return { revision };
}

export { sha as refreshHash, articleHtml as refreshArticleHtml };
