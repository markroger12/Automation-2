import type { Website, Workflow, WorkflowKeyword } from '@prisma/client';
import { db } from '../db';
import { log } from '../log';
import { parseJson } from '../json';
import { enqueue } from '../queue';
import { createArticleTask } from '../tasks/create';
import { retryTask } from '../tasks/lifecycle';
import { upcomingSlots } from './time';

/**
 * The publishing scheduler (spec §14). One tick ≈ once a minute. It works on
 * the database only and ENQUEUES jobs — it never opens a browser:
 *  1. syncs keywords with their article tasks (verified draft → READY);
 *  2. moves keywords whose slot passed before they were ready to the next
 *     free slot (bounded by maxRetries, then FAILED with the reason);
 *  3. READY keywords on sites with publishing allowed → one wp.schedule job;
 *     scheduled ones past their time → one wp.verify-published job;
 *  4. starts new articles: next WAITING keyword (by position), next free
 *     slot (unique per website and time), within the write-ahead horizon and
 *     the backlog cap.
 */

export const SCHEDULE_LEAD_MS = 5 * 60_000;
const SLOT_HORIZON_DAYS = 60;

export type WorkflowWithSite = Workflow & { website: Website };

export function writerFor(wf: Pick<Workflow, 'writerPreference'>, kw: Pick<WorkflowKeyword, 'writerType'>): 'celebrity-writer' | 'tigram-writer' | null {
  if (wf.writerPreference === 'celebrity-writer' || wf.writerPreference === 'tigram-writer') return wf.writerPreference;
  if (kw.writerType === 'CELEBRITY') return 'celebrity-writer';
  if (kw.writerType === 'TIGRAM') return 'tigram-writer';
  return null;
}

export const slotRules = (wf: Pick<Workflow, 'slots' | 'weekdays' | 'slotTimezone'>) => ({ slots: parseJson<string[]>(wf.slots, []), weekdays: parseJson<number[]>(wf.weekdays, []), timezone: wf.slotTimezone });

/** The next slot of this workflow that no article of the same website occupies (earliest ≥ `after`). */
export async function nextFreeSlot(wf: WorkflowWithSite, after: Date): Promise<Date | null> {
  const slots = upcomingSlots(slotRules(wf), after, SLOT_HORIZON_DAYS);
  if (!slots.length) return null;
  const taken = new Set((await db.slotReservation.findMany({ where: { websiteId: wf.websiteId, scheduledAt: { gte: slots[0], lte: slots[slots.length - 1] } }, select: { scheduledAt: true } })).map((r) => r.scheduledAt.getTime()));
  return slots.find((s) => !taken.has(s.getTime())) ?? null;
}

/** Reserve a slot for a keyword (moving an existing reservation). Unique per website+time, so two keywords can never share one. */
export async function reserveSlot(wf: WorkflowWithSite, keywordId: string, after: Date): Promise<Date | null> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const slot = await nextFreeSlot(wf, after);
    if (!slot) return null;
    try {
      await db.slotReservation.upsert({ where: { workflowKeywordId: keywordId }, create: { websiteId: wf.websiteId, scheduledAt: slot, workflowKeywordId: keywordId }, update: { scheduledAt: slot, websiteId: wf.websiteId } });
      return slot;
    } catch {
      after = new Date(slot.getTime() + 1000); // taken concurrently: try the next one
    }
  }
  return null;
}

async function release(keywordId: string) {
  await db.slotReservation.deleteMany({ where: { workflowKeywordId: keywordId } });
}

/** Move a keyword to the next free slot, counting it against maxRetries. */
export async function moveToNextSlot(wf: WorkflowWithSite, kw: WorkflowKeyword, now: Date, reason: string): Promise<'moved' | 'failed'> {
  const retries = kw.retries + 1;
  if (retries > wf.maxRetries) {
    await release(kw.id);
    await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'FAILED', retries, lastError: `${reason} Stopped after ${wf.maxRetries} automatic moves — check the article, then retry it here.` } });
    await log({ level: 'warn', category: 'workflow', taskId: kw.taskId, message: `Workflow keyword “${kw.keyword}” failed: ${reason}` });
    return 'failed';
  }
  const slot = await reserveSlot(wf, kw.id, new Date(now.getTime() + SCHEDULE_LEAD_MS));
  await db.workflowKeyword.update({ where: { id: kw.id }, data: { scheduledAt: slot, retries, lastError: `${reason} Moved to the next free slot.` } });
  return 'moved';
}

