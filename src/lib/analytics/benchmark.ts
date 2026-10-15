import { db } from '@/lib/db';
import { parseJson } from '@/lib/json';
import { getRateState } from '@/lib/chatgpt/rate';
import { APP_VERSION } from '@/lib/version';
import { evaluateBenchmark, percentile, TARGET_PER_HOUR, type Benchmark } from './measure';

/**
 * The owner-authorized 2-hour benchmark report (spec §22): after a live run,
 * this lists exactly which articles were verified in each of the two
 * consecutive 60-minute windows, with their WordPress evidence, per-stage
 * timings, retries and pauses, and the versions in use. It only reads
 * stored evidence; it never starts work and never claims what it cannot show.
 */

const MIN = 60_000;

export interface BenchmarkArticle {
  taskId: string;
  title: string;
  website: string;
  writer: string;
  verifiedAt: string;
  window: 1 | 2;
  wpPostId: number | null;
  wpEditUrl: string | null;
  minutes: number;
  chatgptInteractions: number | null;
  stages: { stageKey: string; seconds: number; attempts: number }[];
}

export interface BenchmarkReport {
  from: string;
  to: string;
  benchmark: Benchmark;
  articles: BenchmarkArticle[];
  stageSummary: { stageKey: string; runs: number; p50Seconds: number | null; p90Seconds: number | null; retries: number }[];
  pauses: { kind: string; count: number }[];
  chatgptLimits: number;
  failedOrStopped: { taskId: string; title: string; status: string; reason: string }[];
  versions: { app: string; node: string; worker: string | null; extension: string | null };
}

export async function benchmarkReport(from: Date): Promise<BenchmarkReport> {
  const to = new Date(from.getTime() + 120 * MIN);
  const verified = await db.productionMetric.findMany({ where: { kind: 'ARTICLE_VERIFIED', endedAt: { gt: from, lte: to } }, orderBy: { endedAt: 'asc' } });
  const ids = verified.map((v) => v.taskId).filter((x): x is string => Boolean(x));
  const tasks = await db.articleTask.findMany({ where: { id: { in: ids } }, select: { id: true, keyword: true, selectedTitle: true, moduleKey: true, website: { select: { name: true } } } });
  const stages = await db.productionMetric.findMany({ where: { kind: 'STAGE', taskId: { in: ids } }, select: { taskId: true, stageKey: true, durationMs: true, attempt: true, outcome: true } });
  const half = new Date(from.getTime() + 60 * MIN);
  const articles: BenchmarkArticle[] = verified.map((v) => {
    const t = tasks.find((x) => x.id === v.taskId);
    const d = parseJson<{ wpPostId?: number; wpEditUrl?: string; chatgptInteractions?: number }>(v.details, {});
    const own = stages.filter((s) => s.taskId === v.taskId && s.outcome === 'COMPLETED');
    return {
      taskId: v.taskId ?? '',
      title: t?.selectedTitle ?? t?.keyword ?? '(deleted article)',
      website: t?.website.name ?? '',
      writer: t?.moduleKey ?? v.moduleKey ?? '',
      verifiedAt: v.endedAt.toISOString(),
      window: v.endedAt <= half ? 1 : 2,
      wpPostId: d.wpPostId ?? null,
      wpEditUrl: d.wpEditUrl ?? null,
      minutes: Math.round(v.durationMs / MIN),
      chatgptInteractions: d.chatgptInteractions ?? null,
      stages: own.map((s) => ({ stageKey: s.stageKey ?? '', seconds: Math.round(s.durationMs / 1000), attempts: s.attempt })),
    };
  });
  const windowStages = await db.productionMetric.findMany({ where: { kind: 'STAGE', endedAt: { gt: from, lte: to } }, select: { stageKey: true, durationMs: true, attempt: true, outcome: true } });
  const byStage = new Map<string, { done: number[]; retries: number }>();
  for (const s of windowStages) {
    const e = byStage.get(s.stageKey ?? '') ?? { done: [], retries: 0 };
    if (s.outcome === 'COMPLETED') e.done.push(s.durationMs);
    if (s.attempt > 1) e.retries++;
    byStage.set(s.stageKey ?? '', e);
  }
  const rate = await getRateState();
  const chatgptLimits = rate.recent429.filter((t) => new Date(t) > from && new Date(t) <= to).length;
  const pausedLogs = await db.log.findMany({ where: { createdAt: { gt: from, lte: to }, message: { contains: 'paus' } }, select: { message: true, category: true } });
  const pauseKinds = new Map<string, number>();
  for (const l of pausedLogs) pauseKinds.set(l.category, (pauseKinds.get(l.category) ?? 0) + 1);
  const stopped = await db.articleTask.findMany({ where: { updatedAt: { gt: from, lte: to }, status: { in: ['FAILED', 'NEEDS_REVIEW', 'LOGIN_REQUIRED', 'PAUSED'] } }, select: { id: true, keyword: true, selectedTitle: true, status: true, message: true, reviewReasons: true } });
  const conditions: string[] = [];
  if (chatgptLimits) conditions.push(`ChatGPT rate or usage limits ${chatgptLimits}×`);
  const loginPauses = stopped.filter((s) => s.status === 'LOGIN_REQUIRED' || s.status === 'PAUSED').length;
  if (loginPauses) conditions.push(`${loginPauses} article(s) paused for a login or check`);
  const worker = await db.workerStatus.findUnique({ where: { id: 'worker' } });
  const extension = await db.workerStatus.findFirst({ where: { kind: 'EXTENSION' }, orderBy: { lastSeenAt: 'desc' } });
  const hadWork = verified.length > 0 || stopped.length > 0;
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    benchmark: evaluateBenchmark(verified.map((v) => v.endedAt), to, conditions, hadWork),
    articles,
    stageSummary: [...byStage.entries()]
      .map(([stageKey, s]) => ({ stageKey, runs: s.done.length, p50Seconds: (() => { const p = percentile(s.done, 50); return p == null ? null : Math.round(p / 1000); })(), p90Seconds: (() => { const p = percentile(s.done, 90); return p == null ? null : Math.round(p / 1000); })(), retries: s.retries }))
      .sort((a, b) => (b.p90Seconds ?? 0) - (a.p90Seconds ?? 0)),
    pauses: [...pauseKinds.entries()].map(([kind, count]) => ({ kind, count })),
    chatgptLimits,
    failedOrStopped: stopped.map((s) => ({ taskId: s.id, title: s.selectedTitle ?? s.keyword, status: s.status, reason: (parseJson<string[]>(s.reviewReasons, [])[0] ?? s.message ?? '').slice(0, 160) })),
    versions: { app: APP_VERSION, node: process.versions.node, worker: worker?.version ?? null, extension: extension?.version ?? null },
  };
}

