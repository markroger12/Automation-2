'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Ban, CheckCircle2, ExternalLink, Play, RotateCcw, Search, Trash2 } from 'lucide-react';
import { api } from '@/lib/client/api';
import { moduleDisplayName } from '@/lib/domain';
import type { TaskListRow } from '@/lib/tasks/query';
import { Button, ConfirmDialog, usePersistentState, useToast, RelativeTime } from './client';
import { Pagination, pageCount, usePageSize } from './data-table';
import { DatePicker } from './date-picker';
import { Chip, EmptyState, ProgressBar, StatusChip, cx, formatDateTime } from './ui';

type Group = 'all' | 'queued' | 'running' | 'review' | 'paused' | 'draft' | 'failed' | 'cancelled';
const GROUPS: { id: Group; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'queued', label: 'Queued' },
  { id: 'running', label: 'Running' },
  { id: 'review', label: 'Review / approval' },
  { id: 'paused', label: 'Paused' },
  { id: 'draft', label: 'Drafts' },
  { id: 'failed', label: 'Failed' },
  { id: 'cancelled', label: 'Cancelled' },
];

export interface TaskTableProps {
  storageKey: string;
  mode: 'queue' | 'history';
  websites: { id: string; name: string }[];
  initialGroup?: Group;
  /** A search from the sidebar (“Articles: …”). */
  initialQuery?: string;
  pollMs?: number;
  campaignId?: string;
}

interface Filters {
  group: Group;
  websiteId: string;
  moduleKey: string;
  q: string;
  sort: 'updated' | 'created' | 'keyword' | 'status' | 'seo';
  dir: 'asc' | 'desc';
  from: string;
  to: string;
}

