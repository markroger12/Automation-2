import { db } from '@/lib/db';
import { parseJson } from '@/lib/json';
import { getRateState, allowedSlots } from '@/lib/chatgpt/rate';
import { getSettings } from '@/lib/settings';
import { PAUSED_STATUSES, REVIEW_STATUSES, RUNNING_STATUSES } from '@/lib/domain';

/**
 * Performance analytics (upgrades 01 and 15). Every number is counted from
 * stored evidence: a verified draft is an ARTICLE_VERIFIED metric (written
 * once per article when its WordPress draft was read back and verified,
 * with the post ID as proof); stage times are STAGE metrics. Retries never
 * count twice (unique metric keys). Estimates are labelled as such.
 */

import { dayIn, evaluateBenchmark, percentile, rollingWindows, TARGET_PER_HOUR, type Benchmark } from './measure';

export { dayIn, evaluateBenchmark, percentile, rollingWindows, TARGET_PER_HOUR };
export type { Benchmark, BenchmarkClaim } from './measure';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

export interface ProductivityReport {
  now: string;
  timeZone: string;
  profile: { highThroughput: boolean; slots: number; adaptive: boolean };
  rolling: { minutes: number; count: number; perHour: number }[];
  benchmark: Benchmark;
  days: { day: string; count: number }[];
  week: number;
  bySite: { websiteId: string; name: string; count: number }[];
  byWriter: { moduleKey: string; count: number }[];
  byCampaign: { campaignId: string | null; name: string; count: number }[];
  recent: { taskId: string; title: string; website: string; wpPostId: number | null; wpEditUrl: string | null; verifiedAt: string; minutes: number }[];
  stages: { stageKey: string; count: number; p50Ms: number | null; p90Ms: number | null; retries: number; failed: number }[];
  articleMinutes: { p50: number | null; p90: number | null; samples: number };
  capacityEstimate: { perHour: number | null; basis: string };
  chatgpt: { limits24h: number; backoffUntil: string | null; totalBackoffMinutes: number; reason: string | null };
  review: { needsReview: number; awaitingApproval: number; paused: number };
  quality7d: { PASS: number; REVIEW: number; BLOCKED: number };
  failureReasons: { reason: string; count: number }[];
  alerts: { level: 'warning' | 'critical'; message: string }[];
  versions: { version: string; stages: number; p50Ms: number | null }[];
}

