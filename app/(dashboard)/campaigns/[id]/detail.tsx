'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, Download, Pause, Play, RotateCcw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import { Button, ConfirmDialog, useToast } from '@/components/client';
import { Input, Select } from '@/components/form';
import { Alert, Card, Chip, ProgressBar, StatusChip, buttonClasses, cx } from '@/components/ui';
import { CampaignStatusChip, RowStatusChip, WRITER_LABEL } from '../shared';

interface Row {
  id: string;
  line: number;
  keyword: string;
  secondaryKeywords: string[];
  exampleTitle: string | null;
  websiteName: string | null;
  websiteId: string | null;
  writer: string | null;
  writerSource: string | null;
  routerConfidence: number | null;
  routerRationale: string | null;
  status: string;
  priority: number;
  issues: { kind: string; message: string }[];
  task: { id: string; status: string; wpPostId: number | null; wpEditUrl: string | null; seoScore: number | null; rankMathScore: number | null; message: string | null } | null;
}
interface Campaign {
  id: string;
  name: string;
  status: string;
  message: string | null;
  defaultWriter: string;
  routerVersion: string;
  website: { id: string; name: string };
  progress: { queued: number; running: number; review: number; drafts: number; failed: number; cancelled: number; waiting: number };
  rows: Row[];
  categories: Record<string, { id: string; name: string }[]>;
}

const PAGE = 100;
const FILTERS = [
  ['all', 'All'],
  ['needs', 'Needs you'],
  ['queued', 'Queued'],
  ['running', 'Running'],
  ['drafts', 'Drafts'],
  ['review', 'Review'],
  ['failed', 'Failed'],
] as const;
const GROUP: Record<string, string> = { QUEUED: 'queued', COMPLETED: 'drafts', DRAFT_CREATED: 'drafts', NEEDS_REVIEW: 'review', AWAITING_TITLE_APPROVAL: 'review', AWAITING_ARTICLE_APPROVAL: 'review', FAILED: 'failed', CANCELLED: 'failed' };

