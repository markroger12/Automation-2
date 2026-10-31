import { z } from 'zod';
import { Prisma } from '@prisma/client';
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
import { DEFAULT_SLOT_TIMEZONE, formatInZone, isValidTimeZone, parseSlot, formatSlot, upcomingSlots, zonedParts, zonedTimeToUtc } from './time';
import { reserveSlot, slotRules, SCHEDULE_LEAD_MS } from './scheduler';
import { enqueue } from '../queue';
import { normalizeSearchConsoleProperty } from './search-console';
import { proofsFor } from '../gsc/proof';
import { requestIndexingNow, requestProperty } from '../gsc/request-indexing';

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

/**
 * Append keywords to the workflow queue (duplicates are left out unless `keepDuplicates` lists their lines).
 * `writers` (owner request: choose the writer right in Add keywords) sets a line's writer, by line number.
 */
export async function addKeywords(websiteId: string, raw: unknown) {
  const input = z
    .object({
      text: z.string().max(2_000_000),
      keepDuplicates: z.array(z.number().int()).default([]),
      writers: z.record(z.string().regex(/^\d+$/), z.enum(['CELEBRITY', 'TIGRAM', 'UNKNOWN'])).default({}),
    })
    .parse(raw);
  const preview = await previewKeywords(websiteId, input.text);
  const wf = await ensureWorkflow(websiteId);
  const last = await db.workflowKeyword.findFirst({ where: { workflowId: wf.id }, orderBy: { position: 'desc' }, select: { position: true } });
  let position = last?.position ?? 0;
  const keep = new Set(input.keepDuplicates);
  const rows = preview.rows.filter((r) => !r.errors.length && (!r.duplicateOf || keep.has(r.line)));
  await db.workflowKeyword.createMany({
    data: rows.map((r) => {
      // The owner's choice in Add keywords wins over the detection; “choose later” keeps the line undecided.
      const chosen = input.writers[String(r.line)];
      const writer = chosen && chosen !== r.writerType ? { writerType: chosen, detectionReason: chosen === 'UNKNOWN' ? 'Left for you to choose.' : 'Chosen by you.', detectionSource: 'OVERRIDE', detectionConfidence: 1 } : null;
      return {
        workflowId: wf.id,
        keyword: r.keyword,
        normalizedKeyword: normalizeKeyword(r.keyword),
        exampleTitle: r.exampleTitle,
        secondaryKeywords: JSON.stringify(r.secondaryKeywords),
        writerType: writer?.writerType ?? r.writerType,
        detectionReason: writer?.detectionReason ?? r.detectionReason,
        detectionSource: writer?.detectionSource ?? r.detectionSource,
        detectionConfidence: writer?.detectionConfidence ?? r.detectionConfidence,
        position: ++position,
      };
    }),
  });
  await audit('workflow.keywords.add', 'Workflow', wf.id, { added: rows.length, skipped: preview.rows.length - rows.length });
  return { added: rows.length, skippedDuplicates: preview.rows.filter((r) => r.duplicateOf && !keep.has(r.line)).length, invalid: preview.rows.filter((r) => r.errors.length).length };
}

export const keywordActionSchema = z.object({
  keywordIds: z.array(z.string().max(40)).min(1).max(500),
  action: z.enum(['writer', 'skip', 'restore', 'top', 'retry', 'force', 'request-indexing', 'indexing-requested', 'indexed', 'delete', 'move']),
  writer: z.string().max(40).optional(),
  /** With “delete”: also delete the keywords' articles from the app (WordPress is never changed). */
  articles: z.boolean().optional(),
  /** With “move”: the day (YYYY-MM-DD, in the workflow's slot time zone) and whether only to preview the new slots. */
  date: z.string().max(10).optional(),
  dryRun: z.boolean().optional(),
});

/** A scheduled post closer than this to its time is left to WordPress: changing it might race WordPress publishing it. */
export const MOVE_MARGIN_MS = 10 * 60_000;
const MOVABLE = ['WAITING', 'WRITING', 'READY', 'SCHEDULED'];
const MOVE_DAYS = 60;
const STATUS_WORD: Record<string, string> = { PUBLISHED: 'published', INDEXING_REQUESTED: 'published', INDEXED: 'published', DONE: 'finished', FAILED: 'stopped (use Retry)', SKIPPED: 'skipped' };

export interface MovePlan {
  id: string;
  keyword: string;
  status: string;
  from: string | null;
  to: string;
}

/**
 * Owner request (one keyword had moved to tomorrow: “I want all of them on tomorrow”): the selected keywords take the
 * free slots of the chosen day, in queue order, spilling into the next days when that day is full. The slots of the
 * keywords being moved count as free, so they can swap. A post already scheduled in WordPress goes back to READY and is
 * scheduled again for its new slot through the approved path (withPublishPermit, read back). A keyword not started
 * yet keeps the slot as its planned slot and starts within the write-ahead time before it. A move by the owner is not
 * counted against the automatic moves (maxRetries). Published keywords are never moved.
 */