export async function productivityReport(now = new Date()): Promise<ProductivityReport> {
  const settings = await getSettings();
  const timeZone = 'Asia/Karachi';
  const since14 = new Date(now.getTime() - 14 * DAY);
  const since7 = new Date(now.getTime() - 7 * DAY);
  const verifiedRows = await db.productionMetric.findMany({ where: { kind: 'ARTICLE_VERIFIED', endedAt: { gt: since14, lte: now } }, orderBy: { endedAt: 'desc' } });
  const verifiedTimes = verifiedRows.map((r) => r.endedAt);
  const taskIds = [...new Set(verifiedRows.map((r) => r.taskId).filter((x): x is string => Boolean(x)))];
  const tasks = await db.articleTask.findMany({ where: { id: { in: taskIds } }, select: { id: true, keyword: true, selectedTitle: true, campaignId: true, website: { select: { id: true, name: true } } } });
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const campaigns = await db.campaign.findMany({ where: { id: { in: [...new Set(tasks.map((t) => t.campaignId).filter((x): x is string => Boolean(x)))] } }, select: { id: true, name: true } });

  // Conditions in the last two hours that a missed target is not the tool's fault.
  const rate = await getRateState();
  const twoHoursAgo = new Date(now.getTime() - 120 * MIN);
  const conditions: string[] = [];
  const limits2h = rate.recent429.filter((t) => new Date(t) > twoHoursAgo).length;
  if (limits2h) conditions.push(`ChatGPT rate or usage limits ${limits2h}×`);
  if (rate.backoffUntil && new Date(rate.backoffUntil) > twoHoursAgo) conditions.push(`ChatGPT backoff until ${new Date(rate.backoffUntil).toISOString()}`);
  const paused = await db.articleTask.groupBy({ by: ['pausedFor'], where: { status: { in: PAUSED_STATUSES }, updatedAt: { gt: twoHoursAgo } }, _count: { _all: true } });
  for (const p of paused) if (p.pausedFor) conditions.push(`${p._count._all} article(s) paused for ${p.pausedFor.replace(/-/g, ' ')}`);
  const worker = await db.workerStatus.findUnique({ where: { id: 'worker' } });
  const workerOnline = Boolean(worker && now.getTime() - worker.lastSeenAt.getTime() < 2 * MIN);
  if (!workerOnline) conditions.push('the worker is not running');
  const hadWork =
    verifiedTimes.some((t) => t > twoHoursAgo) ||
    (await db.articleTask.count({ where: { OR: [{ status: { in: RUNNING_STATUSES } }, { status: 'QUEUED' }, { updatedAt: { gt: twoHoursAgo }, status: { in: [...PAUSED_STATUSES, ...REVIEW_STATUSES, 'FAILED'] } }] } })) > 0;

  const days: { day: string; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const day = dayIn(new Date(now.getTime() - i * DAY), timeZone);
    days.push({ day, count: verifiedRows.filter((r) => dayIn(r.endedAt, timeZone) === day).length });
  }
  const week = verifiedRows.filter((r) => r.endedAt > since7);
  const tally = <K extends string>(rows: typeof week, key: (r: (typeof week)[number]) => K) => {
    const m = new Map<K, number>();
    for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const stageRows = await db.productionMetric.findMany({ where: { kind: 'STAGE', endedAt: { gt: since7, lte: now } }, select: { stageKey: true, outcome: true, durationMs: true, attempt: true, details: true, endedAt: true } });
  const byStage = new Map<string, { done: number[]; retries: number; failed: number }>();
  for (const r of stageRows) {
    const key = r.stageKey ?? 'unknown';
    const s = byStage.get(key) ?? { done: [], retries: 0, failed: 0 };
    if (r.outcome === 'COMPLETED') s.done.push(r.durationMs);
    if (r.outcome === 'FAILED') s.failed++;
    if (r.attempt > 1) s.retries++;
    byStage.set(key, s);
  }
  const stages = [...byStage.entries()]
    .map(([stageKey, s]) => ({ stageKey, count: s.done.length, p50Ms: percentile(s.done, 50), p90Ms: percentile(s.done, 90), retries: s.retries, failed: s.failed }))
    .sort((a, b) => (b.p90Ms ?? 0) - (a.p90Ms ?? 0));

  const articleDurations = week.map((r) => r.durationMs / MIN);
  const p50Article = percentile(articleDurations, 50);
  const slots = await allowedSlots();
  const capacityEstimate =
    p50Article && p50Article > 0
      ? { perHour: Math.round(((slots * 60) / p50Article) * 10) / 10, basis: `${slots} article slot(s) × 60 min ÷ median ${Math.round(p50Article)} min per verified article (last 7 days, ${articleDurations.length} articles). An estimate, not a measurement.` }
      : { perHour: null, basis: 'No verified articles in the last 7 days to estimate from.' };

  const failing = await db.articleTask.findMany({ where: { status: { in: ['FAILED', 'NEEDS_REVIEW', ...PAUSED_STATUSES] }, updatedAt: { gt: since7 } }, select: { status: true, message: true, reviewReasons: true, pausedFor: true } });
  const reasonCount = new Map<string, number>();
  for (const f of failing) {
    const first = parseJson<string[]>(f.reviewReasons, [])[0];
    const reason = (f.pausedFor ? `Paused: ${f.pausedFor.replace(/-/g, ' ')}` : (first ?? f.message ?? f.status)).replace(/\s+/g, ' ').slice(0, 120);
    reasonCount.set(reason, (reasonCount.get(reason) ?? 0) + 1);
  }

  const quality = await db.articleQualityReport.groupBy({ by: ['status'], where: { stage: 'QUALITY_GATE', createdAt: { gt: since7 } }, _count: { _all: true } });
  const q = { PASS: 0, REVIEW: 0, BLOCKED: 0 };
  for (const g of quality) if (g.status in q) q[g.status as keyof typeof q] = g._count._all;

  // Alerts: stalls, error rate, stopped processes.
  const alerts: ProductivityReport['alerts'] = [];
  const inBackoff = Boolean(rate.backoffUntil && new Date(rate.backoffUntil) > now);
  if (!workerOnline) alerts.push({ level: 'critical', message: 'The worker is not running: nothing is processed. Start it with npm run dev:all (or start:all).' });
  const oldestWaiting = await db.queueJob.findFirst({ where: { queue: 'article', status: 'WAITING', runAt: { lt: new Date(now.getTime() - 15 * MIN) } }, orderBy: { runAt: 'asc' } });
  if (oldestWaiting && workerOnline && !inBackoff) alerts.push({ level: 'warning', message: `An article job has waited ${Math.round((now.getTime() - oldestWaiting.runAt.getTime()) / MIN)} min past its start time (queue stall?). All article slots may be taken by waiting tasks.` });
  const lastHour = stageRows.filter((r) => r.endedAt > new Date(now.getTime() - 60 * MIN));
  const failedLastHour = lastHour.filter((r) => r.outcome === 'FAILED').length;
  if (lastHour.length >= 5 && failedLastHour / lastHour.length >= 0.3) alerts.push({ level: 'warning', message: `${failedLastHour} of ${lastHour.length} stage runs failed in the last hour.` });
  if (inBackoff) alerts.push({ level: 'warning', message: `ChatGPT backoff until ${new Date(rate.backoffUntil!).toLocaleTimeString('en-GB')} (${rate.reason ?? 'rate limit'}).` });

  const byVersion = new Map<string, number[]>();
  for (const r of stageRows) {
    if (r.outcome !== 'COMPLETED') continue;
    const v = parseJson<{ version?: string }>(r.details, {}).version ?? 'before 3.0.0 tracking';
    byVersion.set(v, [...(byVersion.get(v) ?? []), r.durationMs]);
  }

  return {
    now: now.toISOString(),
    timeZone,
    profile: { highThroughput: settings.workflow.highThroughputMode, slots, adaptive: settings.workflow.adaptiveConcurrency },
    rolling: rollingWindows(verifiedTimes, now),
    benchmark: evaluateBenchmark(verifiedTimes, now, conditions, hadWork),
    days,
    week: week.length,
    bySite: tally(week, (r) => taskById.get(r.taskId ?? '')?.website.id ?? r.websiteId ?? 'unknown').map(([websiteId, count]) => ({ websiteId, name: tasks.find((t) => t.website.id === websiteId)?.website.name ?? websiteId, count })),
    byWriter: tally(week, (r) => r.moduleKey ?? 'unknown').map(([moduleKey, count]) => ({ moduleKey, count })),
    byCampaign: tally(week, (r) => taskById.get(r.taskId ?? '')?.campaignId ?? 'single').map(([campaignId, count]) => ({ campaignId: campaignId === 'single' ? null : campaignId, name: campaignId === 'single' ? 'Single articles / workflow' : (campaigns.find((c) => c.id === campaignId)?.name ?? campaignId), count })),
    recent: verifiedRows.slice(0, 30).map((r) => {
      const t = taskById.get(r.taskId ?? '');
      const d = parseJson<{ wpPostId?: number; wpEditUrl?: string }>(r.details, {});
      return { taskId: r.taskId ?? '', title: t?.selectedTitle ?? t?.keyword ?? '(deleted article)', website: t?.website.name ?? '', wpPostId: d.wpPostId ?? null, wpEditUrl: d.wpEditUrl ?? null, verifiedAt: r.endedAt.toISOString(), minutes: Math.round(r.durationMs / MIN) };
    }),
    stages,
    articleMinutes: { p50: p50Article == null ? null : Math.round(p50Article * 10) / 10, p90: (() => { const v = percentile(articleDurations, 90); return v == null ? null : Math.round(v * 10) / 10; })(), samples: articleDurations.length },
    capacityEstimate,
    chatgpt: { limits24h: rate.recent429.filter((t) => new Date(t) > new Date(now.getTime() - DAY)).length, backoffUntil: inBackoff ? rate.backoffUntil : null, totalBackoffMinutes: Math.round(rate.totalBackoffMs / MIN), reason: rate.reason },
    review: {
      needsReview: await db.articleTask.count({ where: { status: 'NEEDS_REVIEW' } }),
      awaitingApproval: await db.articleTask.count({ where: { status: { in: ['AWAITING_TITLE_APPROVAL', 'AWAITING_ARTICLE_APPROVAL'] } } }),
      paused: await db.articleTask.count({ where: { status: { in: PAUSED_STATUSES } } }),
    },
    quality7d: q,
    failureReasons: [...reasonCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([reason, count]) => ({ reason, count })),
    alerts,
    versions: [...byVersion.entries()].map(([version, v]) => ({ version, stages: v.length, p50Ms: percentile(v, 50) })),
  };
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};

/** CSV of the verified drafts (with proof) or of the stage timings. */
export async function productivityCsv(view: 'verified' | 'stages', now = new Date()): Promise<string> {
  const r = await productivityReport(now);
  const lines: unknown[][] =
    view === 'stages'
      ? [['stage', 'completed_runs', 'p50_seconds', 'p90_seconds', 'retries', 'failed'], ...r.stages.map((s) => [s.stageKey, s.count, s.p50Ms == null ? '' : Math.round(s.p50Ms / 1000), s.p90Ms == null ? '' : Math.round(s.p90Ms / 1000), s.retries, s.failed])]
      : [['verified_at_utc', 'article_task_id', 'title', 'website', 'wordpress_post_id', 'wordpress_edit_url', 'minutes_from_start'], ...r.recent.map((v) => [v.verifiedAt, v.taskId, v.title, v.website, v.wpPostId, v.wpEditUrl, v.minutes])];
  return lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