/** The report as Markdown (for BUILD_STATUS / the owner's records). */
export function benchmarkMarkdown(r: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(`# Throughput benchmark ${r.from} – ${r.to}`, '');
  lines.push(`**Result: ${r.benchmark.claim}** — ${r.benchmark.explanation}`, '');
  r.benchmark.windows.forEach((w, i) => lines.push(`- Window ${i + 1} (${w.from} – ${w.to}): ${w.count} verified drafts (target ${TARGET_PER_HOUR})`));
  lines.push('', `Versions: app ${r.versions.app}, Node ${r.versions.node}, worker ${r.versions.worker ?? 'unknown'}, extension ${r.versions.extension ?? 'not seen'}. ChatGPT limits in the window: ${r.chatgptLimits}.`, '');
  lines.push('## Verified drafts (evidence)', '', '| # | Window | Verified (UTC) | Article | Website | Writer | WordPress post | Minutes | ChatGPT interactions |', '|---|---|---|---|---|---|---|---|---|');
  r.articles.forEach((a, i) => lines.push(`| ${i + 1} | ${a.window} | ${a.verifiedAt} | ${a.title.replace(/\|/g, '/')} (${a.taskId}) | ${a.website} | ${a.writer} | ${a.wpPostId ?? '—'}${a.wpEditUrl ? ` ${a.wpEditUrl}` : ''} | ${a.minutes} | ${a.chatgptInteractions ?? '—'} |`));
  lines.push('', '## Stage timings in the window', '', '| Stage | Runs | p50 s | p90 s | Retries |', '|---|---|---|---|---|');
  for (const s of r.stageSummary) lines.push(`| ${s.stageKey} | ${s.runs} | ${s.p50Seconds ?? '—'} | ${s.p90Seconds ?? '—'} | ${s.retries} |`);
  if (r.failedOrStopped.length) {
    lines.push('', '## Stopped or failed in the window', '');
    for (const f of r.failedOrStopped) lines.push(`- ${f.title} (${f.taskId}): ${f.status} — ${f.reason}`);
  }
  if (r.pauses.length) {
    lines.push('', '## Pause messages logged', '');
    for (const p of r.pauses) lines.push(`- ${p.kind}: ${p.count}`);
  }
  return `${lines.join('\n')}\n`;
}