export function CampaignDetail({ id }: { id: string }) {
  const toast = useToast();
  const [c, setC] = useState<Campaign | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [priority, setPriority] = useState('0');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteArticles, setDeleteArticles] = useState(true);
  const router = useRouter();

  async function removeCampaign() {
    setBusy(true);
    try {
      const res = await api<{ articles: number; deleted: number; deleting: number }>(`/api/campaigns/${id}`, { method: 'DELETE', body: { articles: deleteArticles } });
      toast('success', `Campaign deleted${deleteArticles ? ` with ${res.deleted} article(s)${res.deleting ? ` (${res.deleting} still running, deleted when they stop)` : ''}` : '; its articles were kept'}. WordPress was not changed.`);
      router.push('/campaigns');
      router.refresh();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setC((await api<{ campaign: Campaign }>(`/api/campaigns/${id}`)).campaign), [id]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [load]);

  const rows = useMemo(() => {
    const all = c?.rows ?? [];
    if (filter === 'all') return all;
    if (filter === 'needs') return all.filter((r) => ['NEEDS_WRITER', 'NEEDS_CATEGORY', 'DUPLICATE', 'INVALID'].includes(r.status));
    return all.filter((r) => r.task && (GROUP[r.task.status] ?? 'running') === filter);
  }, [c, filter]);

  async function act(path: string, body?: unknown, done?: string) {
    setBusy(true);
    try {
      const res = await api<{ changed?: number; notes?: string[] }>(`/api/campaigns/${id}/${path}`, { method: 'POST', body });
      toast('success', done ?? `${res.changed ?? 0} row(s) updated.${res.notes?.length ? ` ${res.notes.slice(0, 3).join(' ')}` : ''}`);
      setSelected(new Set());
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!c) return <Card><p className="text-muted text-sm">Loading…</p></Card>;
  const p = c.progress;
  const tasks = p.queued + p.running + p.review + p.drafts + p.failed + p.cancelled + p.waiting;
  const done = p.drafts + p.review + p.failed + p.cancelled;
  const shown = rows.slice(page * PAGE, (page + 1) * PAGE);
  const sel = [...selected];
  const rowAction = (action: string, extra: Record<string, unknown> = {}) => act('rows', { rowIds: sel, action, ...extra });

  return (
    <div className="space-y-6">
      <Card
        title={<span className="flex items-center gap-2">{c.name} <CampaignStatusChip status={c.status} /></span>}
        description={`${c.website.name} · writer: ${c.defaultWriter === 'AUTO' ? `automatic (${c.routerVersion})` : WRITER_LABEL[c.defaultWriter]} · ${c.rows.length} rows`}
        actions={
          <div className="flex flex-wrap gap-2">
            {c.status === 'PAUSED' ? (
              <Button size="sm" onClick={() => void act('resume', undefined, 'Campaign resumed.')} loading={busy}>
                <Play className="h-4 w-4" /> Resume
              </Button>
            ) : ['ACTIVE', 'QUEUEING'].includes(c.status) ? (
              <Button size="sm" onClick={() => void act('pause', undefined, 'Paused: no new article of this campaign starts.')} loading={busy}>
                <Pause className="h-4 w-4" /> Pause
              </Button>
            ) : null}
            {c.status !== 'CANCELLED' ? (
              <Button size="sm" variant="danger" onClick={() => setConfirmCancel(true)}>
                <Ban className="h-4 w-4" /> Cancel
              </Button>
            ) : null}
            <a className={buttonClasses('secondary', 'sm')} href={`/api/campaigns/${id}/export`}>
              <Download className="h-4 w-4" /> Export CSV
            </a>
            <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4" /> Delete
            </Button>
          </div>
        }
      >
        {c.message ? <p className="text-muted mb-3 text-sm">{c.message}</p> : null}
        <ProgressBar label="Campaign progress" value={tasks ? (done / tasks) * 100 : 0} />
        <div className="mt-2 flex flex-wrap gap-2 text-sm">
          <Chip tone="success">{p.drafts} drafts</Chip>
          <Chip tone="info">{p.running} running</Chip>
          <Chip>{p.queued} queued</Chip>
          <Chip tone="warning">{p.review} need review</Chip>
          <Chip>{p.waiting} paused (login/limits)</Chip>
          <Chip tone="danger">{p.failed} failed</Chip>
          <Chip>{p.cancelled} cancelled</Chip>
        </div>
        {c.status === 'PAUSED' ? (
          <div className="mt-3">
            <Alert tone="warning">Paused: articles that already started finish their current step; no new article of this campaign starts until you resume.</Alert>
          </div>
        ) : null}
      </Card>

      <Card padded={false}>
        <div className="border-app flex flex-wrap items-center gap-1 border-b p-3">
          {FILTERS.map(([fid, label]) => (
            <button key={fid} type="button" aria-pressed={filter === fid} onClick={() => { setFilter(fid); setPage(0); }} className={cx('rounded-md px-2 py-1 text-xs', filter === fid ? 'bg-[var(--primary)] text-[var(--primary-fg)]' : 'surface-2')}>
              {label}
            </button>
          ))}
          {sel.length ? (
            <span className="ml-auto flex flex-wrap items-center gap-1 text-xs">
              <span className="text-muted">{sel.length} selected:</span>
              <Button size="sm" onClick={() => void rowAction('retry')} loading={busy}>
                <RotateCcw className="h-3.5 w-3.5" /> Retry
              </Button>
              <Input aria-label="Priority" type="number" min={-10} max={10} value={priority} onChange={(e) => setPriority(e.target.value)} className="w-16 px-2 py-1 text-xs" />
              <Button size="sm" onClick={() => void rowAction('priority', { priority: Number(priority) || 0 })}>Set priority</Button>
              <Button size="sm" onClick={() => void rowAction('writer', { writer: 'celebrity-writer' })}>Celebrity</Button>
              <Button size="sm" onClick={() => void rowAction('writer', { writer: 'tigram-writer' })}>Tigram</Button>
              {(() => {
                // Bulk category (owner request): for rows of one website that are not queued yet.
                const ids = [...new Set(c.rows.filter((r) => selected.has(r.id)).map((r) => r.websiteId).filter((x): x is string => Boolean(x)))];
                const cats = ids.length === 1 ? (c.categories[ids[0]] ?? []) : [];
                return cats.length ? (
                  <span className="inline-block w-44"><Select aria-label="Category for the selected rows" className="px-2 py-1 text-xs" value="" onChange={(e) => { if (e.target.value) void rowAction('category', { categoryId: e.target.value }); }}>
                    <option value="">Category…</option>
                    {cats.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name}
                      </option>
                    ))}
                  </Select></span>
                ) : null;
              })()}
              <Button size="sm" onClick={() => void rowAction('confirm-variant')}>Keep as separate</Button>
            </span>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <table className="table-app">
            <thead>
              <tr>
                <th>
                  <input type="checkbox" aria-label="Select shown rows" checked={shown.length > 0 && shown.every((r) => selected.has(r.id))} onChange={(e) => setSelected((cur) => { const n = new Set(cur); for (const r of shown) e.target.checked ? n.add(r.id) : n.delete(r.id); return n; })} />
                </th>
                <th>Line</th>
                <th>Keyword</th>
                <th>Writer</th>
                <th>Row</th>
                <th>Article</th>
                <th>SEO</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td>
                    <input type="checkbox" aria-label={`Select line ${r.line}`} checked={selected.has(r.id)} onChange={(e) => setSelected((cur) => { const n = new Set(cur); e.target.checked ? n.add(r.id) : n.delete(r.id); return n; })} />
                  </td>
                  <td className="text-muted text-xs">{r.line}</td>
                  <td className="max-w-72">
                    <div className="font-medium">{r.keyword}</div>
                    {r.websiteName && r.websiteName !== c.website.name ? <div className="text-muted text-xs">{r.websiteName}</div> : null}
                    {r.priority ? <Chip>priority {r.priority}</Chip> : null}
                  </td>
                  <td className="text-xs" title={r.routerRationale ?? undefined}>
                    {r.writer ? WRITER_LABEL[r.writer] : <span className="text-amber-700">choose</span>}
                    <div className="text-muted">{r.writerSource === 'RULE' ? `router ${Math.round((r.routerConfidence ?? 0) * 100)} %` : r.writerSource === 'OVERRIDE' ? 'your choice' : r.writerSource === 'CAMPAIGN' ? 'campaign' : ''}</div>
                  </td>
                  <td>
                    <RowStatusChip status={r.status} />
                  </td>
                  <td className="text-xs">
                    {r.task ? (
                      <>
                        <Link href={`/articles/${r.task.id}`} className="mr-1">
                          <StatusChip status={r.task.status} />
                        </Link>
                        {r.task.wpEditUrl ? (
                          <a className="link" href={r.task.wpEditUrl} target="_blank" rel="noreferrer">
                            #{r.task.wpPostId}
                          </a>
                        ) : null}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="text-xs">{r.task ? `${r.task.seoScore ?? '—'} / RM ${r.task.rankMathScore ?? '—'}` : '—'}</td>
                  <td className="max-w-72 text-xs">
                    {r.issues.map((i, k) => (
                      <div key={k} className={i.kind === 'ERROR' ? 'text-rose-600' : 'text-muted'}>
                        {i.message}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length > PAGE ? (
          <div className="flex items-center gap-2 p-3 text-sm">
            <Button size="sm" disabled={page === 0} onClick={() => setPage((x) => x - 1)}>
              Previous
            </Button>
            <span className="text-muted">
              {page * PAGE + 1}–{Math.min(rows.length, (page + 1) * PAGE)} of {rows.length}
            </span>
            <Button size="sm" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage((x) => x + 1)}>
              Next
            </Button>
          </div>
        ) : null}
      </Card>

      <ConfirmDialog open={confirmDelete} title="Delete this campaign?" confirmLabel="Delete campaign" tone="danger" busy={busy} onCancel={() => setConfirmDelete(false)} onConfirm={() => void removeCampaign()}>
        <div className="space-y-2">
          <p>The campaign and its rows are removed from this app. Drafts and posts in WordPress stay as they are.</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={deleteArticles} onChange={(e) => setDeleteArticles(e.target.checked)} />
            <span>Also delete its articles from the app (a report of each is saved in data\backups\deleted-articles first)</span>
          </label>
        </div>
      </ConfirmDialog>
      <ConfirmDialog open={confirmCancel} title="Cancel this campaign?" confirmLabel="Cancel campaign" tone="danger" busy={busy} onCancel={() => setConfirmCancel(false)} onConfirm={() => { setConfirmCancel(false); void act('cancel', undefined, 'Campaign cancelled. Articles stop at a safe point; nothing is deleted.'); }}>
        Rows that have not started are cancelled and running articles stop at a safe point. Drafts already saved stay in WordPress, and nothing is deleted.
      </ConfirmDialog>
    </div>
  );
}
