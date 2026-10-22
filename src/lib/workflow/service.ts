import { z } from 'zod';
import { db } from '../db';
import { audit } from '../audit';
import { AppError, badRequest, notFound } from '../errors';
import { normalizeKeyword } from '../domain';
import { parseJson } from '../json';
import { parseImport } from '../campaigns/parse';
import { normalizeWriter, parseRoutingRules, resolveWriter } from '../campaigns/router';
import { retryTask } from '../tasks/lifecycle';
import { overrideQuality } from '../tasks/actions';
import { deleteTask } from '../tasks/delete';
import { DEFAULT_SLOT_TIMEZONE, isValidTimeZone, parseSlot, formatSlot, upcomingSlots } from './time';
import { reserveSlot, slotRules, SCHEDULE_LEAD_MS } from './scheduler';
import { normalizeSearchConsoleProperty } from './search-console';

/**
 * Per-website publishing workflow: settings (slots in Asia/Karachi by
 * default), the ordered keyword queue (import, dedupe, corrections) and the
 * calendar. Scheduling itself happens in the scheduler tick + control jobs.
 */

export const workflowSettingsInput = z.object({
  name: z.string().trim().max(80).optional(),
  active: z.boolean(),
  writerPreference: z.enum(['AUTO', 'celebrity-writer', 'tigram-writer']),
  slots: z.array(z.string().max(12)).max(24),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  slotTimezone: z.string().max(64).default(DEFAULT_SLOT_TIMEZONE),
  writeAheadHours: z.number().int().min(0).max(24 * 14),
  maxBacklog: z.number().int().min(1).max(50),
  imagesOverride: z.enum(['inherit', 'on', 'off']),
  requestIndexing: z.boolean(),
  searchConsoleProperty: z.string().trim().max(200).optional(),
  maxRetries: z.number().int().min(0).max(10),
});

export async function getWorkflowForSite(websiteId: string) {
  const site = await db.website.findUnique({ where: { id: websiteId } });
  if (!site) throw notFound('Website');
  const wf = await db.workflow.findFirst({ where: { websiteId }, orderBy: { createdAt: 'asc' } });
  return { site, workflow: wf };
}

export async function saveWorkflow(websiteId: string, raw: unknown) {
  const input = workflowSettingsInput.parse(raw);
  const { site, workflow } = await getWorkflowForSite(websiteId);
  if (!isValidTimeZone(input.slotTimezone)) throw badRequest(`Unknown time zone “${input.slotTimezone}”.`);
  const bad = input.slots.filter((s) => !parseSlot(s));
  if (bad.length) throw badRequest(`Use “h:mm AM/PM” for slots (not: ${bad.join(', ')}).`);
  const slots = [...new Set(input.slots.map((s) => { const p = parseSlot(s)!; return formatSlot(p.hour, p.minute); }))].sort((a, b) => { const pa = parseSlot(a)!; const pb = parseSlot(b)!; return pa.hour * 60 + pa.minute - (pb.hour * 60 + pb.minute); });
  if (input.active && !slots.length) throw badRequest('Add at least one publishing slot before switching the workflow on.');
  const searchConsoleProperty = normalizeSearchConsoleProperty(input.searchConsoleProperty);
  if (input.searchConsoleProperty && !searchConsoleProperty) throw badRequest('Search Console property: use “https://example.com/” (URL prefix) or “sc-domain:example.com” (domain).');
  const data = { name: input.name || `${site.name} workflow`, active: input.active, writerPreference: input.writerPreference, slots: JSON.stringify(slots), weekdays: JSON.stringify([...new Set(input.weekdays)].sort()), slotTimezone: input.slotTimezone, writeAheadHours: input.writeAheadHours, maxBacklog: input.maxBacklog, imagesOverride: input.imagesOverride, requestIndexing: input.requestIndexing, searchConsoleProperty, maxRetries: input.maxRetries };
  const saved = workflow ? await db.workflow.update({ where: { id: workflow.id }, data }) : await db.workflow.create({ data: { websiteId, ...data } });
  await audit('workflow.save', 'Workflow', saved.id, { website: site.name, active: saved.active, slots, writeAheadHours: saved.writeAheadHours });
  return saved;
}

async function ensureWorkflow(websiteId: string) {
  const { site, workflow } = await getWorkflowForSite(websiteId);
  return workflow ?? db.workflow.create({ data: { websiteId, name: `${site.name} workflow` } });
}

export interface KeywordPreview {
  line: number;
  keyword: string;
  secondaryKeywords: string[];
  exampleTitle: string | null;
  writerType: 'CELEBRITY' | 'TIGRAM' | 'UNKNOWN';
  detectionReason: string;
  detectionConfidence: number;
  /** RULE | OVERRIDE | SITE_RULE — where the writer choice came from. */
  detectionSource: string;
  duplicateOf: string | null;
  errors: string[];
}

