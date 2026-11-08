'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, RefreshCw, RotateCcw, X } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, ConfirmDialog, useToast } from '@/components/client';
import { Input, Select, Textarea } from '@/components/form';
import { Alert, Card, Chip, EmptyState, formatDateTime } from '@/components/ui';

interface Reason {
  code: string;
  detail: string;
  evidence: string;
}
interface CandidateRow {
  id: string;
  title: string;
  url: string | null;
  status: string;
  priority: number;
  live: boolean;
  evaluatedAt: string;
  reasons: Reason[];
  website: { id: string; name: string; allowLiveUpdates: boolean };
  revisions: { id: string; status: string }[];
}
interface Revision {
  id: string;
  kind: string;
  source: string;
  status: string;
  proposedHtml: string;
  baseHtml: string;
  note: string | null;
  changes: { kind: string; detail: string }[];
  result: Record<string, unknown>;
  comparison: { onlyInWordPress: string[]; onlyInApp: string[]; unchanged: number };
  approvedAt: string | null;
  appliedAt: string | null;
  createdAt: string;
}
interface CandidateDetail extends Omit<CandidateRow, 'revisions'> {
  note: string | null;
  website: { id: string; name: string; allowLiveUpdates: boolean; canPublish: boolean };
  task: { id: string; keyword: string; selectedTitle: string | null; wpPostId: number | null; wpEditUrl: string | null } | null;
  revisions: Revision[];
}

const REASON_LABEL: Record<string, string> = {
  OUTDATED_YEAR: 'Outdated year',
  BROKEN_LINK: 'Dead link',
  FACTS_CHANGED: 'Facts changed',
  DECLINING_TRAFFIC: 'Falling search traffic',
  ZERO_IMPRESSIONS: 'No search impressions',
  AGE: 'Age',
};
const STATUS_TONE: Record<string, 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = {
  PROPOSED: 'info',
  APPROVED: 'info',
  APPLYING: 'info',
  APPLIED: 'success',
  CONFLICT: 'warning',
  BLOCKED: 'warning',
  FAILED: 'danger',
  REJECTED: 'neutral',
};
const LIVE_ACK = 'UPDATE LIVE POST';

