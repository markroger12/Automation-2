'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, Unlink, Wand2 } from 'lucide-react';
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
const KIND_LABEL: Record<string, string> = { official: 'official site', 'edu-gov': 'gov / edu', reference: 'reference', imdb: 'IMDb', wikipedia: 'Wikipedia', news: 'news' };
/** “www.cbsnews.com/news/…” as the site in bold and the page in grey, on one line. */
function UrlLine({ url }: { url: string }) {
  let host = url;
  let rest = '';
  try {
    const u = new URL(url);
    host = u.hostname.replace(/^www\./, '');
    rest = `${u.pathname}${u.search}`.replace(/^\/$/, '');
  } catch {
    /* shown as it is */
  }
  return (
    <a className="group flex min-w-0 items-center gap-1 text-xs" href={url} target="_blank" rel="noreferrer" title={url}>
      <span className="shrink-0 font-medium group-hover:underline">{host}</span>
      <span className="text-muted truncate">{rest}</span>
      <ExternalLink className="text-muted h-3 w-3 shrink-0" aria-hidden />
    </a>
  );
}

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
            <h4 className="mt-2 mb-1 text-sm font-semibold">Added ({ext.data.accepted.length})</h4>
            <ul className="divide-y divide-[var(--border)] text-sm">
              {ext.data.accepted.map((a, i) => (
                <li key={i} className="py-2.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">“{a.phrase}”</span>
                    {a.kind && KIND_LABEL[a.kind] ? <Chip>{KIND_LABEL[a.kind]}</Chip> : null}
                  </div>
                  <UrlLine url={a.finalUrl ?? a.url} />
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
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setPending({ mode: 'auto' })} title="Let the app choose the best related post again">
                <Wand2 className="h-3.5 w-3.5" /> Automatic
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setPending({ mode: 'none' })}>
                <Unlink className="h-3.5 w-3.5" /> Remove line
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
                <ul className="divide-y divide-[var(--border)] text-sm">
                  {int.data.candidates.map((c) => (
                    <li key={c.url} className="flex items-start gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <a className="link" href={c.url} target="_blank" rel="noreferrer">
                          {c.title}
                        </a>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Chip tone={c.related ? 'success' : 'neutral'}>{c.related ? 'related' : 'fallback'}</Chip>
                          <span className="text-muted text-xs">score {c.score}</span>
                        </div>
                        {c.reasons.length ? <div className="text-muted mt-0.5 text-xs">{c.reasons.join(' · ')}</div> : null}
                      </div>
                      {!task.legacy && c.url !== int.data!.url ? (
                        <Button size="sm" className="shrink-0" onClick={() => setPending({ mode: 'url', url: c.url, title: c.title })}>
                          Use this
                        </Button>
                      ) : c.url === int.data!.url ? (
                        <Chip tone="brand">in use</Chip>
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