const typeOf = (w: string | null): KeywordPreview['writerType'] => (w === 'celebrity-writer' ? 'CELEBRITY' : w === 'tigram-writer' ? 'TIGRAM' : 'UNKNOWN');

/** Parse and route keywords for a workflow; flags duplicates of keywords already in it (nothing is written). */
export async function previewKeywords(websiteId: string, text: string) {
  const { site, workflow } = await getWorkflowForSite(websiteId);
  const parsed = parseImport(text);
  const existing = workflow ? await db.workflowKeyword.findMany({ where: { workflowId: workflow.id, status: { notIn: ['SKIPPED', 'FAILED'] } }, select: { keyword: true, normalizedKeyword: true, status: true } }) : [];
  const seen = new Map(existing.map((k) => [k.normalizedKeyword, `${k.keyword} (${k.status.toLowerCase()})`]));
  const rows: KeywordPreview[] = parsed.rows.map((r) => {
    const decision = resolveWriter({ keyword: r.keyword, language: r.language ?? site.language, override: r.writer, siteRules: parseRoutingRules(site.routingRules) });
    const norm = normalizeKeyword(r.keyword);
    const duplicateOf = seen.get(norm) ?? null;
    if (!duplicateOf && r.keyword) seen.set(norm, `${r.keyword} (line ${r.line})`);
    return { line: r.line, keyword: r.keyword, secondaryKeywords: r.secondaryKeywords, exampleTitle: r.exampleTitle, writerType: typeOf(decision.writer), detectionReason: decision.rationale, detectionConfidence: decision.confidence, detectionSource: decision.source, duplicateOf, errors: r.errors };
  });
  return { problems: parsed.problems, rows };
}

/** Append keywords to the workflow queue (duplicates are left out unless `keepDuplicates` lists their lines). */
export async function addKeywords(websiteId: string, raw: unknown) {
  const input = z.object({ text: z.string().max(2_000_000), keepDuplicates: z.array(z.number().int()).default([]) }).parse(raw);
  const preview = await previewKeywords(websiteId, input.text);
  const wf = await ensureWorkflow(websiteId);
  const last = await db.workflowKeyword.findFirst({ where: { workflowId: wf.id }, orderBy: { position: 'desc' }, select: { position: true } });
  let position = last?.position ?? 0;
  const keep = new Set(input.keepDuplicates);
  const rows = preview.rows.filter((r) => !r.errors.length && (!r.duplicateOf || keep.has(r.line)));
  await db.workflowKeyword.createMany({
    data: rows.map((r) => ({
      workflowId: wf.id,
      keyword: r.keyword,
      normalizedKeyword: normalizeKeyword(r.keyword),
      exampleTitle: r.exampleTitle,
      secondaryKeywords: JSON.stringify(r.secondaryKeywords),
      writerType: r.writerType,
      detectionReason: r.detectionReason,
      detectionSource: r.detectionSource,
      detectionConfidence: r.detectionConfidence,
      position: ++position,
    })),
  });
  await audit('workflow.keywords.add', 'Workflow', wf.id, { added: rows.length, skipped: preview.rows.length - rows.length });
  return { added: rows.length, skippedDuplicates: preview.rows.filter((r) => r.duplicateOf && !keep.has(r.line)).length, invalid: preview.rows.filter((r) => r.errors.length).length };
}

export const keywordActionSchema = z.object({
  keywordIds: z.array(z.string().max(40)).min(1).max(500),
  action: z.enum(['writer', 'skip', 'restore', 'top', 'retry', 'force', 'indexing-requested', 'indexed', 'delete']),
  writer: z.string().max(40).optional(),
  /** With “delete”: also delete the keywords' articles from the app (WordPress is never changed). */
  articles: z.boolean().optional(),
});

/**
 * Owner actions on queued keywords. INDEXED is only recorded from the owner's own verification. “delete” removes the
 * keyword rows (and, when asked, their articles from the app); WordPress is never changed.
 */