export function TaskTable({ storageKey, mode, websites, initialGroup, initialQuery, pollMs = 3000, campaignId }: TaskTableProps) {
  const toast = useToast();
  const [filters, setFilters] = usePersistentState<Filters>(`${storageKey}:filters`, {
    group: initialGroup ?? 'all',
    websiteId: '',
    moduleKey: '',
    q: '',
    sort: mode === 'history' ? 'created' : 'updated',
    dir: 'desc',
    from: '',
    to: '',
  });
  const [data, setData] = useState<{ rows: TaskListRow[]; total: number; counts: Record<string, number> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ action: 'cancel' | 'retry' | 'approve' | 'delete'; ids: string[] } | null>(null);
  const [approveReason, setApproveReason] = useState('');
  // Owner request: pages instead of one long list (“Results per page”, “Page 1 of N”).
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize(`tasks-${mode}`, 20);
  const lastLoad = useRef<Date | null>(null);

  useEffect(() => {
    if (initialGroup) setFilters((f) => ({ ...f, group: initialGroup }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialGroup]);
  useEffect(() => {
    if (initialQuery !== undefined) setFilters((f) => ({ ...f, q: initialQuery, group: 'all' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  // A new filter, search or sort starts on the first page.
  useEffect(() => setPage(1), [filters, campaignId]);

  const query = useMemo(() => {
    const p = new URLSearchParams({ group: filters.group, sort: filters.sort, dir: filters.dir, limit: String(pageSize), offset: String((page - 1) * pageSize) });
    if (filters.websiteId) p.set('websiteId', filters.websiteId);
    if (filters.moduleKey) p.set('moduleKey', filters.moduleKey);
    if (filters.q.trim()) p.set('q', filters.q.trim());
    if (filters.from) p.set('from', new Date(filters.from).toISOString());
    if (filters.to) p.set('to', new Date(filters.to + 'T23:59:59').toISOString());
    if (campaignId) p.set('campaignId', campaignId);
    return p.toString();
  }, [filters, page, pageSize, campaignId]);

  const load = useCallback(async () => {
    try {
      const res = await api<{ rows: TaskListRow[]; total: number; counts: Record<string, number> }>(`/api/tasks?${query}`);
      setData(res);
      setError(null);
      lastLoad.current = new Date();
    } catch (e) {
      setError((e as Error).message);
    }
  }, [query]);

  useEffect(() => {
    void load();
    if (!pollMs) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, pollMs);
    return () => clearInterval(id);
  }, [load, pollMs]);

  async function act(action: 'cancel' | 'retry' | 'resume' | 'approve' | 'delete', ids: string[]) {
    setBusy(action);
    try {
      if (action === 'delete') {
        const res = await api<{ ok: number; failed: number; results: { id: string; ok: boolean; message?: string }[] }>('/api/tasks/bulk', { body: { ids, action } });
        toast(res.failed ? 'error' : 'success', `${res.ok} article(s) deleted${res.failed ? `, ${res.failed} not deleted: ${res.results.find((r) => !r.ok)?.message ?? ''}` : ''}. A running one is deleted as soon as it stops.`);
      } else if (action === 'approve') {
        const res = await api<{ ok: number; failed: number; results: { id: string; ok: boolean; message?: string }[] }>('/api/tasks/bulk', { body: { ids, action, reason: approveReason } });
        const skipped = res.results.filter((r) => !r.ok);
        toast(res.ok ? 'success' : 'error', `${res.ok} task(s) approved${skipped.length ? `, ${skipped.length} skipped (${skipped[0].message ?? 'not waiting for an approval'})` : ''}.`);
      } else if (ids.length === 1 || action === 'resume') {
        for (const id of ids) await api(`/api/tasks/${id}/${action}`, { method: 'POST' });
        toast('success', `${action === 'cancel' ? 'Cancellation requested' : action === 'retry' ? 'Retry queued' : 'Resume queued'}${ids.length > 1 ? ` for ${ids.length} tasks` : ''}.`);
      } else {
        const res = await api<{ ok: number; failed: number; results: { id: string; ok: boolean; message?: string }[] }>('/api/tasks/bulk', { body: { ids, action } });
        toast(res.failed ? 'error' : 'success', `${res.ok} task(s) ${action === 'cancel' ? 'cancelled' : 'queued for retry'}${res.failed ? `, ${res.failed} skipped: ${res.results.find((r) => !r.ok)?.message ?? ''}` : ''}.`);
      }
      setSelected(new Set());
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  }

  const rows = data?.rows ?? [];
  // After a delete or a cancel the last page can be empty: show the page that is now the last one.
  useEffect(() => {
    if (data && page > 1 && data.rows.length === 0 && data.total > 0) setPage(pageCount(data.total, pageSize));
  }, [data, page, pageSize]);
  // Approving a task that needs review asks for a reason (audited), as on its article page.
  const reviewInApproval = confirm?.action === 'approve' && confirm.ids.some((id) => rows.find((r) => r.id === id)?.status === 'NEEDS_REVIEW');
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }));

  return (
    <div className="surface rounded-xl border">
      <div className="border-app flex flex-wrap gap-1.5 border-b px-4 pt-3 pb-2" role="tablist" aria-label="Status filter">
        {GROUPS.map((g) => (
          <button
            key={g.id}
            role="tab"
            aria-selected={filters.group === g.id}
            onClick={() => set('group', g.id)}
            className={cx(
              'rounded-full px-3 py-1 text-xs font-medium transition',
              filters.group === g.id ? 'bg-[var(--primary)] text-[var(--primary-fg)]' : 'surface-2 text-muted hover:text-[var(--text)]',
            )}
          >
            {g.label}
            {data ? <span className="ml-1 tabular-nums opacity-75">{data.counts[g.id] ?? 0}</span> : null}
          </button>
        ))}
      </div>
      <div className="border-app flex flex-wrap items-end gap-3 border-b px-4 py-3">
        <label className="relative min-w-[220px] flex-1">
          <span className="sr-only">Search keywords</span>
          <Search className="text-muted absolute top-2.5 left-2.5 h-4 w-4" aria-hidden />
          <input
            value={filters.q}
            onChange={(e) => set('q', e.target.value)}
            placeholder="Search keyword or title…"
            className="surface w-full rounded-lg border py-2 pr-3 pl-8 text-sm"
          />
        </label>
        <select aria-label="Website" value={filters.websiteId} onChange={(e) => set('websiteId', e.target.value)} className="surface rounded-lg border px-2 py-2 text-sm">
          <option value="">All websites</option>
          {websites.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
        <select aria-label="Writer" value={filters.moduleKey} onChange={(e) => set('moduleKey', e.target.value)} className="surface rounded-lg border px-2 py-2 text-sm">
          <option value="">All writers</option>
          <option value="celebrity-writer">Celebrity Article Writer</option>
          <option value="tigram-writer">Tigram Article Writer</option>
          <option value="celebrity-writer-2">Celebrity Writer 2.0 (retired, history)</option>
        </select>
        {mode === 'history' ? (
          <>
            <span className="text-muted flex items-center gap-1 text-xs">
              From
              <DatePicker ariaLabel="From date" placeholder="Any date" value={filters.from} max={filters.to || undefined} onChange={(v) => set('from', v)} />
            </span>
            <span className="text-muted flex items-center gap-1 text-xs">
              To
              <DatePicker ariaLabel="To date" placeholder="Any date" value={filters.to} min={filters.from || undefined} onChange={(v) => set('to', v)} />
            </span>
          </>
        ) : null}
        <select
          aria-label="Sort"
          value={`${filters.sort}:${filters.dir}`}
          onChange={(e) => {
            const [sort, dir] = e.target.value.split(':') as [Filters['sort'], Filters['dir']];
            setFilters((f) => ({ ...f, sort, dir }));
          }}
          className="surface rounded-lg border px-2 py-2 text-sm"
        >
          <option value="updated:desc">Recently updated</option>
          <option value="created:desc">Newest first</option>
          <option value="created:asc">Oldest first</option>
          <option value="keyword:asc">Keyword A–Z</option>
          <option value="status:asc">Status</option>
          <option value="seo:desc">SEO score</option>
        </select>
        {mode === 'history' ? (
          <a className="text-sm font-medium text-indigo-600 hover:underline" href={`/api/tasks/export?${query}`}>
            Export CSV
          </a>
        ) : null}
      </div>
      {selected.size > 0 ? (
        <div className="border-app surface-2 flex flex-wrap items-center gap-2 border-b px-4 py-2 text-sm">
          <strong>{selected.size} selected</strong>
          <Button size="sm" variant="primary" onClick={() => setConfirm({ action: 'approve', ids: [...selected] })} loading={busy === 'approve'}>
            <CheckCircle2 className="h-3.5 w-3.5" /> Approve selected
          </Button>
          <Button size="sm" onClick={() => setConfirm({ action: 'retry', ids: [...selected] })} loading={busy === 'retry'}>
            <RotateCcw className="h-3.5 w-3.5" /> Retry selected
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirm({ action: 'cancel', ids: [...selected] })} loading={busy === 'cancel'}>
            <Ban className="h-3.5 w-3.5" /> Cancel selected
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirm({ action: 'delete', ids: [...selected] })} loading={busy === 'delete'}>
            <Trash2 className="h-3.5 w-3.5" /> Delete selected
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </Button>
        </div>
      ) : null}
      {error ? (
        <div className="px-4 py-3 text-sm text-rose-700" role="alert">
          Could not load tasks: {error}{' '}
          <button className="font-semibold underline" onClick={() => void load()}>
            Retry
          </button>
        </div>
      ) : null}
      {!data && !error ? (
        <div className="space-y-2 p-4" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="surface-2 h-9 animate-pulse rounded" />
          ))}
        </div>
      ) : rows.length === 0 && data ? (
        <EmptyState
          title={filters.group === 'all' && !filters.q ? 'No articles yet' : 'Nothing matches these filters'}
          description={filters.group === 'all' && !filters.q ? 'Start with Single Article or import keywords in Bulk Campaigns.' : 'Try another status or clear the search.'}
          action={
            filters.group === 'all' && !filters.q ? (
              <Link href="/single-article" className="font-semibold text-indigo-600 hover:underline">
                Write a single article →
              </Link>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="table-app">
            <thead>
              <tr>
                <th className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
                  />
                </th>
                <th>Keyword</th>
                <th>Writer</th>
                <th>Website</th>
                <th>Status</th>
                {mode === 'queue' ? <th className="min-w-[220px]">Progress</th> : <th>Category</th>}
                {mode === 'queue' ? <th>Worker / tab</th> : <th title="Internal SEO readiness score">SEO</th>}
                {mode === 'history' ? <th title="Read from the live WordPress Rank Math panel">Rank Math</th> : null}
                {mode === 'history' ? <th>WordPress</th> : null}
                <th>{mode === 'queue' ? 'Updated' : 'Created'}</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={selected.has(r.id) ? 'bg-[var(--surface-2)]' : undefined}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Select ${r.keyword}`}
                      checked={selected.has(r.id)}
                      onChange={() =>
                        setSelected((s) => {
                          const n = new Set(s);
                          if (n.has(r.id)) n.delete(r.id);
                          else n.add(r.id);
                          return n;
                        })
                      }
                    />
                  </td>
                  <td className="max-w-[280px]">
                    <Link href={`/articles/${r.id}`} className="font-medium hover:underline">
                      {r.keyword}
                    </Link>
                    {r.selectedTitle ? <div className="text-muted line-clamp-1 text-xs">{r.selectedTitle}</div> : null}
                    {r.secondaryKeywords.length ? <div className="text-muted line-clamp-1 text-[11px]">+ {r.secondaryKeywords.join(', ')}</div> : null}
                  </td>
                  <td className="whitespace-nowrap">
                    {moduleDisplayName(r.moduleKey)}
                    {r.legacy ? <Chip className="ml-1">read-only</Chip> : null}
                  </td>
                  <td className="whitespace-nowrap">
                    {r.websiteName} <span className="text-muted text-xs uppercase">{r.language}</span>
                  </td>
                  <td>
                    <StatusChip status={r.status} />
                    {r.nextAction && (r.group === 'review' || r.group === 'paused' || r.group === 'failed') ? (
                      <div className="mt-1 max-w-[240px] text-[11px] text-amber-700 dark:text-amber-300">→ {r.nextAction}</div>
                    ) : null}
                  </td>
                  {mode === 'queue' ? (
                    <td>
                      <ProgressBar label={`Progress of ${r.keyword}`} value={r.percent} tone={r.group === 'failed' ? 'danger' : r.group === 'paused' || r.group === 'review' ? 'warning' : r.status === 'COMPLETED' ? 'success' : 'brand'} />
                      <div className="text-muted mt-1 line-clamp-2 text-xs">
                        {r.stage ? <span className="font-mono">{r.stage}</span> : null} {r.message}
                      </div>
                    </td>
                  ) : (
                    <td className="text-xs">{r.categoryName ?? '—'}</td>
                  )}
                  {mode === 'queue' ? (
                    <td className="text-xs">
                      {r.chatgpt ? (
                        <div>
                          ChatGPT: {r.chatgpt.status === 'ACTIVE' ? `tab ${r.chatgpt.tab}` : `waiting${new Date(r.chatgpt.runAt) > new Date() ? ` until ${new Date(r.chatgpt.runAt).toLocaleTimeString()}` : ''}`}
                          {r.chatgpt.errorCode ? <span className="text-amber-700"> ({r.chatgpt.errorCode})</span> : null}
                        </div>
                      ) : null}
                      {r.job ? (
                        <div className="text-muted">
                          {r.job.status === 'ACTIVE' ? `worker ${r.job.owner?.slice(0, 15)}…` : new Date(r.job.runAt) > new Date() ? <>next run <RelativeTime value={r.job.runAt} /></> : 'ready'}
                        </div>
                      ) : !r.chatgpt ? (
                        <span className="text-muted">—</span>
                      ) : null}
                    </td>
                  ) : (
                    <td className="tabular-nums">{r.seoScore ?? '—'}</td>
                  )}
                  {mode === 'history' ? <td className="tabular-nums">{r.rankMathScore ?? <span className="text-muted text-xs">not verified</span>}</td> : null}
                  {mode === 'history' ? (
                    <td className="text-xs">
                      {r.wpEditUrl ? (
                        <a href={r.wpEditUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-indigo-600 hover:underline">
                          #{r.wpPostId} <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        '—'
                      )}
                    </td>
                  ) : null}
                  <td className="text-muted text-xs whitespace-nowrap" title={formatDateTime(mode === 'queue' ? r.updatedAt : r.createdAt)}>
                    {mode === 'queue' ? <RelativeTime value={r.updatedAt} /> : formatDateTime(r.createdAt)}
                  </td>
                  <td className="text-right whitespace-nowrap">
                    {(r.status === 'LOGIN_REQUIRED' || r.status === 'PAUSED') && !r.legacy ? (
                      <Button size="sm" variant="ghost" onClick={() => void act('resume', [r.id])} title="Resume the exact pending operation">
                        <Play className="h-3.5 w-3.5" /> Resume
                      </Button>
                    ) : null}
                    {(r.status === 'FAILED' || r.status === 'CANCELLED' || r.status === 'NEEDS_REVIEW') && !r.legacy ? (
                      <Button size="sm" variant="ghost" onClick={() => void act('retry', [r.id])}>
                        <RotateCcw className="h-3.5 w-3.5" /> Retry
                      </Button>
                    ) : null}
                    {!['COMPLETED', 'CANCELLED', 'FAILED', 'DRAFT_CREATED'].includes(r.status) && !r.legacy ? (
                      <Button size="sm" variant="ghost" onClick={() => setConfirm({ action: 'cancel', ids: [r.id] })}>
                        <Ban className="h-3.5 w-3.5" /> Cancel
                      </Button>
                    ) : null}
                    <Button size="sm" variant="ghost" onClick={() => setConfirm({ action: 'delete', ids: [r.id] })} title="Delete this article from the app (WordPress is not changed)" aria-label={`Delete ${r.keyword}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 0 ? (
        <div className="border-app border-t px-4">
          <Pagination total={data.total} page={page} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} label="articles" />
        </div>
      ) : null}
      <div className="text-muted border-app border-t px-4 py-1.5 text-[11px]">
        {pollMs ? `Live — refreshes every ${Math.round(pollMs / 1000)}s` : 'Static view'} · last update {lastLoad.current ? lastLoad.current.toLocaleTimeString() : '—'}
      </div>
      <ConfirmDialog
        open={Boolean(confirm)}
        title={confirm?.action === 'cancel' ? `Cancel ${confirm.ids.length} task(s)?` : confirm?.action === 'delete' ? `Delete ${confirm.ids.length} article(s)?` : confirm?.action === 'approve' ? `Approve ${confirm.ids.length} task(s)?` : `Retry ${confirm?.ids.length ?? 0} task(s)?`}
        confirmLabel={confirm?.action === 'cancel' ? 'Cancel tasks' : confirm?.action === 'delete' ? 'Delete' : confirm?.action === 'approve' ? 'Approve' : 'Retry'}
        tone={confirm?.action === 'cancel' || confirm?.action === 'delete' ? 'danger' : 'primary'}
        busy={Boolean(busy)}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          if (confirm.action === 'approve' && reviewInApproval && approveReason.trim().length < 3) return toast('error', 'Give a short reason for approving the tasks that need review (saved in the audit log).');
          void act(confirm.action, confirm.ids);
        }}
      >
        {confirm?.action === 'cancel' ? (
          'Work stops at the next safe point. Completed stage outputs, prompts and responses are kept; nothing is deleted.'
        ) : confirm?.action === 'delete' ? (
          'The articles are removed from this app, with their stages, prompts and answers. Drafts and posts in WordPress stay as they are. A report of each article is saved in data\\backups\\deleted-articles first. A running article stops and is deleted when it stops.'
        ) : confirm?.action === 'approve' ? (
          <div className="space-y-2">
            <p>Each task gets the approval it is waiting for, as on its article page:</p>
            <ul className="list-disc pl-5">
              <li>Title approval: the chosen (or recommended) title.</li>
              <li>Article approval: the article goes on to the WordPress draft.</li>
              <li>Needs review: approved despite its review reasons (a same-site duplicate keyword is allowed).</li>
            </ul>
            <p>Tasks that are not waiting for an approval are skipped.</p>
            {reviewInApproval ? (
              <label className="block">
                <span className="text-xs font-medium">Reason for the tasks that need review (saved in the audit log)</span>
                <input aria-label="Approval reason" value={approveReason} onChange={(e) => setApproveReason(e.target.value)} placeholder="e.g. checked the review reasons" className="surface mt-1 w-full rounded-lg border px-2 py-1.5 text-sm" />
              </label>
            ) : null}
          </div>
        ) : (
          'Each task resumes from its first unfinished stage. Completed stages are not repeated.'
        )}
      </ConfirmDialog>
    </div>
  );
}
