'use client';

import { useEffect, useState } from 'react';
import { Check, Circle, Loader2, Minus, PauseCircle, X } from 'lucide-react';
import type { SerializedTaskDetail } from '@/lib/tasks/detail';
import { timeLeftMs } from '@/lib/tasks/timeline-math';
import { Card, cx, formatDuration } from '@/components/ui';

type Stage = SerializedTaskDetail['stages'][number];

const minutes = (ms: number) => {
  if (ms < 60_000) return 'under a minute';
  const m = Math.round(ms / 60_000);
  return m < 60 ? `about ${m} min` : `about ${Math.floor(m / 60)} h ${m % 60} min`;
};

function StepIcon({ status }: { status: string }) {
  if (status === 'COMPLETED') return <Check className="h-3.5 w-3.5" aria-hidden />;
  if (status === 'RUNNING') return <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />;
  if (status === 'WAITING') return <PauseCircle className="h-3.5 w-3.5" aria-hidden />;
  if (status === 'FAILED') return <X className="h-3.5 w-3.5" aria-hidden />;
  if (status === 'SKIPPED') return <Minus className="h-3.5 w-3.5" aria-hidden />;
  return <Circle className="h-3 w-3" aria-hidden />;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const STATUS_WORD: Record<string, string> = { COMPLETED: 'done', RUNNING: 'running', WAITING: 'waiting', FAILED: 'failed', SKIPPED: 'skipped', PENDING: 'to do' };

/**
 * Article → Overview: the live timeline (owner request 2026-11-12). Every step of this article in order, with how long
 * the finished ones took, how long the running one runs, and what is usually left — from this computer's own finished
 * articles (no estimate is shown for a step that has run fewer than 3 times).
 */
export function ArticleTimeline({ task }: { task: SerializedTaskDetail }) {
  const stages: Stage[] = task.stages;
  const live = stages.some((s) => s.status === 'RUNNING');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  if (!stages.length) return null;

  const estimates = (task.stageEstimates ?? {}) as Record<string, number>;
  const done = stages.filter((s) => s.status === 'COMPLETED' || s.status === 'SKIPPED').length;
  const running = stages.find((s) => s.status === 'RUNNING' || s.status === 'WAITING');
  const finished = !running && stages.every((s) => s.status === 'COMPLETED' || s.status === 'SKIPPED');
  const failed = stages.some((s) => s.status === 'FAILED');
  const left = finished || failed ? null : timeLeftMs(stages, estimates, now);
  const total = stages.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);

  const summary = finished
    ? `All ${stages.length} steps done${total ? ` in ${formatDuration(total)}` : ''}.`
    : failed
      ? `Stopped at step ${stages.findIndex((s) => s.status === 'FAILED') + 1} of ${stages.length}.`
      : running
        ? `Step ${stages.indexOf(running) + 1} of ${stages.length}: ${running.label}${running.status === 'WAITING' ? ' (waiting)' : ''}.`
        : `${done} of ${stages.length} steps done.`;

  return (
    <Card
      title="Progress"
      description={
        <span>
          {summary}
          {left !== null ? <span className="text-muted"> {cap(minutes(left))} left, judging by your last articles.</span> : null}
        </span>
      }
    >
      <div className="surface-2 mb-4 h-1.5 overflow-hidden rounded-full" role="progressbar" aria-valuemin={0} aria-valuemax={stages.length} aria-valuenow={done}>
        <div className={cx('h-full rounded-full transition-[width]', failed ? 'bg-rose-500' : 'bg-[var(--primary)]')} style={{ width: `${Math.round((done / stages.length) * 100)}%` }} />
      </div>
      <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {stages.map((s, i) => {
          const ran = s.status === 'RUNNING' && s.startedAt ? now - new Date(s.startedAt).getTime() : null;
          const est = estimates[s.key];
          const time = s.durationMs ? formatDuration(s.durationMs) : ran !== null ? `${formatDuration(ran)}${est ? ` of ~${formatDuration(est)}` : ''}` : s.status === 'PENDING' && est ? `~${formatDuration(est)}` : '';
          return (
            <li
              key={s.id}
              className={cx(
                'border-app flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm',
                s.status === 'RUNNING' && 'border-[var(--primary)]',
                s.status === 'FAILED' && 'border-rose-400 dark:border-rose-800',
              )}
            >
              <span
                className={cx(
                  'grid h-6 w-6 shrink-0 place-items-center rounded-full',
                  s.status === 'COMPLETED' && 'bg-emerald-500 text-white',
                  s.status === 'RUNNING' && 'bg-[var(--primary)] text-[var(--primary-fg)]',
                  s.status === 'WAITING' && 'bg-amber-500 text-white',
                  s.status === 'FAILED' && 'bg-rose-500 text-white',
                  (s.status === 'PENDING' || s.status === 'SKIPPED') && 'surface-2 text-muted',
                )}
                title={STATUS_WORD[s.status] ?? s.status.toLowerCase()}
              >
                <StepIcon status={s.status} />
              </span>
              <span className="min-w-0 flex-1">
                <span className={cx('block truncate', s.status === 'PENDING' && 'text-muted')}>
                  {i + 1}. {s.label}
                </span>
                {s.message && (s.status === 'RUNNING' || s.status === 'WAITING') ? (
                  <span className="text-muted block truncate text-xs" title={s.message}>
                    {s.message}
                  </span>
                ) : null}
              </span>
              {time ? (
                <span className="text-muted shrink-0 text-xs tabular-nums" suppressHydrationWarning>
                  {time}
                </span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}