export async function keywordAction(websiteId: string, raw: unknown) {
  const input = keywordActionSchema.parse(raw);
  const wf = await ensureWorkflow(websiteId);
  const rows = await db.workflowKeyword.findMany({ where: { workflowId: wf.id, id: { in: input.keywordIds } } });
  let changed = 0;
  const notes: string[] = [];
  for (const kw of rows) {
    switch (input.action) {
      case 'writer': {
        const w = normalizeWriter(input.writer);
        if (!w) throw badRequest('Choose the Celebrity Article Writer or the Tigram Article Writer.');
        if (kw.status !== 'WAITING') {
          notes.push(`“${kw.keyword}” already started; its writer stays as approved.`);
          continue;
        }
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { writerType: typeOf(w), detectionSource: 'OVERRIDE', detectionReason: 'Chosen by you.', detectionConfidence: 1, lastError: null } });
        break;
      }
      case 'skip':
        if (!['WAITING', 'FAILED'].includes(kw.status)) {
          notes.push(`“${kw.keyword}” is ${kw.status.toLowerCase()}; cancel its article first.`);
          continue;
        }
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'SKIPPED' } });
        break;
      case 'restore':
        if (kw.status !== 'SKIPPED') continue;
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: kw.taskId ? 'FAILED' : 'WAITING', lastError: null } });
        break;
      case 'top': {
        const first = await db.workflowKeyword.findFirst({ where: { workflowId: wf.id }, orderBy: { position: 'asc' }, select: { position: true } });
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { position: (first?.position ?? 1) - 1 } });
        break;
      }
      case 'retry':
        if (kw.status !== 'FAILED') continue;
        if (kw.taskId) {
          const task = await db.articleTask.findUnique({ where: { id: kw.taskId } });
          // A saved draft with serious problems would stop at once again (owner report): that needs Force continue.
          if (task?.status === 'COMPLETED' && parseJson<{ publishBlocked?: string[] }>(task.options, {}).publishBlocked?.length) {
            notes.push(`“${kw.keyword}”: its draft is saved but has serious problems, so Retry would stop again. Use Force continue to publish it at the next free slot anyway.`);
            continue;
          }
          if (task && ['FAILED', 'NEEDS_REVIEW', 'CANCELLED'].includes(task.status)) await retryTask(task.id);
        }
        // Back into the queue with a fresh retry budget and the next free slot.
        if (kw.taskId) {
          const at = await reserveSlot({ ...wf, website: (await db.website.findUniqueOrThrow({ where: { id: websiteId } })) }, kw.id, new Date(Date.now() + SCHEDULE_LEAD_MS));
          await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'WRITING', retries: 0, lastError: at ? null : 'No free slot found; add slots to the workflow.', scheduledAt: at } });
        } else {
          await db.slotReservation.deleteMany({ where: { workflowKeywordId: kw.id } });
          await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'WAITING', retries: 0, lastError: null, scheduledAt: null } });
        }
        break;
      case 'force': {
        // Owner request: “Force continue” — the owner accepts the problems the quality gate found (audited, one keyword
        // at a time) and the article goes on: a saved draft is published at the next free slot like any other; an
        // article held for review gets “Approve despite review reasons”. Publishing permission is still required.
        if (kw.status !== 'FAILED' || !kw.taskId) {
          notes.push(`“${kw.keyword}” is not stopped by a problem; nothing to force.`);
          continue;
        }
        const task = await db.articleTask.findUnique({ where: { id: kw.taskId } });
        const options = parseJson<Record<string, unknown> & { publishBlocked?: string[] }>(task?.options ?? null, {});
        if (task?.status === 'COMPLETED' && task.wpPostId && options.publishBlocked?.length) {
          const { publishBlocked, ...rest } = options;
          const reason = 'Force continue from the workflow keyword queue';
          await db.articleTask.update({ where: { id: task.id }, data: { options: JSON.stringify({ ...rest, publishForced: { at: new Date().toISOString(), problems: publishBlocked }, ...(rest.duplicateOverride ? {} : { duplicateOverride: { reason, at: new Date().toISOString() } }) }) } });
          await db.duplicateMatch.updateMany({ where: { taskId: task.id, status: 'OPEN' }, data: { status: 'OVERRIDDEN' } });
          await audit('task.force-continue', 'ArticleTask', task.id, { keyword: kw.keyword, wpPostId: task.wpPostId, problems: publishBlocked });
        } else if (task?.status === 'NEEDS_REVIEW') {
          await overrideQuality(task.id, { reason: 'Force continue from the workflow keyword queue' });
        } else {
          notes.push(`“${kw.keyword}”: its article failed (${(task?.message ?? 'no article').slice(0, 120)}). Use Retry.`);
          continue;
        }
        const at = await reserveSlot({ ...wf, website: await db.website.findUniqueOrThrow({ where: { id: websiteId } }) }, kw.id, new Date(Date.now() + SCHEDULE_LEAD_MS));
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'WRITING', retries: 0, lastError: at ? 'Forced by you: continues despite the problems found.' : 'No free slot found; add slots to the workflow.', scheduledAt: at } });
        break;
      }
      case 'indexing-requested':
        if (!['PUBLISHED', 'INDEXING_REQUESTED'].includes(kw.status)) {
          notes.push(`“${kw.keyword}” is not published yet.`);
          continue;
        }
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'INDEXING_REQUESTED', indexingRequestedAt: new Date(), indexingStatus: 'Requested by you in Search Console (a request is not evidence of indexing).' } });
        break;
      case 'indexed':
        if (!['PUBLISHED', 'INDEXING_REQUESTED'].includes(kw.status)) {
          notes.push(`“${kw.keyword}” is not published yet.`);
          continue;
        }
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'INDEXED', indexingStatus: `Verified as indexed by you on ${new Date().toISOString().slice(0, 10)}.` } });
        break;
      case 'delete': {
        const task = kw.taskId ? await db.articleTask.findUnique({ where: { id: kw.taskId }, select: { id: true } }) : null;
        if (task && input.articles) {
          const r = await deleteTask(task.id);
          if (r.status === 'deleting') notes.push(`“${kw.keyword}”: its article is running and is deleted as soon as it stops.`);
        } else if (task && kw.status === 'WRITING') {
          notes.push(`“${kw.keyword}”: its article keeps running as a normal article (not in the workflow any more).`);
        }
        await db.slotReservation.deleteMany({ where: { workflowKeywordId: kw.id } });
        await db.workflowKeyword.deleteMany({ where: { id: kw.id } });
        break;
      }
    }
    changed++;
  }
  await audit('workflow.keywords.action', 'Workflow', wf.id, { action: input.action, keywords: input.keywordIds.length, changed });
  return { ok: true, changed, notes };
}

