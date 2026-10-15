'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, useToast } from '@/components/client';
import { Chip, formatRelative } from '@/components/ui';
import { HEALTH_KINDS, HEALTH_KIND_LABEL, type SiteHealthSummary } from '@/lib/site-health-types';
import type { FailedWordPressTask } from '@/lib/wordpress-resave';

const OVERALL: Record<SiteHealthSummary['overall'], { tone: 'success' | 'warning' | 'danger' | 'neutral'; text: string }> = {
  OK: { tone: 'success', text: 'healthy' },
  WARN: { tone: 'warning', text: 'needs attention' },
  FAIL: { tone: 'danger', text: 'failing' },
  UNKNOWN: { tone: 'neutral', text: 'no data yet' },
};
const TONE = { OK: 'success', WARN: 'warning', FAIL: 'danger' } as const;

function seconds(ms: number | null) {
  return ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`;
}

/** Measured site health and batch re-save of articles that stopped at a WordPress step. */
export function SiteHealth({ websiteId, health, failed }: { websiteId: string; health: SiteHealthSummary; failed: FailedWordPressTask[] }) {
  const router = useRouter();
  const toast = useToast();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(failed.map((f) => f.id)));
  const [busy, setBusy] = useState(false);
  const overall = OVERALL[health.overall];

  async function resave() {
    setBusy(true);
    try {
      const res = await api<{ requeued: string[]; failed: { id: string; error: string }[] }>(`/api/websites/${websiteId}/resave`, { method: 'POST', body: { taskIds: [...selected] } });
      toast(res.failed.length ? 'info' : 'success', `${res.requeued.length} article(s) queued for a WordPress re-save${res.failed.length ? `; ${res.failed.length} could not be queued: ${res.failed[0].error}` : ''}.`);
      router.refresh();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Overall</span>
        <Chip tone={overall.tone}>{overall.text}</Chip>
        {health.overall === 'UNKNOWN' ? <span className="text-muted">Use “Test session” above; draft saves and uploads are recorded automatically.</span> : null}
      </div>
      {health.reasons.length ? (
        <ul className="list-disc space-y-1 pl-5" aria-label="Health problems">
          {health.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      ) : null}

      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {HEALTH_KINDS.map((kind) => {
          const l = health.latest[kind];
          return (
            <div key={kind} className="flex flex-wrap items-baseline gap-2">
              <dt className="text-muted w-36 shrink-0">{HEALTH_KIND_LABEL[kind]}</dt>
              <dd className="min-w-0 flex-1">
                {l ? (
                  <>
                    <Chip tone={TONE[l.status]}>{l.status.toLowerCase()}</Chip> <span>{l.message}</span> <span className="text-muted text-xs">{formatRelative(l.at)}</span>
                  </>
                ) : (
                  <span className="text-muted">not measured yet</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>

      <p className="text-muted">
        Last 24 hours: {health.last24h.draftSaves} draft save(s), {health.last24h.draftFailures} failed · {health.last24h.uploads} upload run(s), {health.last24h.uploadFailures} failed · median save time {seconds(health.last24h.medianDraftSaveMs)}
      </p>

      {health.recent.length ? (
        <details>
          <summary className="cursor-pointer font-medium">Recent observations ({health.recent.length})</summary>
          <ul className="mt-2 space-y-1 text-xs">
            {health.recent.map((r, i) => (
              <li key={i} className="flex flex-wrap gap-2">
                <span className="text-muted">{formatRelative(r.at)}</span>
                <span>{HEALTH_KIND_LABEL[r.kind]}</span>
                <Chip tone={TONE[r.status]}>{r.status.toLowerCase()}</Chip>
                <span>{r.message}</span>
                {r.durationMs != null ? <span className="text-muted">{seconds(r.durationMs)}</span> : null}
                {r.taskId ? (
                  <Link className="underline" href={`/articles/${r.taskId}`}>
                    article
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <div>
        <h3 className="mb-2 font-medium">Articles stopped at a WordPress step ({failed.length})</h3>
        {failed.length === 0 ? (
          <p className="text-muted">None. Articles that fail at the draft save, Rank Math or verification step appear here for a batch re-save.</p>
        ) : (
          <>
            <ul className="space-y-2">
              {failed.map((f) => (
                <li key={f.id} className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    aria-label={`Re-save ${f.title ?? f.keyword}`}
                    checked={selected.has(f.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(f.id);
                      else next.delete(f.id);
                      setSelected(next);
                    }}
                  />
                  <div className="min-w-0">
                    <Link className="font-medium underline" href={`/articles/${f.id}`}>
                      {f.title ?? f.keyword}
                    </Link>{' '}
                    <Chip tone={f.status === 'FAILED' ? 'danger' : 'warning'}>{f.status === 'FAILED' ? 'failed' : 'needs review'}</Chip> <span className="text-muted">at {f.stageLabel || f.stageKey}</span>
                    {f.wpPostId ? <span className="text-muted"> · draft #{f.wpPostId}</span> : null}
                    {f.error ? <p className="text-muted text-xs break-words">{f.error}</p> : null}
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-muted mt-2 text-xs">A re-save retries from the failed step. Existing drafts are reopened (never duplicated), and drafts edited in WordPress still stop for your decision.</p>
            <Button className="mt-2" size="sm" variant="primary" loading={busy} disabled={selected.size === 0} onClick={() => void resave()}>
              <RefreshCw className="h-4 w-4" /> Re-save selected ({selected.size})
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
