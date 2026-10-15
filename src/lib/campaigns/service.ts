import { z } from 'zod';
import type { Category, Website } from '@prisma/client';
import { db } from '../db';
import { audit } from '../audit';
import { AppError, badRequest, notFound } from '../errors';
import { normalizeKeyword } from '../domain';
import { parseJson } from '../json';
import { enqueue } from '../queue';
import { taskOptionsSchema } from '../settings-schema';
import { getValue, setValue } from '../settings';
import { createArticleTask } from '../tasks/create';
import { requestCancel, retryTask } from '../tasks/lifecycle';
import { parseImport, type ImportRow } from './parse';
import { ROUTER_VERSION, normalizeWriter, parseRoutingRules, resolveWriter } from './router';
import { isNearDuplicate } from './dedupe';

/**
 * Bulk campaigns: preview (pure, no writes), create (rows stored as entered,
 * original text kept), and idempotent queueing of the same standard tasks
 * Single Article creates — one task per READY row with a per-row
 * idempotency key, so re-submits, retries and restarts never duplicate.
 * Campaigns never publish: tasks are draft-only like every other task.
 */

export type RowStatus = 'READY' | 'NEEDS_WRITER' | 'NEEDS_CATEGORY' | 'DUPLICATE' | 'INVALID' | 'SKIPPED' | 'QUEUED' | 'CANCELLED';
export interface RowIssue {
  kind: 'ERROR' | 'DUPLICATE' | 'NEAR_DUPLICATE' | 'EXISTING_TASK' | 'EXISTING_POST' | 'WRITER' | 'CATEGORY' | 'INFO';
  message: string;
  ref?: string;
}

export const rowOverrideSchema = z.object({
  include: z.boolean().optional(),
  writer: z.string().max(40).nullable().optional(),
  categoryId: z.string().max(40).nullable().optional(),
  confirmVariant: z.boolean().optional(),
});

export const campaignInputSchema = z.object({
  name: z.string().trim().max(120).default(''),
  text: z.string().max(2_000_000),
  websiteId: z.string().min(1, 'Choose a website').max(40),
  defaultWriter: z.enum(['AUTO', 'celebrity-writer', 'tigram-writer']).default('AUTO'),
  options: taskOptionsSchema.prefault({}),
  /** Owner corrections by input line number (preview never changes the input text). */
  overrides: z.record(z.string(), rowOverrideSchema).default({}),
});
export type CampaignInput = z.input<typeof campaignInputSchema>;

export interface PreviewRow {
  line: number;
  raw: string;
  keyword: string;
  secondaryKeywords: string[];
  exampleTitle: string | null;
  websiteId: string | null;
  websiteName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  language: string | null;
  priority: number;
  notes: string | null;
  writer: string | null;
  writerSource: string | null;
  routerConfidence: number | null;
  routerRationale: string | null;
  status: RowStatus;
  issues: RowIssue[];
  confirmedVariant: boolean;
}

type SiteWithCats = Website & { categories: Category[] };