function RevisionPanel({ c, r, onChanged }: { c: CandidateDetail; r: Revision; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [html, setHtml] = useState(r.proposedHtml);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setHtml(r.proposedHtml), [r.proposedHtml]);
  async function act(kind: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(kind);
    try {
      await fn();
      toast('success', ok);
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const editable = r.status === 'PROPOSED';
  const dirty = html !== r.proposedHtml;
  const error = typeof r.result.error === 'string' ? r.result.error : typeof r.result.waiting === 'string' ? r.result.waiting : null;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {r.kind === 'ROLLBACK' ? 'Rollback' : 'Revision'} <Chip tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status.toLowerCase()}</Chip>
          <span className="text-muted text-xs font-normal">
            {r.source === 'OWNER' ? 'edited by you' : 'automatic proposal'} · {formatDateTime(r.createdAt)}
          </span>
        </span>
      }
    >
      <div className="space-y-4 text-sm">
        {r.changes.length ? (
          <ul className="list-disc space-y-1 pl-5">
            {r.changes.map((ch, i) => (
              <li key={i}>{ch.detail}</li>
            ))}
          </ul>
        ) : null}
        {error ? <Alert tone={r.status === 'CONFLICT' || r.status === 'BLOCKED' ? 'warning' : 'danger'}>{error}</Alert> : null}
        {r.status === 'APPLIED' ? (
          <Alert tone="success" title="Applied to the same WordPress post">
            {r.result.verified ? 'Content read back and confirmed.' : 'Content read back, but it differs from what was sent; check the post.'} Status and date {r.result.stateUnchanged ? 'unchanged' : 'CHANGED — see Recovery Center'} ({String((r.result.after as { status?: string } | undefined)?.status ?? '')}).
          </Alert>
        ) : null}
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="font-medium">Removed or replaced ({r.comparison.onlyInWordPress.length})</h3>
            {r.comparison.onlyInWordPress.length ? (
              <ul className="mt-1 space-y-1">
                {r.comparison.onlyInWordPress.map((b, i) => (
                  <li key={i} className="rounded border-l-4 border-amber-500 bg-amber-50 px-2 py-1 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
                    {b}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">No text removed (link or markup changes only).</p>
            )}
          </div>
          <div>
            <h3 className="font-medium">New text ({r.comparison.onlyInApp.length})</h3>
            {r.comparison.onlyInApp.length ? (
              <ul className="mt-1 space-y-1">
                {r.comparison.onlyInApp.map((b, i) => (
                  <li key={i} className="rounded border-l-4 border-indigo-500 bg-indigo-50 px-2 py-1 text-indigo-950 dark:bg-indigo-950/40 dark:text-indigo-100">
                    {b}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">None yet.</p>
            )}
          </div>
        </div>
        {editable ? (
          <label className="block">
            <span className="text-muted text-xs">Revised article (HTML). Edit the passages named above; everything else stays as it is.</span>
            <Textarea aria-label="Revised article HTML" className="mt-1 font-mono text-xs" rows={14} value={html} onChange={(e) => setHtml(e.target.value)} />
          </label>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {editable ? (
            <>
              <Button size="sm" disabled={!dirty} loading={busy === 'save'} onClick={() => void act('save', () => api(`/api/content-refresh/revisions/${r.id}`, { method: 'PUT', body: { html } }), 'Revision saved.')}>
                Save edits
              </Button>
              <Button size="sm" variant="primary" disabled={dirty || r.proposedHtml === r.baseHtml} onClick={() => setConfirm(true)}>
                <Check className="h-4 w-4" /> Approve and update WordPress…
              </Button>
            </>
          ) : null}
          {r.status === 'APPROVED' && error ? (
            <Button size="sm" variant="primary" onClick={() => setConfirm(true)}>
              <RefreshCw className="h-4 w-4" /> Try again…
            </Button>
          ) : null}
          {r.status === 'CONFLICT' && typeof r.result.error === 'string' && /WordPress/.test(r.result.error) ? (
            <Button size="sm" loading={busy === 'adopt'} onClick={() => void act('adopt', () => api(`/api/content-refresh/revisions/${r.id}/adopt-wordpress`, { method: 'POST' }), 'The WordPress version is now the article text; a new proposal starts from it.')}>
              Start from the WordPress version
            </Button>
          ) : null}
          {['PROPOSED', 'APPROVED', 'CONFLICT', 'BLOCKED', 'FAILED'].includes(r.status) ? (
            <Button size="sm" variant="ghost" loading={busy === 'reject'} onClick={() => void act('reject', () => api(`/api/content-refresh/revisions/${r.id}/reject`, { method: 'POST' }), 'Revision rejected.')}>
              <X className="h-4 w-4" /> Reject
            </Button>
          ) : null}
          {r.status === 'APPLIED' ? (
            <Button size="sm" loading={busy === 'rollback'} onClick={() => void act('rollback', () => api(`/api/content-refresh/revisions/${r.id}/rollback`, { method: 'POST' }), 'Rollback proposed: review and approve it to restore the previous text.')}>
              <RotateCcw className="h-4 w-4" /> Roll back…
            </Button>
          ) : null}
        </div>
      </div>
      <ConfirmDialog
        open={confirm}
        title={c.live ? 'Update the LIVE post?' : 'Update the WordPress draft?'}
        tone={c.live ? 'danger' : 'primary'}
        confirmLabel={c.live ? 'Update live post' : 'Update draft'}
        requireText={c.live && c.website.allowLiveUpdates ? LIVE_ACK : undefined}
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false);
          void act('approve', () => api(`/api/content-refresh/revisions/${r.id}/approve`, { method: 'POST', body: { acknowledgement: c.live ? LIVE_ACK : undefined } }), 'Approved: the worker updates the same WordPress post and reads it back.');
        }}
      >
        <p>
          Only the article content of post #{c.task?.wpPostId} changes. Its status, date, slug and URL stay as they are, and edits made in WordPress since the app's last save are never overwritten.
        </p>
        {c.live && !c.website.allowLiveUpdates ? (
          <div className="mt-3">
            <Alert tone="warning">This post is live and {c.website.name} does not allow updates to live posts (website page → Publishing permission). Approving will be refused.</Alert>
          </div>
        ) : null}
      </ConfirmDialog>
    </Card>
  );
}

function CandidateView({ id, onChanged }: { id: string; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [c, setC] = useState<CandidateDetail | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => setC(await api<CandidateDetail>(`/api/content-refresh/candidates/${id}`)), [id]);
  useEffect(() => {
    void load().catch((e: Error) => toast('error', e.message));
  }, [load, toast]);
  if (!c) return <p className="text-muted text-sm">Loading…</p>;
  const reload = async () => {
    await load();
    await onChanged();
  };
  const active = c.revisions.find((r) => ['PROPOSED', 'APPROVED', 'APPLYING', 'CONFLICT', 'BLOCKED', 'FAILED'].includes(r.status));
  return (
    <div className="space-y-4">
      <Card
        title={
          <span className="flex flex-wrap items-center gap-2">
            {c.task ? (
              <Link className="link" href={`/articles/${c.task.id}`}>
                {c.title}
              </Link>
            ) : (
              c.title
            )}
            {c.live ? <Chip tone="danger">live post</Chip> : <Chip>draft</Chip>}
            <Chip tone="info">priority {c.priority}</Chip>
          </span>
        }
        description={`${c.website.name} · evaluated ${formatDateTime(c.evaluatedAt)}${c.task?.wpPostId ? ` · post #${c.task.wpPostId}` : ''}`}
        actions={
          c.task?.wpEditUrl ? (
            <a className="inline-flex items-center gap-1 text-sm link" href={c.task.wpEditUrl} target="_blank" rel="noreferrer">
              Open in WordPress <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null
        }
      >
        <ul className="space-y-2 text-sm">
          {c.reasons.map((r, i) => (
            <li key={i}>
              <Chip tone={r.code === 'AGE' ? 'neutral' : 'warning'}>{REASON_LABEL[r.code] ?? r.code}</Chip> {r.detail}
              <div className="text-muted text-xs break-all">{r.evidence}</div>
            </li>
          ))}
        </ul>
        {c.status === 'OPEN' ? (
          <div className="mt-4 flex flex-wrap items-end gap-2">
            <Button size="sm" variant="primary" loading={busy === 'propose'} onClick={async () => {
              setBusy('propose');
              try {
                await api(`/api/content-refresh/candidates/${c.id}/propose`, { method: 'POST' });
                await reload();
              } catch (e) {
                toast('error', (e as Error).message);
              } finally {
                setBusy(null);
              }
            }}>
              Propose a revision
            </Button>
            <Input className="w-72" aria-label="Why no refresh is needed" placeholder="Why no refresh is needed" value={note} onChange={(e) => setNote(e.target.value)} />
            <Button size="sm" variant="ghost" disabled={note.trim().length < 5} loading={busy === 'dismiss'} onClick={async () => {
              setBusy('dismiss');
              try {
                await api(`/api/content-refresh/candidates/${c.id}/dismiss`, { method: 'POST', body: { note } });
                toast('success', 'Dismissed. It comes back only if the evidence changes.');
                await reload();
              } catch (e) {
                toast('error', (e as Error).message);
              } finally {
                setBusy(null);
              }
            }}>
              Dismiss
            </Button>
          </div>
        ) : null}
        {c.status === 'DISMISSED' ? <p className="text-muted mt-3 text-sm">Dismissed: {c.note}</p> : null}
      </Card>
      {active ? <RevisionPanel c={c} r={active} onChanged={reload} /> : null}
      {c.revisions.filter((r) => r !== active).map((r) => (
        <RevisionPanel key={r.id} c={c} r={r} onChanged={reload} />
      ))}
    </div>
  );
}

export function ContentRefresh({ websites, initialCandidate }: { websites: { id: string; name: string }[]; initialCandidate: string | null }) {
  const toast = useToast();
  const [siteId, setSiteId] = useState('');
  const [status, setStatus] = useState('');
  const [rows, setRows] = useState<CandidateRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialCandidate);
  const [error, setError] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const load = useCallback(async () => {
    setError(null);
    try {
      const q = new URLSearchParams();
      if (siteId) q.set('websiteId', siteId);
      if (status) q.set('status', status);
      setRows((await api<{ candidates: CandidateRow[] }>(`/api/content-refresh?${q}`)).candidates);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [siteId, status]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="Website" className="w-48" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
            <option value="">All websites</option>
            {websites.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Status" className="w-40" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Needs attention</option>
            <option value="APPLIED">Applied</option>
            <option value="DISMISSED">Dismissed</option>
            <option value="RESOLVED">Resolved</option>
          </Select>
          <Button
            size="sm"
            disabled={!siteId}
            loading={evaluating}
            title={siteId ? undefined : 'Choose a website'}
            onClick={async () => {
              setEvaluating(true);
              try {
                await api(`/api/content-refresh/evaluate`, { method: 'POST', body: { websiteId: siteId } });
                toast('success', 'Evaluation queued: the worker checks every article of this website (links are fetched).');
              } catch (e) {
                toast('error', (e as Error).message);
              } finally {
                setEvaluating(false);
              }
            }}
          >
            <RefreshCw className="h-4 w-4" /> Evaluate now
          </Button>
        </div>
        {error ? (
          <Alert tone="danger" title="Could not load">
            {error}{' '}
            <Button size="sm" variant="ghost" onClick={() => void load()}>
              Retry
            </Button>
          </Alert>
        ) : null}
        {!rows && !error ? <p className="text-muted text-sm">Loading…</p> : null}
        {rows && !rows.length ? <EmptyState title="Nothing to refresh" description="Articles appear here only with evidence: an outdated year, a dead link, a changed fact or falling search traffic. Websites are evaluated daily; use “Evaluate now” for one website." /> : null}
        <ul className="space-y-2">
          {rows?.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => setSelected(r.id)} className={`surface w-full rounded-lg border p-3 text-left text-sm ${selected === r.id ? 'ring-2 ring-indigo-500' : ''}`}>
                <span className="block font-medium">{r.title}</span>
                <span className="text-muted block text-xs">
                  {r.website.name} · priority {r.priority} · {r.live ? 'live' : 'draft'} · {r.status.toLowerCase()}
                  {r.revisions[0] ? ` · revision ${r.revisions[0].status.toLowerCase()}` : ''}
                </span>
                <span className="mt-1 flex flex-wrap gap-1">
                  {[...new Set(r.reasons.map((x) => x.code))].map((code) => (
                    <Chip key={code} tone={code === 'AGE' ? 'neutral' : 'warning'}>
                      {REASON_LABEL[code] ?? code}
                    </Chip>
                  ))}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>{selected ? <CandidateView key={selected} id={selected} onChanged={load} /> : <EmptyState title="Choose an article" description="Its reasons, the evidence and the proposed revision appear here." />}</div>
    </div>
  );
}
