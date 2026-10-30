'use client';

import { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { SerializedTaskDetail } from '@/lib/tasks/detail';
import { Button, ConfirmDialog, useToast } from '@/components/client';
import { Alert, Card, Chip, EmptyState, KeyValue } from '@/components/ui';

interface ExternalData {
  candidates: number;
  accepted: { phrase: string; url: string; finalUrl?: string; kind?: string; reason: string }[];
  rejected: { phrase: string; url: string; kind?: string; reason: string }[];
  warnings: string[];
  notes?: string[];
}

interface InternalData {
  line: string | null;
  url: string | null;
  title: string | null;
  reason: string | null;
  contextual: { anchor: string; url: string; title: string }[];
  candidates: { title: string; url: string; score: number; related: boolean; reasons: string[] }[];
  index: { via: string; active: number; refreshed: boolean } | null;
  removedByOwner?: boolean;
  warnings: string[];
  notes?: string[];
}

function stageData<T>(task: SerializedTaskDetail, key: string): { status: string | null; data: T | null; message: string | null } {
  const s = task.stages.find((x) => x.key === key);
  return { status: s?.status ?? null, data: s?.outputJson ? (JSON.parse(s.outputJson) as T) : null, message: s?.message ?? null };
}

const short = (url: string) => url.replace(/^https?:\/\//, '').slice(0, 70);

interface Suggestion {
  id: string;
  url: string;
  title: string;
  kind: string;
  anchor: string | null;
  score: number;
  status: string;
  note: string | null;
}
const SUGGESTION_STATUS: Record<string, { label: string; tone: 'success' | 'info' | 'warning' | 'neutral' | 'danger' }> = {
  SELECTED: { label: 'placed', tone: 'success' },
  PROPOSED: { label: 'held back', tone: 'info' },
  NO_ANCHOR: { label: 'no natural anchor', tone: 'neutral' },
  UNREACHABLE: { label: 'unreachable', tone: 'danger' },
};

/** Related posts considered for contextual links in the body, and what happened to each. */
function SuggestionList({ taskId }: { taskId: string }) {
  const [rows, setRows] = useState<Suggestion[] | null>(null);
  useEffect(() => {
    void api<{ suggestions: Suggestion[] }>(`/api/tasks/${taskId}/link-suggestions`).then((r) => setRows(r.suggestions.filter((s) => s.kind === 'CONTEXTUAL'))).catch(() => setRows([]));
  }, [taskId]);
  if (!rows?.length) return null;
  return (
    <>
      <h4 className="mt-4 mb-2 text-sm font-semibold">Contextual link decisions</h4>
      <ul className="space-y-1.5 text-sm">
        {rows.map((r) => (
          <li key={r.id}>
            <Chip tone={SUGGESTION_STATUS[r.status]?.tone ?? 'neutral'}>{SUGGESTION_STATUS[r.status]?.label ?? r.status.toLowerCase()}</Chip>{' '}
            {r.anchor ? <span>“{r.anchor}” → </span> : null}
            <a className="link" href={r.url} target="_blank" rel="noreferrer">
              {r.title}
            </a>
            {r.note ? <span className="text-muted text-xs"> · {r.note}</span> : null}
          </li>
        ))}
      </ul>
    </>
  );
}

export function LinksTab({ task, onChanged }: { task: SerializedTaskDetail; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const ext = stageData<ExternalData>(task, 'EXTERNAL_LINKS');
  const int = stageData<InternalData>(task, 'INTERNAL_LINKS');
  const [pending, setPending] = useState<{ mode: 'auto' | 'none' | 'url'; url?: string; title?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function apply() {
    if (!pending) return;
    setBusy(true);
    try {
      await api(`/api/tasks/${task.id}/internal-link`, { body: pending });
      toast('success', 'Internal link updated — the article is re-assembled and the same WordPress draft is updated.');
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card title="External links" description="Suggested by ChatGPT, then verified here: reachable, same site after redirects, about the linked phrase, no social media, shops, shorteners or net-worth aggregators. Wikipedia ≤ half.">
        {!ext.data ? (
          <EmptyState title={ext.status === 'SKIPPED' ? 'External links are off for this article' : 'Not checked yet'} description={ext.message ?? undefined} />
        ) : (
          <>
            {ext.data.warnings.map((w, i) => (
              <Alert key={i} tone="warning">
                {w}
              </Alert>
            ))}
            {(ext.data.notes ?? []).map((w, i) => (
              <Alert key={`n${i}`} tone="info">
                {w}
              </Alert>
            ))}
            <h4 className="mt-2 mb-2 text-sm font-semibold">Added ({ext.data.accepted.length})</h4>
            <ul className="space-y-2 text-sm">
              {ext.data.accepted.map((a, i) => (
                <li key={i}>
                  <span className="font-medium">“{a.phrase}”</span> →{' '}
                  <a className="inline-flex items-center gap-1 link" href={a.finalUrl ?? a.url} target="_blank" rel="noreferrer">
                    {short(a.finalUrl ?? a.url)} <ExternalLink className="h-3 w-3" />
                  </a>{' '}
                  {a.kind ? <Chip>{a.kind}</Chip> : null}
                  <div className="text-muted text-xs">{a.reason}</div>
                </li>
              ))}
            </ul>
            {ext.data.rejected.length ? (
              <details className="mt-4">
                <summary className="cursor-pointer text-sm font-semibold">Rejected ({ext.data.rejected.length}) — with the actual reason</summary>
                <ul className="mt-2 space-y-2 text-sm">
                  {ext.data.rejected.map((r, i) => (
                    <li key={i}>
                      <span className="font-medium">“{r.phrase}”</span> <span className="text-muted break-all">{short(r.url)}</span>
                      <div className="text-xs text-amber-700 dark:text-amber-300">{r.reason}</div>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </>
        )}
      </Card>

      <Card
        title="Internal link"
        description="One line at the very end, to the most related published post of this website (then the previous article, then the latest post). Drafts and this article itself are never linked."
        actions={
          !task.legacy && int.data ? (
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setPending({ mode: 'auto' })}>
                Automatic
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPending({ mode: 'none' })}>
                Remove line
              </Button>
            </div>
          ) : null
        }
      >
        {!int.data ? (
          <EmptyState title={int.status === 'SKIPPED' ? 'Internal links are off for this article' : 'Not chosen yet'} description={int.message ?? undefined} />
        ) : (
          <>
            {int.data.warnings.map((w, i) => (
              <Alert key={i} tone="warning">
                {w}
              </Alert>
            ))}
            {(int.data.notes ?? []).map((w, i) => (
              <Alert key={`n${i}`} tone="info">
                {w}
              </Alert>
            ))}
            <KeyValue
              items={[
                {
                  label: 'Line',
                  value: int.data.removedByOwner ? (
                    <span className="text-muted">removed by you</span>
                  ) : int.data.url ? (
                    <span>
                      <strong>{int.data.line}</strong>{' '}
                      <a className="link" href={int.data.url} target="_blank" rel="noreferrer">
                        {int.data.title}
                      </a>
                    </span>
                  ) : (
                    <span className="text-muted">none</span>
                  ),
                },
                { label: 'Why', value: int.data.reason ?? '—' },
                { label: 'Contextual links', value: int.data.contextual.length ? int.data.contextual.map((c) => `“${c.anchor}” → ${c.title}`).join(' · ') : '—' },
                { label: 'Link index', value: int.data.index ? `${int.data.index.active} published post(s) · ${int.data.index.refreshed ? `refreshed via ${int.data.index.via}` : 'cached'}` : '—' },
              ]}
            />
            {int.data.candidates.length ? (
              <>
                <h4 className="mt-4 mb-2 text-sm font-semibold">Candidates (preview)</h4>
                <ul className="space-y-2 text-sm">
                  {int.data.candidates.map((c) => (
                    <li key={c.url} className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <a className="link" href={c.url} target="_blank" rel="noreferrer">
                          {c.title}
                        </a>{' '}
                        <Chip tone={c.related ? 'success' : 'neutral'}>{c.related ? 'related' : 'fallback'}</Chip> <span className="text-muted text-xs">score {c.score}</span>
                        {c.reasons.length ? <div className="text-muted text-xs">{c.reasons.join('; ')}</div> : null}
                      </div>
                      {!task.legacy && c.url !== int.data!.url ? (
                        <Button size="sm" onClick={() => setPending({ mode: 'url', url: c.url, title: c.title })}>
                          Use this
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <SuggestionList taskId={task.id} />
          </>
        )}
      </Card>

      <ConfirmDialog
        open={Boolean(pending)}
        title={pending?.mode === 'none' ? 'Remove the internal-link line?' : pending?.mode === 'url' ? `Link to “${pending.title}”?` : 'Choose the internal link automatically?'}
        confirmLabel="Apply"
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => void apply()}
      >
        The article is re-assembled with this choice (your choice is kept on later runs, so no second line is added). If a WordPress draft exists, the same draft is updated.
      </ConfirmDialog>
    </div>
  );
}