export interface TickReport {
  workflows: number;
  started: number;
  ready: number;
  /** Verified drafts on draft-only websites whose slot passed (they stay drafts for the owner). */
  kept: number;
  moved: number;
  failed: number;
  scheduleJobs: number;
  verifyJobs: number;
}

export async function schedulerTick(now = new Date()): Promise<TickReport> {
  const report: TickReport = { workflows: 0, started: 0, ready: 0, kept: 0, moved: 0, failed: 0, scheduleJobs: 0, verifyJobs: 0 };
  const workflows = await db.workflow.findMany({ where: { active: true }, include: { website: true } });
  for (const wf of workflows) {
    report.workflows++;
    await tickWorkflow(wf, now, report);
  }
  return report;
}

async function tickWorkflow(wf: WorkflowWithSite, now: Date, report: TickReport) {
  const publishing = wf.website.canPublish && Boolean(wf.website.canPublishAcknowledgedAt);
  // 1. Sync WRITING keywords with their tasks.
  const writing = await db.workflowKeyword.findMany({ where: { workflowId: wf.id, status: 'WRITING' } });
  const tasks = writing.length ? await db.articleTask.findMany({ where: { id: { in: writing.map((k) => k.taskId).filter((x): x is string => Boolean(x)) } } }) : [];
  for (const kw of writing) {
    const task = tasks.find((t) => t.id === kw.taskId);
    if (!task) continue;
    if (task.status === 'COMPLETED' && task.wpPostId) {
      await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'READY', lastError: publishing ? null : 'Draft verified. Publishing is off for this website, so it stays a draft.' } });
      kw.status = 'READY';
      report.ready++;
    } else if (task.status === 'FAILED') {
      if (kw.retries < wf.maxRetries) {
        await retryTask(task.id).catch(() => undefined);
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { retries: kw.retries + 1, lastError: `Article failed (${(task.message ?? '').slice(0, 200)}); retrying.` } });
      } else {
        await release(kw.id);
        await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'FAILED', lastError: `Article failed after ${wf.maxRetries} retries: ${(task.message ?? '').slice(0, 300)}` } });
        report.failed++;
      }
    } else if (task.status === 'CANCELLED') {
      await release(kw.id);
      await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'SKIPPED', lastError: 'The article was cancelled.' } });
    } else if (['NEEDS_REVIEW', 'AWAITING_TITLE_APPROVAL', 'AWAITING_ARTICLE_APPROVAL', 'LOGIN_REQUIRED', 'PAUSED'].includes(task.status)) {
      const msg = `Waiting for you: ${task.nextAction ?? task.message ?? task.status}`.slice(0, 400);
      if (kw.lastError !== msg) await db.workflowKeyword.update({ where: { id: kw.id }, data: { lastError: msg } });
    }
  }

  // 2. Slots that passed before the article was ready (or, on publishing sites, before it was scheduled) move on.
  const late = await db.workflowKeyword.findMany({ where: { workflowId: wf.id, status: { in: publishing ? ['WRITING', 'READY'] : ['WRITING'] }, scheduledAt: { lte: new Date(now.getTime() + (publishing ? SCHEDULE_LEAD_MS / 2 : 0)) } } });
  for (const kw of late) {
    const outcome = await moveToNextSlot(wf, kw, now, kw.status === 'WRITING' ? 'The article was not ready by its slot.' : 'The draft could not be scheduled before its slot.');
    if (outcome === 'moved') report.moved++;
    else report.failed++;
  }

  // 2b. Draft-only websites: once its slot has passed, a verified draft is finished here and leaves the backlog.
  // It stays a draft in WordPress for the owner to publish; nothing is published.
  if (!publishing) {
    const kept = await db.workflowKeyword.updateMany({ where: { workflowId: wf.id, status: 'READY', scheduledAt: { lte: now } }, data: { status: 'DONE', lastError: 'Its slot has passed. Publishing is off for this website, so the verified draft stays in WordPress for you to publish.' } });
    report.kept += kept.count;
  }

  // 3. Jobs for the WordPress side (control queue; idempotent per slot).
  for (const kw of await db.workflowKeyword.findMany({ where: { workflowId: wf.id, status: { in: ['WRITING', 'READY'] }, scheduledAt: null } })) {
    const at = await reserveSlot(wf, kw.id, new Date(now.getTime() + SCHEDULE_LEAD_MS));
    await db.workflowKeyword.update({ where: { id: kw.id }, data: { scheduledAt: at, lastError: at ? kw.lastError : 'No free slot found; add slots to the workflow.' } });
  }
  if (publishing) {
    const ready = await db.workflowKeyword.findMany({ where: { workflowId: wf.id, status: 'READY', scheduledAt: { gt: new Date(now.getTime() + SCHEDULE_LEAD_MS / 2) } } });
    for (const kw of ready) {
      const { created } = await enqueue({ queue: 'control', kind: 'wp.schedule', idempotencyKey: `wp-schedule:${kw.id}:${kw.scheduledAt!.toISOString()}:${kw.retries}`, websiteId: wf.websiteId, relatedId: kw.id, payload: { keywordId: kw.id, websiteId: wf.websiteId } });
      if (created) report.scheduleJobs++;
    }
  }
  const due = await db.workflowKeyword.findMany({ where: { workflowId: wf.id, status: 'SCHEDULED', scheduledAt: { lte: new Date(now.getTime() - 60_000) } } });
  for (const kw of due) {
    const bucket = Math.floor(now.getTime() / (30 * 60_000));
    const { created } = await enqueue({ queue: 'control', kind: 'wp.verify-published', idempotencyKey: `wp-verify:${kw.id}:${bucket}`, websiteId: wf.websiteId, relatedId: kw.id, payload: { keywordId: kw.id, websiteId: wf.websiteId } });
    if (created) report.verifyJobs++;
  }

  // 4. Start new articles within the backlog cap and the write-ahead horizon.
  // Keywords that need the owner's writer choice are flagged right away, whatever the backlog.
  if (wf.writerPreference === 'AUTO') await db.workflowKeyword.updateMany({ where: { workflowId: wf.id, status: 'WAITING', writerType: 'UNKNOWN', lastError: null }, data: { lastError: 'Choose a writer for this keyword.' } });
  let backlog = await db.workflowKeyword.count({ where: { workflowId: wf.id, status: { in: ['WRITING', 'READY'] } } });
  if (backlog >= wf.maxBacklog) return;
  const waiting = await db.workflowKeyword.findMany({ where: { workflowId: wf.id, status: 'WAITING' }, orderBy: { position: 'asc' }, take: 50 });
  for (const kw of waiting) {
    if (backlog >= wf.maxBacklog) break;
    const writer = writerFor(wf, kw);
    if (!writer) {
      const msg = 'Choose a writer for this keyword.';
      if (kw.lastError !== msg) await db.workflowKeyword.update({ where: { id: kw.id }, data: { lastError: msg } });
      continue;
    }
    if (writer === 'celebrity-writer' && !wf.website.defaultCategoryId) {
      const msg = 'Celebrity articles need a default category for this website (Websites → edit → default category).';
      if (kw.lastError !== msg) await db.workflowKeyword.update({ where: { id: kw.id }, data: { lastError: msg } });
      continue;
    }
    const slot = await nextFreeSlot(wf, new Date(now.getTime() + SCHEDULE_LEAD_MS));
    if (!slot) break;
    if (wf.writeAheadHours > 0 && slot.getTime() - now.getTime() > wf.writeAheadHours * 3_600_000) break;
    const reserved = await reserveSlot(wf, kw.id, new Date(now.getTime() + SCHEDULE_LEAD_MS));
    if (!reserved) break;
    try {
      const { task } = await createArticleTask(
        {
          moduleKey: writer,
          keyword: kw.keyword,
          secondaryKeywords: parseJson<string[]>(kw.secondaryKeywords, []),
          exampleTitle: kw.exampleTitle,
          websiteId: wf.websiteId,
          options: { images: wf.imagesOverride === 'on' ? 'on' : wf.imagesOverride === 'off' ? 'off' : 'site', saveToWordPress: true },
          idempotencyKey: `workflow-kw:${kw.id}`,
        },
        { source: 'WORKFLOW', workflowKeywordId: kw.id, routeDecision: { source: wf.writerPreference === 'AUTO' ? (kw.detectionSource ?? 'RULE') : 'WORKFLOW', moduleKey: writer, rationale: kw.detectionReason, confidence: kw.detectionConfidence } },
      );
      await db.workflowKeyword.update({ where: { id: kw.id }, data: { status: 'WRITING', taskId: task.id, scheduledAt: reserved, lastError: null } });
      backlog++;
      report.started++;
    } catch (error) {
      await release(kw.id);
      await db.workflowKeyword.update({ where: { id: kw.id }, data: { lastError: `Could not start the article: ${(error as Error).message}`.slice(0, 400) } });
    }
  }
}