export async function workflowView(websiteId: string) {
  const { site, workflow } = await getWorkflowForSite(websiteId);
  const keywords = workflow ? await db.workflowKeyword.findMany({ where: { workflowId: workflow.id }, orderBy: [{ position: 'asc' }] }) : [];
  const tasks = keywords.some((k) => k.taskId) ? await db.articleTask.findMany({ where: { id: { in: keywords.map((k) => k.taskId).filter((x): x is string => Boolean(x)) } }, select: { id: true, status: true, wpPostId: true, wpEditUrl: true } }) : [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const nextSlots = workflow ? upcomingSlots(slotRules(workflow), new Date(), 7).slice(0, 8) : [];
  return {
    website: { id: site.id, name: site.name, timezone: site.timezone, canPublish: site.canPublish && Boolean(site.canPublishAcknowledgedAt), publicUrl: site.publicUrl },
    workflow: workflow ? { ...workflow, slots: parseJson<string[]>(workflow.slots, []), weekdays: parseJson<number[]>(workflow.weekdays, []) } : null,
    nextSlots,
    keywords: keywords.map((k) => ({ ...k, secondaryKeywords: parseJson<string[]>(k.secondaryKeywords, []), task: k.taskId ? (byId.get(k.taskId) ?? null) : null })),
  };
}

/** Calendar: reserved slots (with their keyword) and free upcoming slots of active workflows, in a UTC range. */
export async function calendar(fromIso: string, days: number) {
  const from = new Date(fromIso);
  if (Number.isNaN(from.getTime())) throw new AppError(400, 'VALIDATION', 'Invalid start date.');
  const to = new Date(from.getTime() + Math.min(62, Math.max(1, days)) * 86_400_000);
  const workflows = await db.workflow.findMany({ include: { website: { select: { id: true, name: true, timezone: true, canPublish: true, canPublishAcknowledgedAt: true } } } });
  const keywords = await db.workflowKeyword.findMany({ where: { scheduledAt: { gte: from, lt: to }, workflowId: { in: workflows.map((w) => w.id) } } });
  const entries: { at: string; websiteId: string; website: string; keywordId: string | null; keyword: string | null; status: string; taskId: string | null; publishedUrl: string | null }[] = [];
  for (const kw of keywords) {
    const wf = workflows.find((w) => w.id === kw.workflowId)!;
    entries.push({ at: kw.scheduledAt!.toISOString(), websiteId: wf.websiteId, website: wf.website.name, keywordId: kw.id, keyword: kw.keyword, status: kw.status, taskId: kw.taskId, publishedUrl: kw.publishedUrl });
  }
  for (const wf of workflows.filter((w) => w.active)) {
    const taken = new Set(keywords.filter((k) => k.workflowId === wf.id).map((k) => k.scheduledAt!.getTime()));
    for (const at of upcomingSlots(slotRules(wf), from > new Date() ? from : new Date(), Math.ceil((to.getTime() - from.getTime()) / 86_400_000))) {
      if (at >= to || taken.has(at.getTime())) continue;
      entries.push({ at: at.toISOString(), websiteId: wf.websiteId, website: wf.website.name, keywordId: null, keyword: null, status: 'FREE', taskId: null, publishedUrl: null });
    }
  }
  entries.sort((a, b) => a.at.localeCompare(b.at) || a.website.localeCompare(b.website));
  return { from: from.toISOString(), to: to.toISOString(), timezone: DEFAULT_SLOT_TIMEZONE, entries, sites: workflows.map((w) => ({ id: w.websiteId, name: w.website.name, active: w.active, publishing: w.website.canPublish && Boolean(w.website.canPublishAcknowledgedAt) })) };
}