function matchSite(sites: SiteWithCats[], value: string | null, fallback: SiteWithCats): SiteWithCats | null {
  if (!value) return fallback;
  const v = value.trim().toLowerCase();
  return sites.find((s) => s.id === value || s.name.toLowerCase() === v || s.slug === v || s.publicUrl.toLowerCase().replace(/\/+$/, '').endsWith(v.replace(/^https?:\/\//, '').replace(/\/+$/, ''))) ?? null;
}

/** Validate, route and deduplicate rows. Pure with respect to the input: nothing is written. */
export async function previewCampaign(raw: unknown): Promise<{ format: string; problems: string[]; rows: PreviewRow[]; summary: Record<string, number> }> {
  const input = campaignInputSchema.parse(raw);
  const sites = await db.website.findMany({ include: { categories: true } });
  const fallback = sites.find((s) => s.id === input.websiteId);
  if (!fallback) throw badRequest('The selected website does not exist.');
  const parsed = parseImport(input.text);
  const rows: PreviewRow[] = parsed.rows.map((r: ImportRow) => {
    const o = input.overrides[String(r.line)] ?? {};
    const issues: RowIssue[] = r.errors.map((message) => ({ kind: 'ERROR' as const, message }));
    const site = matchSite(sites, r.website, fallback);
    if (!site) issues.push({ kind: 'ERROR', message: `Unknown website “${r.website}”.` });
    else if (!site.active) issues.push({ kind: 'ERROR', message: `${site.name} is inactive.` });
    const language = r.language ?? site?.language ?? null;
    if (r.writer && !normalizeWriter(r.writer)) issues.push({ kind: 'WRITER', message: `“${r.writer}” is not an active writer (use celebrity or tigram).` });
    const decision = resolveWriter({ keyword: r.keyword, language, override: o.writer !== undefined ? o.writer : r.writer, campaignDefault: input.defaultWriter === 'AUTO' ? null : input.defaultWriter, siteRules: site ? parseRoutingRules(site.routingRules) : null });
    let category: Category | undefined;
    if (site) {
      const wanted = o.categoryId !== undefined ? o.categoryId : null;
      category = wanted ? site.categories.find((c) => c.id === wanted) : r.category ? site.categories.find((c) => c.name.toLowerCase() === r.category!.toLowerCase()) : undefined;
      if (r.category && !category && !wanted) issues.push({ kind: 'CATEGORY', message: `Category “${r.category}” is not synchronized for ${site.name}.` });
      if (!category && site.defaultCategoryId) category = site.categories.find((c) => c.id === site.defaultCategoryId);
    }
    let status: RowStatus = 'READY';
    if (issues.some((i) => i.kind === 'ERROR')) status = 'INVALID';
    else if (!decision.writer) status = 'NEEDS_WRITER';
    else if (decision.writer === 'celebrity-writer' && !category) status = 'NEEDS_CATEGORY';
    if (status === 'NEEDS_CATEGORY') issues.push({ kind: 'CATEGORY', message: site?.categories.length ? 'Choose a category for this celebrity article.' : `${site?.name ?? 'This website'} has no synchronized categories yet.` });
    if (o.include === false) status = 'SKIPPED';
    return {
      line: r.line,
      raw: r.raw,
      keyword: r.keyword,
      secondaryKeywords: r.secondaryKeywords,
      exampleTitle: r.exampleTitle,
      websiteId: site?.id ?? null,
      websiteName: site?.name ?? null,
      categoryId: category?.id ?? null,
      categoryName: category?.name ?? null,
      language,
      priority: r.priority ?? 0,
      notes: r.notes,
      writer: decision.writer,
      writerSource: decision.writer ? decision.source : null,
      routerConfidence: decision.confidence,
      routerRationale: decision.rationale,
      status,
      issues,
      confirmedVariant: Boolean(o.confirmVariant),
    };
  });

  // Duplicates within the campaign (same website), then against existing tasks and published posts.
  const kept: PreviewRow[] = [];
  for (const row of rows) {
    if (row.status === 'INVALID' || row.status === 'SKIPPED' || !row.websiteId) continue;
    const same = kept.find((k) => k.websiteId === row.websiteId && normalizeKeyword(k.keyword) === normalizeKeyword(row.keyword));
    const near = same ? null : kept.find((k) => k.websiteId === row.websiteId && isNearDuplicate(k.keyword, row.keyword));
    if (same) row.issues.push({ kind: 'DUPLICATE', message: `Same keyword as line ${same.line}.`, ref: String(same.line) });
    else if (near) row.issues.push({ kind: 'NEAR_DUPLICATE', message: `Very similar to line ${near.line} (“${near.keyword}”).`, ref: String(near.line) });
    kept.push(row);
  }
  const siteIds = [...new Set(rows.map((r) => r.websiteId).filter((x): x is string => Boolean(x)))];
  // Chunked: SQLite allows a limited number of bound variables per query (1,000 rows would exceed it).
  const keys = [...new Set(rows.map((r) => normalizeKeyword(r.keyword)))];
  const existing: { id: string; websiteId: string; normalizedKeyword: string; status: string }[] = [];
  for (let i = 0; siteIds.length && i < keys.length; i += 400) {
    existing.push(...(await db.articleTask.findMany({ where: { websiteId: { in: siteIds }, normalizedKeyword: { in: keys.slice(i, i + 400) }, status: { notIn: ['CANCELLED', 'FAILED'] } }, select: { id: true, websiteId: true, normalizedKeyword: true, status: true } })));
  }
  const posts = siteIds.length ? await db.linkTarget.findMany({ where: { websiteId: { in: siteIds }, status: 'ACTIVE' }, select: { websiteId: true, title: true, url: true, keyword: true } }) : [];
  for (const row of rows) {
    if (!row.websiteId || row.status === 'INVALID' || row.status === 'SKIPPED') continue;
    const task = existing.find((t) => t.websiteId === row.websiteId && t.normalizedKeyword === normalizeKeyword(row.keyword));
    if (task) row.issues.push({ kind: 'EXISTING_TASK', message: `An article for this keyword already exists on this website (${task.status.toLowerCase()}).`, ref: task.id });
    const post = posts.find((p) => p.websiteId === row.websiteId && ((p.keyword && isNearDuplicate(p.keyword, row.keyword)) || isNearDuplicate(p.title, row.keyword)));
    if (post) row.issues.push({ kind: 'EXISTING_POST', message: `Already published: “${post.title}”.`, ref: post.url });
    const blocking = row.issues.some((i) => ['DUPLICATE', 'NEAR_DUPLICATE', 'EXISTING_TASK', 'EXISTING_POST'].includes(i.kind));
    if (blocking && !row.confirmedVariant && (row.status === 'READY' || row.status === 'NEEDS_WRITER' || row.status === 'NEEDS_CATEGORY')) row.status = 'DUPLICATE';
    if (blocking && row.confirmedVariant) row.issues.push({ kind: 'INFO', message: 'Kept as an intentional separate article (confirmed).' });
  }
  const count = (s: RowStatus) => rows.filter((r) => r.status === s).length;
  return {
    format: parsed.format,
    problems: parsed.problems,
    rows,
    summary: {
      rows: rows.length,
      ready: count('READY'),
      needsWriter: count('NEEDS_WRITER'),
      needsCategory: count('NEEDS_CATEGORY'),
      duplicates: count('DUPLICATE'),
      invalid: count('INVALID'),
      skipped: count('SKIPPED'),
      celebrity: rows.filter((r) => r.status === 'READY' && r.writer === 'celebrity-writer').length,
      tigram: rows.filter((r) => r.status === 'READY' && r.writer === 'tigram-writer').length,
    },
  };
}

/** Store the campaign exactly as previewed (server-side recomputation) and queue its READY rows in the worker. */
export async function createCampaign(raw: unknown) {
  const input = campaignInputSchema.parse(raw);
  const preview = await previewCampaign(input);
  if (!preview.rows.length) throw badRequest(preview.problems[0] ?? 'No keywords found.');
  const site = await db.website.findUniqueOrThrow({ where: { id: input.websiteId } });
  const name = input.name || `${site.name} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (${preview.rows.length} rows)`;
  const campaign = await db.$transaction(async (tx) => {
    const c = await tx.campaign.create({ data: { name, websiteId: site.id, defaultWriter: input.defaultWriter, options: JSON.stringify(input.options), inputText: input.text, format: preview.format, routerVersion: ROUTER_VERSION, message: `${preview.summary.ready} row(s) to queue.` } });
    await tx.campaignRow.createMany({
      data: preview.rows.map((r, i) => ({
        campaignId: c.id,
        position: i + 1,
        line: r.line,
        raw: r.raw,
        keyword: r.keyword,
        normalizedKeyword: normalizeKeyword(r.keyword),
        secondaryKeywords: JSON.stringify(r.secondaryKeywords),
        exampleTitle: r.exampleTitle,
        websiteId: r.websiteId,
        categoryId: r.categoryId,
        language: r.language,
        priority: r.priority,
        notes: r.notes,
        writer: r.writer,
        writerSource: r.writerSource,
        routerConfidence: r.routerConfidence,
        routerRationale: r.routerRationale,
        status: r.status,
        issues: JSON.stringify(r.issues),
        confirmedVariant: r.confirmedVariant,
      })),
    });
    return c;
  });
  await scheduleCampaignQueueing(campaign.id);
  await audit('campaign.create', 'Campaign', campaign.id, { rows: preview.rows.length, ready: preview.summary.ready, website: site.name });
  return { campaign, summary: preview.summary };
}

export async function scheduleCampaignQueueing(campaignId: string) {
  // A new job per request (earlier ones may have finished); the work itself is idempotent per row.
  await enqueue({ queue: 'workflow', kind: 'campaign.enqueue', idempotencyKey: `campaign-enqueue:${campaignId}:${Date.now()}`, relatedId: campaignId, payload: { campaignId } });
}

/**
 * Create tasks for READY rows without one (worker; idempotent per row via the
 * task idempotency key, so a restart mid-way continues without duplicates).
 */
export async function queueCampaignRows(campaignId: string, onProgress?: () => Promise<unknown>): Promise<{ created: number; existing: number; failed: number }> {
  const campaign = await db.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign || campaign.status === 'CANCELLED') return { created: 0, existing: 0, failed: 0 };
  const options = taskOptionsSchema.parse(parseJson(campaign.options, {}));
  let created = 0;
  let existing = 0;
  let failed = 0;
  for (;;) {
    const rows = await db.campaignRow.findMany({ where: { campaignId, status: 'READY', taskId: null }, orderBy: { position: 'asc' }, take: 50 });
    if (!rows.length) break;
    for (const row of rows) {
      try {
        const { task, created: isNew } = await createArticleTask(
          {
            moduleKey: row.writer,
            keyword: row.keyword,
            secondaryKeywords: parseJson<string[]>(row.secondaryKeywords, []),
            exampleTitle: row.exampleTitle,
            websiteId: row.websiteId,
            categoryId: row.categoryId,
            language: row.language,
            priority: row.priority,
            options,
            idempotencyKey: `campaign-row:${row.id}`,
          },
          { source: 'BULK', campaignId, campaignRowId: row.id, routeDecision: { source: row.writerSource, moduleKey: row.writer, confidence: row.routerConfidence, rationale: row.routerRationale, version: campaign.routerVersion } },
        );
        // A confirmed intentional variant must not stop at the duplicate-keyword check.
        if (isNew && row.confirmedVariant) await db.articleTask.update({ where: { id: task.id }, data: { options: JSON.stringify({ ...parseJson<Record<string, unknown>>(task.options, {}), allowDuplicate: true }) } });
        await db.campaignRow.update({ where: { id: row.id }, data: { taskId: task.id, status: 'QUEUED' } });
        if (isNew) created++;
        else existing++;
      } catch (error) {
        failed++;
        const issues = [...parseJson<RowIssue[]>(row.issues, []), { kind: 'ERROR' as const, message: `Could not create the task: ${(error as Error).message}` }];
        await db.campaignRow.update({ where: { id: row.id }, data: { status: 'INVALID', issues: JSON.stringify(issues) } });
      }
    }
    await onProgress?.();
  }
  const fresh = await db.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  await db.campaign.update({ where: { id: campaignId }, data: { status: fresh.status === 'QUEUEING' ? 'ACTIVE' : fresh.status, message: `${created} task(s) created${existing ? `, ${existing} already existed` : ''}${failed ? `, ${failed} row(s) failed` : ''}.` } });
  return { created, existing, failed };
}

// ------------------------------------------------------------ controls

async function loadCampaign(id: string) {
  const c = await db.campaign.findUnique({ where: { id } });
  if (!c) throw notFound('Campaign');
  return c;
}

/** Pause: no NEW task of this campaign starts (running ones finish their current step). */
export async function pauseCampaign(id: string) {
  const c = await loadCampaign(id);
  if (['CANCELLED', 'COMPLETED'].includes(c.status)) throw new AppError(409, 'CONFLICT', `The campaign is ${c.status.toLowerCase()}.`);
  await db.campaign.update({ where: { id }, data: { status: 'PAUSED', message: 'Paused: no new article of this campaign starts.' } });
  await audit('campaign.pause', 'Campaign', id, {});
  return { ok: true };
}

export async function resumeCampaign(id: string) {
  const c = await loadCampaign(id);
  if (c.status !== 'PAUSED') return { ok: true };
  await db.campaign.update({ where: { id }, data: { status: 'ACTIVE', message: 'Resumed.' } });
  await audit('campaign.resume', 'Campaign', id, {});
  return { ok: true };
}

/** Cancel: unstarted rows are cancelled, queued tasks are asked to stop at a safe point. Nothing is deleted. */
export async function cancelCampaign(id: string) {
  await loadCampaign(id);
  await db.campaign.update({ where: { id }, data: { status: 'CANCELLED', message: 'Cancelled by you.' } });
  await db.campaignRow.updateMany({ where: { campaignId: id, taskId: null, status: { in: ['READY', 'NEEDS_WRITER', 'NEEDS_CATEGORY', 'DUPLICATE'] } }, data: { status: 'CANCELLED' } });
  const tasks = await db.articleTask.findMany({ where: { campaignId: id, status: { notIn: ['COMPLETED', 'CANCELLED', 'FAILED', 'DRAFT_CREATED'] } }, select: { id: true } });
  for (const t of tasks) await requestCancel(t.id);
  await audit('campaign.cancel', 'Campaign', id, { tasks: tasks.length });
  return { ok: true, tasks: tasks.length };
}

export const rowActionSchema = z.object({
  rowIds: z.array(z.string().max(40)).min(1).max(1000),
  action: z.enum(['retry', 'priority', 'writer', 'category', 'include', 'exclude', 'confirm-variant']),
  priority: z.number().int().min(-10).max(10).optional(),
  writer: z.string().max(40).optional(),
  categoryId: z.string().max(40).optional(),
});

/** Bulk row actions: retry failed tasks, reprioritize, or correct rows that are not queued yet. */
export async function campaignRowAction(campaignId: string, raw: unknown) {
  const input = rowActionSchema.parse(raw);
  const campaign = await loadCampaign(campaignId);
  const rows = await db.campaignRow.findMany({ where: { campaignId, id: { in: input.rowIds } } });
  let changed = 0;
  const notes: string[] = [];
  for (const row of rows) {
    if (input.action === 'retry') {
      if (!row.taskId) continue;
      const task = await db.articleTask.findUnique({ where: { id: row.taskId } });
      if (task && ['FAILED', 'NEEDS_REVIEW', 'CANCELLED'].includes(task.status)) {
        await retryTask(task.id);
        changed++;
      }
      continue;
    }
    if (input.action === 'priority') {
      const p = input.priority ?? 0;
      await db.campaignRow.update({ where: { id: row.id }, data: { priority: p } });
      if (row.taskId) {
        const task = await db.articleTask.findUnique({ where: { id: row.taskId }, include: { website: { select: { priority: true } } } });
        if (task) {
          await db.articleTask.update({ where: { id: task.id }, data: { priority: p + task.website.priority } });
          await db.queueJob.updateMany({ where: { taskId: task.id, status: 'WAITING' }, data: { priority: p + task.website.priority } });
        }
      }
      changed++;
      continue;
    }
    // The remaining actions correct rows that have no task yet; a queued row keeps its approved writer.
    if (row.taskId || ['QUEUED', 'CANCELLED', 'INVALID'].includes(row.status)) {
      notes.push(`Line ${row.line} is already ${row.status.toLowerCase()} and was not changed.`);
      continue;
    }
    const issues = parseJson<RowIssue[]>(row.issues, []);
    let writer = row.writer;
    let writerSource = row.writerSource;
    let categoryId = row.categoryId;
    let confirmed = row.confirmedVariant;
    let excluded = row.status === 'SKIPPED';
    if (input.action === 'writer') {
      const w = normalizeWriter(input.writer);
      if (!w) throw badRequest('Choose the Celebrity Article Writer or the Tigram Article Writer.');
      writer = w;
      writerSource = 'OVERRIDE';
    } else if (input.action === 'category') {
      const cat = row.websiteId ? await db.category.findFirst({ where: { id: input.categoryId, websiteId: row.websiteId } }) : null;
      if (!cat) throw badRequest('That category does not belong to the row’s website.');
      categoryId = cat.id;
    } else if (input.action === 'confirm-variant') confirmed = true;
    else if (input.action === 'exclude') excluded = true;
    else if (input.action === 'include') excluded = false;
    const duplicate = issues.some((i) => ['DUPLICATE', 'NEAR_DUPLICATE', 'EXISTING_TASK', 'EXISTING_POST'].includes(i.kind)) && !confirmed;
    const status: RowStatus = excluded ? 'SKIPPED' : duplicate ? 'DUPLICATE' : !writer ? 'NEEDS_WRITER' : writer === 'celebrity-writer' && !categoryId && !(row.websiteId && (await db.website.findUnique({ where: { id: row.websiteId } }))?.defaultCategoryId) ? 'NEEDS_CATEGORY' : 'READY';
    await db.campaignRow.update({ where: { id: row.id }, data: { writer, writerSource, categoryId, confirmedVariant: confirmed, status } });
    changed++;
  }
  if (['writer', 'category', 'confirm-variant', 'include'].includes(input.action) && campaign.status !== 'CANCELLED') await scheduleCampaignQueueing(campaignId);
  await audit('campaign.rows', 'Campaign', campaignId, { action: input.action, rows: input.rowIds.length, changed });
  return { ok: true, changed, notes };
}

// ------------------------------------------------------------ reads

/** An ACTIVE campaign with nothing left to start or run is finished (rows needing a decision count as left). */
async function settleStatus<T extends { id: string; status: string }>(c: T, p: ReturnType<typeof emptyProgress>): Promise<T> {
  if (c.status !== 'ACTIVE' || p.queued + p.running + p.waiting > 0) return c;
  const open = await db.campaignRow.count({ where: { campaignId: c.id, status: { in: ['READY', 'NEEDS_WRITER', 'NEEDS_CATEGORY', 'DUPLICATE'] }, taskId: null } });
  if (open) return c;
  await db.campaign.update({ where: { id: c.id }, data: { status: 'COMPLETED', message: `Finished: ${p.drafts} draft(s), ${p.review} need review, ${p.failed} failed.` } });
  return { ...c, status: 'COMPLETED' };
}

export async function listCampaigns() {
  const campaigns = await db.campaign.findMany({ orderBy: { createdAt: 'desc' }, take: 100, include: { website: { select: { name: true } }, _count: { select: { rows: true } } } });
  const progress = await campaignProgress(campaigns.map((c) => c.id));
  const out = [];
  for (const { inputText: _, ...c } of campaigns) {
    const p = progress.get(c.id) ?? emptyProgress();
    out.push({ ...(await settleStatus(c, p)), progress: p });
  }
  return out;
}

const emptyProgress = () => ({ queued: 0, running: 0, review: 0, drafts: 0, failed: 0, cancelled: 0, waiting: 0 });

async function campaignProgress(ids: string[]) {
  const map = new Map<string, ReturnType<typeof emptyProgress>>();
  if (!ids.length) return map;
  const tasks = await db.articleTask.groupBy({ by: ['campaignId', 'status'], where: { campaignId: { in: ids } }, _count: { _all: true } });
  const { statusGroup } = await import('../domain');
  for (const t of tasks) {
    const p = map.get(t.campaignId!) ?? emptyProgress();
    const g = statusGroup(t.status);
    const key = g === 'queued' ? 'queued' : g === 'running' ? 'running' : g === 'review' ? 'review' : g === 'draft' ? 'drafts' : g === 'failed' ? 'failed' : g === 'paused' ? 'waiting' : 'cancelled';
    p[key] += t._count._all;
    map.set(t.campaignId!, p);
  }
  return map;
}

export async function getCampaign(id: string) {
  const c = await db.campaign.findUnique({ where: { id }, include: { website: { select: { id: true, name: true } } } });
  if (!c) throw notFound('Campaign');
  const rows = await db.campaignRow.findMany({ where: { campaignId: id }, orderBy: { position: 'asc' } });
  const tasks = await db.articleTask.findMany({ where: { campaignId: id }, select: { id: true, status: true, stage: true, wpPostId: true, wpEditUrl: true, seoScore: true, rankMathScore: true, reviewReasons: true, message: true, moduleKey: true } });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const sites = new Map((await db.website.findMany({ select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  const progress = (await campaignProgress([id])).get(id) ?? emptyProgress();
  return {
    ...(await settleStatus(c, progress)),
    progress,
    rows: rows.map((r) => ({
      ...r,
      secondaryKeywords: parseJson<string[]>(r.secondaryKeywords, []),
      issues: parseJson<RowIssue[]>(r.issues, []),
      websiteName: r.websiteId ? (sites.get(r.websiteId) ?? null) : null,
      task: r.taskId ? (byId.get(r.taskId) ?? null) : null,
    })),
  };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV export of rows with their draft links and SEO status (values as stored; nothing computed here). */
export async function exportCampaignCsv(id: string): Promise<string> {
  const c = await getCampaign(id);
  const header = ['line', 'keyword', 'secondary_keywords', 'title', 'website', 'writer', 'writer_source', 'row_status', 'task_status', 'wp_post_id', 'wp_edit_url', 'seo_score', 'rank_math_score', 'review_reasons', 'issues'];
  const lines = c.rows.map((r) =>
    [r.line, r.keyword, r.secondaryKeywords.join(', '), r.exampleTitle, r.websiteName, r.writer ?? 'UNKNOWN', r.writerSource, r.status, r.task?.status, r.task?.wpPostId, r.task?.wpEditUrl, r.task?.seoScore, r.task?.rankMathScore, r.task ? parseJson<string[]>(r.task.reviewReasons, []).join(' | ') : '', r.issues.map((i) => i.message).join(' | ')].map(csvCell).join(','),
  );
  return [header.join(','), ...lines].join('\n') + '\n';
}

// ------------------------------------------------------------ templates

export const templateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  websiteId: z.string().max(40),
  defaultWriter: z.enum(['AUTO', 'celebrity-writer', 'tigram-writer']),
  options: taskOptionsSchema.prefault({}),
});
export type CampaignTemplate = z.output<typeof templateSchema>;
const TEMPLATES_KEY = 'campaign.templates';

export async function listTemplates(): Promise<CampaignTemplate[]> {
  return getValue<CampaignTemplate[]>(TEMPLATES_KEY, []);
}

export async function saveTemplate(raw: unknown) {
  const t = templateSchema.parse(raw);
  const all = (await listTemplates()).filter((x) => x.name !== t.name);
  await setValue(TEMPLATES_KEY, [...all, t].slice(-50));
  return { ok: true };
}

export async function deleteTemplate(name: string) {
  await setValue(TEMPLATES_KEY, (await listTemplates()).filter((x) => x.name !== name));
  return { ok: true };
}