export async function moveKeywords(websiteId: string, raw: unknown, now = new Date()): Promise<{ ok: true; changed: number; plan: MovePlan[]; notes: string[] }> {
  const input = z.object({ keywordIds: z.array(z.string().max(40)).min(1).max(500), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Choose a day.'), dryRun: z.boolean().default(false) }).parse(raw);
  const wf = await ensureWorkflow(websiteId);
  const site = await db.website.findUniqueOrThrow({ where: { id: websiteId } });
  const rules = slotRules(wf);
  if (!rules.slots.length) throw badRequest('Add publishing slots to the workflow first (Settings).');
  const [y, m, d] = input.date.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) throw badRequest(`${input.date} is not a day.`);
  const today = zonedParts(now, rules.timezone);
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  if (check.getTime() < todayUtc) throw badRequest('Choose today or a later day.');
  if (check.getTime() > todayUtc + MOVE_DAYS * 86_400_000) throw badRequest(`Choose a day within the next ${MOVE_DAYS} days.`);
  const from = new Date(Math.max(zonedTimeToUtc(y, m, d, 0, 0, rules.timezone).getTime(), now.getTime() + SCHEDULE_LEAD_MS));
  const publishing = site.canPublish && Boolean(site.canPublishAcknowledgedAt);
  const rows = await db.workflowKeyword.findMany({ where: { workflowId: wf.id, id: { in: input.keywordIds } }, orderBy: { position: 'asc' } });
  const notes: string[] = [];
  const moving = rows.filter((kw) => {
    if (!MOVABLE.includes(kw.status)) {
      notes.push(`“${kw.keyword}” is ${STATUS_WORD[kw.status] ?? kw.status.toLowerCase()}; only keywords not published yet can be moved.`);
      return false;
    }
    if (kw.status === 'SCHEDULED' && !publishing) {
      notes.push(`“${kw.keyword}” is scheduled in WordPress, but publishing is now off for this website, so the app cannot change its time there. Change it in WordPress.`);
      return false;
    }
    if (kw.status === 'SCHEDULED' && (!kw.scheduledAt || kw.scheduledAt.getTime() - now.getTime() < MOVE_MARGIN_MS)) {
      notes.push(`“${kw.keyword}”: WordPress publishes it at ${kw.scheduledAt ? formatInZone(kw.scheduledAt, rules.timezone) : 'its time'}, too soon to move safely.`);
      return false;
    }
    return true;
  });
  const ids = new Set(moving.map((k) => k.id));
  const slots = upcomingSlots(rules, from, MOVE_DAYS + 7);
  const taken = new Set(
    slots.length
      ? (await db.slotReservation.findMany({ where: { websiteId, scheduledAt: { gte: slots[0], lte: slots[slots.length - 1] } } })).filter((r) => !ids.has(r.workflowKeywordId)).map((r) => r.scheduledAt.getTime())
      : [],
  );
  const free = slots.filter((s) => !taken.has(s.getTime()));
  if (free.length < moving.length) throw badRequest(`Only ${free.length} free slot(s) from ${input.date} on; add slots or move fewer keywords.`);
  const plan: MovePlan[] = moving.map((kw, i) => ({ id: kw.id, keyword: kw.keyword, status: kw.status, from: kw.scheduledAt?.toISOString() ?? null, to: free[i].toISOString() }));
  if (input.dryRun || !plan.length) return { ok: true, changed: 0, plan, notes };

  try {
    await db.$transaction(async (tx) => {
      await tx.slotReservation.deleteMany({ where: { workflowKeywordId: { in: [...ids] } } });
      for (const p of plan) {
        const kw = moving.find((k) => k.id === p.id)!;
        const at = new Date(p.to);
        await tx.slotReservation.create({ data: { websiteId, scheduledAt: at, workflowKeywordId: p.id } });
        // An earlier automatic-move note no longer applies; other notes (waiting for you, forced) stay.
        const lastError = kw.status === 'SCHEDULED' ? 'Moved by you: its time in WordPress is being changed to the new slot.' : kw.lastError && /Moved to the next free slot\.$/.test(kw.lastError) ? null : kw.lastError;
        await tx.workflowKeyword.update({ where: { id: p.id }, data: { scheduledAt: at, lastError, ...(kw.status === 'SCHEDULED' ? { status: 'READY' } : {}) } });
      }
    });
  } catch (error) {
    // The worker took one of the free slots meanwhile: the whole move was rolled back.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw new AppError(409, 'CONFLICT', 'A slot was taken while moving, so nothing was changed. Try again.');
    throw error;
  }
  // Posts in WordPress (scheduled, or verified drafts about to be): one schedule job each for the new slot. The
  // scheduler's own key is used when it is new, so the tick does not queue a second job; a key used before (a move
  // back to an earlier time) gets a fresh one.
  if (publishing) {
    for (const p of plan.filter((x) => x.status === 'SCHEDULED' || x.status === 'READY')) {
      const kw = moving.find((k) => k.id === p.id)!;
      const key = `wp-schedule:${p.id}:${p.to}:${kw.retries}`;
      const used = await db.queueJob.findUnique({ where: { idempotencyKey: key }, select: { id: true } });
      await enqueue({ queue: 'control', kind: 'wp.schedule', idempotencyKey: used ? `${key}:moved:${now.getTime()}` : key, websiteId, relatedId: p.id, payload: { keywordId: p.id, websiteId } });
    }
  }
  await audit('workflow.keywords.move', 'Workflow', wf.id, { date: input.date, moved: plan.map((p) => ({ keyword: p.keyword, from: p.from, to: p.to })), notMoved: notes.length });
  return { ok: true, changed: plan.length, plan, notes };
}

/**
 * Owner actions on queued keywords. INDEXED is only recorded from the owner's own verification. “request-indexing” has
 * Automation Chrome request indexing in Search Console now. “delete” removes the keyword rows (and, when asked, their
 * articles from the app); WordPress is never changed.
 */
export async function keywordAction(websiteId: string, raw: unknown) {
  const input = keywordActionSchema.parse(raw);
  if (input.action === 'move') return moveKeywords(websiteId, { keywordIds: input.keywordIds, date: input.date, dryRun: input.dryRun });
  const wf = await ensureWorkflow(websiteId);
  const rows = await db.workflowKeyword.findMany({ where: { workflowId: wf.id, id: { in: input.keywordIds } } });
  let changed = 0;
  const notes: string[] = [];
  const property = input.action === 'request-indexing' && rows.some((k) => k.publishedUrl) ? await requestProperty(websiteId) : null;
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
        // A keyword moved to a later day holds its planned slot until it starts: skipped, the slot is free again.
        await db.slotReservation.deleteMany({ where: { workflowKeywordId: kw.id } });
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'SKIPPED', ...(kw.status === 'WAITING' ? { scheduledAt: null } : {}) } });
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
      case 'request-indexing': {
        // Owner request: “Request indexing” on the keyword queue, made by Automation Chrome as the owner does it.
        if (kw.status === 'INDEXED') {
          notes.push(`“${kw.keyword}” is already on Google; nothing to request.`);
          continue;
        }
        if (!kw.publishedUrl || !property || !['PUBLISHED', 'INDEXING_REQUESTED'].includes(kw.status)) {
          notes.push(`“${kw.keyword}” is not published yet.`);
          continue;
        }
        if ((await requestIndexingNow({ keywordId: kw.id, url: kw.publishedUrl, property, websiteId })) === 'running') {
          notes.push(`“${kw.keyword}”: Automation Chrome is requesting indexing for it right now.`);
          continue;
        }
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
  // Screenshots of Search Console's “Indexing requested” (proof of the request, owner request).
  const proofs = await proofsFor(keywords.filter((k) => k.publishedUrl).map((k) => k.id));
  // Google's own URL Inspection link per post (from the URL Inspection API), when the request has one.
  const requests = await db.queueJob.findMany({ where: { queue: 'gsc', idempotencyKey: { in: keywords.filter((k) => k.publishedUrl).map((k) => `gsc-index:${k.id}`) } }, select: { idempotencyKey: true, payload: true } });
  const inspectLinks = new Map(requests.map((r) => [r.idempotencyKey.slice('gsc-index:'.length), parseJson<{ inspectLink?: string | null }>(r.payload, {}).inspectLink ?? null]));
  const nextSlots = workflow ? upcomingSlots(slotRules(workflow), new Date(), 7).slice(0, 8) : [];
  return {
    website: { id: site.id, name: site.name, timezone: site.timezone, canPublish: site.canPublish && Boolean(site.canPublishAcknowledgedAt), publicUrl: site.publicUrl },
    workflow: workflow ? { ...workflow, slots: parseJson<string[]>(workflow.slots, []), weekdays: parseJson<number[]>(workflow.weekdays, []) } : null,
    nextSlots,
    keywords: keywords.map((k) => ({ ...k, secondaryKeywords: parseJson<string[]>(k.secondaryKeywords, []), task: k.taskId ? (byId.get(k.taskId) ?? null) : null, proofId: proofs.get(k.id) ?? null, inspectLink: inspectLinks.get(k.id) ?? null })),
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
