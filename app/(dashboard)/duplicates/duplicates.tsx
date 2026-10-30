'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, useToast } from '@/components/client';
import { Textarea } from '@/components/form';
import { Alert, Card, Chip, EmptyState, StatusChip, cx } from '@/components/ui';
import { DuplicateMatchCard, type DuplicateMatchView } from '@/components/duplicate-match';

interface Review {
  task: { id: string; title: string; status: string; moduleKey: string; website: string; websiteId: string; overrideReason: string | null };
  matches: DuplicateMatchView[];
}

const FILTERS = [
  { id: 'OPEN', label: 'Needs a decision' },
  { id: 'OVERRIDDEN', label: 'Kept by you' },
  { id: 'ALL', label: 'All' },
] as const;

function ReviewCard({ r, onChanged }: { r: Review; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const writingStage = r.task.moduleKey === 'tigram-writer' ? 'ARTICLE' : 'LONG_ARTICLE';
  async function act(kind: string, fn: () => Promise<void>) {
    setBusy(kind);
    try {
      await fn();
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const open = r.matches.some((m) => m.status === 'OPEN');
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Link className="link" href={`/articles/${r.task.id}`}>
            {r.task.title}
          </Link>
          <span className="text-muted text-sm font-normal">{r.task.website}</span>
          <StatusChip status={r.task.status} />
        </span>
      }
    >
      <div className="space-y-3">
        {r.matches.map((m) => (
          <DuplicateMatchCard key={m.id} m={m} />
        ))}
        {r.task.overrideReason ? (
          <Alert tone="info" title="Kept by you">
            Reason: {r.task.overrideReason}{' '}
            <Button size="sm" variant="ghost" loading={busy === 'withdraw'} onClick={() => void act('withdraw', async () => void (await api(`/api/duplicates/${r.task.id}/withdraw`, { method: 'POST' })))}>
              Withdraw
            </Button>
          </Alert>
        ) : null}
        {open ? (
          <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <label className="mb-1 block text-sm font-medium" htmlFor={`reason-${r.task.id}`}>
                Keep this article anyway — why?
              </label>
              <Textarea id={`reason-${r.task.id}`} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Syndicated with permission; different audience on the other website…" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={reason.trim().length < 10}
                loading={busy === 'override'}
                onClick={() =>
                  void act('override', async () => {
                    const res = await api<{ retried: boolean }>(`/api/duplicates/${r.task.id}/override`, { body: { reason } });
                    toast('success', res.retried ? 'Kept. The article continues from the quality gate.' : 'Kept. The reason was recorded.');
                    setReason('');
                  })
                }
              >
                Keep with this reason
              </Button>
              <Button
                loading={busy === 'regen'}
                onClick={() =>
                  void act('regen', async () => {
                    await api(`/api/tasks/${r.task.id}/regenerate`, { body: { stageKey: writingStage } });
                    toast('success', 'The article text is written again; later stages follow.');
                  })
                }
              >
                <RotateCcw className="h-4 w-4" /> Write the text again
              </Button>
              <Link className={cx('inline-flex items-center rounded-lg px-3 py-2 text-sm font-medium link')} href={`/articles/${r.task.id}?tab=editor`}>
                Edit it yourself
              </Link>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

export function DuplicateReview() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['id']>('OPEN');
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setReviews((await api<{ reviews: Review[] }>(`/api/duplicates?status=${filter}`)).reviews);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filter]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="surface-2 inline-flex rounded-lg p-0.5" role="tablist" aria-label="Filter">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)} className={cx('rounded-md px-3 py-1.5 text-sm font-medium', filter === f.id ? 'surface shadow-sm' : 'text-muted')}>
              {f.label}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
        {reviews ? <Chip>{reviews.length} article(s)</Chip> : null}
      </div>
      {error ? <Alert tone="danger" title="Could not load">{error}</Alert> : null}
      {reviews === null && !error ? <div className="surface-2 h-32 animate-pulse rounded-xl" aria-busy="true" /> : null}
      {reviews && reviews.length === 0 ? (
        <Card>
          <EmptyState title={filter === 'OPEN' ? 'Nothing to decide' : 'Nothing here'} description="Articles are compared with every saved article when they reach the quality gate. Heavy overlap pauses the article here before WordPress; some overlap is listed for review." />
        </Card>
      ) : null}
      {(reviews ?? []).map((r) => (
        <ReviewCard key={r.task.id} r={r} onChanged={load} />
      ))}
    </div>
  );
}
