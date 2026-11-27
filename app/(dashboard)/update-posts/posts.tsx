'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, ExternalLink, FileClock, RefreshCw, Search, X } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, RelativeTime, useToast } from '@/components/client';
import { Field, Input, Select } from '@/components/form';
import { Alert, Card, Chip, EmptyState, cx, formatDateTime, plural } from '@/components/ui';
import { Pagination, usePageSize } from '@/components/data-table';
import {
  POST_AGES,
  POST_LENGTHS,
  POST_LENGTH_LABEL,
  POST_SORTS,
  POST_SORT_LABEL,
  POST_SOURCES,
  POST_SOURCE_LABEL,
  UPDATE_STATES,
  UPDATE_STATE_LABEL,
  ageAgo,
  type PostLength,
  type PostSort,
  type PostSource,
  type UpdateState,
} from '@/lib/posts/list-view';

interface WebsiteOption {
  id: string;
  name: string;
  allowLiveUpdates: boolean;
  categories: { id: number; name: string }[];
}
interface PostRow {
  id: string;
  wpPostId: number;
  taskId: string | null;
  title: string;
  url: string;
  status: string;
  words: number;
  categoryIds: number[];
  publishedAt: string | null;
  modifiedAt: string | null;
  lastUpdate: { id: string; status: string; createdAt: string; appliedAt: string | null } | null;
}
interface PostList {
  total: number;
  /** All posts read from this website, before filters. */
  all: number;
  page: number;
  pageSize: number;
  posts: PostRow[];
  facets: { states: Record<UpdateState | 'all', number>; years: { year: number; count: number }[]; categories: { id: number; name: string; count: number }[] };
  lastImport: { status: string; error: string | null; result: { read?: number; added?: number; refreshed?: number; capped?: boolean }; at: string } | null;
}

/** An update's state, as the owner reads it. */
export const UPDATE_STATUS: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand' }> = {
  QUEUED: { label: 'reading the post', tone: 'info' },
  WRITING: { label: 'ChatGPT is updating', tone: 'info' },
  READY: { label: 'ready for your approval', tone: 'brand' },
  NO_CHANGE: { label: 'nothing outdated', tone: 'success' },
  APPROVED: { label: 'approved', tone: 'info' },
  APPLYING: { label: 'writing to WordPress', tone: 'info' },
  APPLIED: { label: 'updated', tone: 'success' },
  CONFLICT: { label: 'edited in WordPress meanwhile', tone: 'warning' },
  BLOCKED: { label: 'live updates off', tone: 'warning' },
  FAILED: { label: 'stopped', tone: 'danger' },
  REJECTED: { label: 'rejected', tone: 'neutral' },
  UNDONE: { label: 'undone', tone: 'neutral' },
};
const ACTIVE = ['QUEUED', 'WRITING', 'READY', 'APPROVED', 'APPLYING'];
const AGES = [
  { value: '12', label: 'Not changed for 12 months or more' },
  { value: '6', label: 'Not changed for 6 months or more' },
  { value: '24', label: 'Not changed for 2 years or more' },
  { value: '', label: 'All published posts' },
];

/** At most this many posts start in one go (lib/posts/service.ts startUpdates). */
const MAX_BATCH = 50;
const AGE_LABEL = (m: number) => (m >= 24 ? `${m / 12}+ years` : `${m}+ months`);

/** The list's filters and order, as kept in the page's address (so “← back” and a reload keep them). */
interface View {
  q: string;
  state: UpdateState | '';
  older: string;
  category: string;
  year: string;
  length: PostLength | '';
  source: PostSource | '';
  sort: PostSort;
}
const EMPTY_VIEW: View = { q: '', state: '', older: '', category: '', year: '', length: '', source: '', sort: 'changed-asc' };
const pick = <T extends string>(v: string | undefined, allowed: readonly T[]): T | '' => (v && (allowed as readonly string[]).includes(v) ? (v as T) : '');
const digits = (v: string | undefined) => (v && /^\d{1,6}$/.test(v) ? v : '');

function viewFrom(sp: Record<string, string | undefined>): View {
  return {
    q: sp.q ?? '',
    state: pick(sp.state, UPDATE_STATES),
    older: digits(sp.older),
    category: digits(sp.category),
    year: digits(sp.year),
    length: pick(sp.length, POST_LENGTHS),
    source: pick(sp.source, POST_SOURCES),
    sort: pick(sp.sort, POST_SORTS) || 'changed-asc',
  };
}

/** The first click on a column sorts it the way one usually wants it; the next click turns it round. */
const FIRST_DIRECTION: Record<string, 'asc' | 'desc'> = { title: 'asc', published: 'desc', changed: 'asc', words: 'desc', update: 'desc' };

function SortHeader({ label, column, sort, onSort, className }: { label: string; column: string; sort: PostSort; onSort: (s: PostSort) => void; className?: string }) {
  const [key, dir] = sort.split('-');
  const active = key === column;
  const next = (active ? `${column}-${dir === 'asc' ? 'desc' : 'asc'}` : `${column}-${FIRST_DIRECTION[column]}`) as PostSort;
  const Icon = active ? (dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  return (
    <th aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'} className={className}>
      <button type="button" onClick={() => onSort(next)} title={`Sort by ${POST_SORT_LABEL[next]}`} className={cx('inline-flex items-center gap-1 rounded hover:text-[var(--text)]', active && 'text-[var(--text)]')}>
        {label}
        <Icon className={cx('h-3.5 w-3.5', !active && 'opacity-40')} aria-hidden />
      </button>
    </th>
  );
}

export function UpdatePosts({ websites, initialWebsite, initialView = {} }: { websites: WebsiteOption[]; initialWebsite: string | null; initialView?: Record<string, string | undefined> }) {
  const toast = useToast();
  const [websiteId, setWebsiteId] = useState(initialWebsite && websites.some((w) => w.id === initialWebsite) ? initialWebsite : (websites[0]?.id ?? ''));
  const [age, setAge] = useState('12');
  const [category, setCategory] = useState('');
  const [view, setView] = useState<View>(() => viewFrom(initialView));
  // The search box answers as you type; the list follows a moment later.
  const [q, setQ] = useState(view.q);
  const [page, setPage] = useState(() => Math.max(1, Number(digits(initialView.page)) || 1));
  const [pageSize, setPageSize] = usePageSize('update-posts', 20);
  const [data, setData] = useState<PostList | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const site = websites.find((w) => w.id === websiteId);

  const change = (patch: Partial<View>) => {
    setView((v) => ({ ...v, ...patch }));
    setPage(1);
  };
  useEffect(() => {
    const t = setTimeout(() => {
      if (q !== view.q) change({ q });
    }, 250);
    return () => clearTimeout(t);
  }, [q, view.q]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(view)) if (v && !(k === 'sort' && v === 'changed-asc')) p.set(k, k === 'q' ? v.trim() : v);
    if (!p.get('q')) p.delete('q');
    return p;
  }, [view]);

  // The address keeps the website, the filters, the order and the page.
  useEffect(() => {
    const p = new URLSearchParams(params);
    if (websiteId) p.set('website', websiteId);
    if (page > 1) p.set('page', String(page));
    const url = `${window.location.pathname}${p.size ? `?${p}` : ''}`;
    if (url !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, '', url);
  }, [params, websiteId, page]);

  const load = useCallback(async () => {
    if (!websiteId) return;
    const p = new URLSearchParams(params);
    p.set('websiteId', websiteId);
    p.set('page', String(page));
    p.set('pageSize', String(pageSize));
    const d = await api<PostList>(`/api/site-posts?${p}`);
    setData(d);
    // A page past the end (after a filter): the server answers with the last page.
    if (d.page !== page) setPage(d.page);
  }, [websiteId, params, page, pageSize]);

  useEffect(() => {
    void load().catch(() => setData(null));
  }, [load]);

  // While posts are being read, or updates are on their way, the list follows by itself.
  const importing = data?.lastImport && ['WAITING', 'ACTIVE'].includes(data.lastImport.status);
  const working = data?.posts.some((p) => p.lastUpdate && ['QUEUED', 'WRITING', 'APPROVED', 'APPLYING'].includes(p.lastUpdate.status));
  useEffect(() => {
    if (!importing && !working) return;
    const t = setInterval(() => void load().catch(() => {}), 4000);
    return () => {
      clearInterval(t);
    };
  }, [importing, working, load]);

  async function readPosts() {
    setBusy(true);
    try {
      const r = await api<{ queued: boolean }>('/api/site-posts/import', { body: { websiteId, olderThanMonths: age ? Number(age) : null, categoryIds: category ? [Number(category)] : [] } });
      toast('success', r.queued ? 'Reading the posts from WordPress — the list fills in by itself.' : 'The posts are being read already.');
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function update(ids: string[]) {
    setBusy(true);
    try {
      const r = await api<{ started: string[]; already: string[] }>('/api/site-posts/update', { body: { sitePostIds: ids } });
      toast('success', `${plural(r.started.length, 'update')} started${r.already.length ? ` · ${plural(r.already.length, 'post')} already had one` : ''}. ChatGPT works in its tab; each update waits for your approval.`);
      setSelected(new Set());
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!websites.length) return <EmptyState title="No website yet" description="Add a website first (Websites → Add website)." />;
  const selectable = (data?.posts ?? []).filter((p) => !(p.lastUpdate && ACTIVE.includes(p.lastUpdate.status)));
  const categoryName = new Map<number, string>([...(site?.categories ?? []).map((c) => [c.id, c.name] as const), ...(data?.facets.categories ?? []).map((c) => [c.id, c.name] as const)]);
  const facets = data?.facets;

  // The filters that are on, each with its own “×”.
  const active: { key: keyof View; label: string }[] = [];
  if (view.q.trim()) active.push({ key: 'q', label: `“${view.q.trim()}”` });
  if (view.state) active.push({ key: 'state', label: UPDATE_STATE_LABEL[view.state] });
  if (view.older) active.push({ key: 'older', label: `Not changed for ${AGE_LABEL(Number(view.older))}` });
  if (view.category) active.push({ key: 'category', label: `Category: ${categoryName.get(Number(view.category)) ?? view.category}` });
  if (view.year) active.push({ key: 'year', label: `Published in ${view.year}` });
  if (view.length) active.push({ key: 'length', label: POST_LENGTH_LABEL[view.length] });
  if (view.source) active.push({ key: 'source', label: POST_SOURCE_LABEL[view.source] });
  const clearAll = () => {
    setQ('');
    setView((v) => ({ ...EMPTY_VIEW, sort: v.sort }));
    setPage(1);
  };
  const tooMany = selected.size > MAX_BATCH;

  return (
    <div className="space-y-6">
      {websites.length > 1 ? (
        <Field label="Website" htmlFor="up-site" className="max-w-sm">
          <Select
            id="up-site"
            value={websiteId}
            onChange={(e) => {
              setWebsiteId(e.target.value);
              setQ('');
              setView((v) => ({ ...EMPTY_VIEW, sort: v.sort }));
              setPage(1);
              setSelected(new Set());
            }}
          >
            {websites.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}

      <Card title="1 · Read the posts from WordPress" description="With your WordPress sign-in the app reads the website's published posts: their text, title, categories and dates. Nothing changes in WordPress. Read again any time; posts are refreshed, never doubled.">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Which posts" htmlFor="up-age" className="min-w-[16rem]">
            <Select id="up-age" value={age} onChange={(e) => setAge(e.target.value)}>
              {AGES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Category" htmlFor="up-cat" className="min-w-[12rem]">
            <Select id="up-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {(site?.categories ?? []).map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button onClick={() => void readPosts()} disabled={busy || Boolean(importing)}>
            <RefreshCw className={`h-4 w-4 ${importing ? 'animate-spin' : ''}`} /> {importing ? 'Reading…' : 'Read posts'}
          </Button>
        </div>
        {data?.lastImport ? (
          <p className="text-muted mt-3 text-sm">
            {importing ? (
              'Reading the posts from WordPress…'
            ) : data.lastImport.status === 'FAILED' ? (
              <span className="text-rose-600">Reading the posts did not work: {data.lastImport.error}</span>
            ) : (
              <>
                Last read <RelativeTime value={data.lastImport.at} />: {plural(data.lastImport.result.read ?? 0, 'post')} ({data.lastImport.result.added ?? 0} new){data.lastImport.result.capped ? ' — stopped at 5,000; read by category or age for the rest' : ''}.
              </>
            )}
          </p>
        ) : null}
      </Card>

      <Card
        title="2 · Update to latest"
        description="ChatGPT checks each post against current sources and updates what is outdated (ages, years, numbers, news), keeping its structure, keyword, images and links. The app checks every answer; you compare the versions and approve. Updates run in the ChatGPT tab one after another."
        padded={false}
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {selected.size ? (
              <button type="button" className="text-muted text-sm underline" onClick={() => setSelected(new Set())}>
                Clear selection
              </button>
            ) : null}
            <Button size="sm" onClick={() => void update([...selected])} disabled={busy || !selected.size || tooMany} title={tooMany ? `Choose up to ${MAX_BATCH} posts at a time` : undefined}>
              <FileClock className="h-3.5 w-3.5" /> Update selected{selected.size ? ` (${selected.size})` : ''}
            </Button>
          </div>
        }
      >
        {site && !site.allowLiveUpdates ? (
          <div className="px-5 pt-4">
            <Alert tone="info" title="Published posts need your permission to change">
              Before an approved update can be written to a published post, turn on <strong>Allow approved updates to live posts</strong> on the website's page (Publishing permission). You still approve every update yourself, typing UPDATE LIVE POST.
            </Alert>
          </div>
        ) : null}
        {tooMany ? (
          <div className="px-5 pt-4">
            <Alert tone="warning" title={`${selected.size} posts selected`}>
              Up to {MAX_BATCH} posts start at a time, so ChatGPT is not given more than you can review. Clear some of the selection, then start the rest later.
            </Alert>
          </div>
        ) : null}

        {/* Where the posts stand: one click shows only those. */}
        <div className="flex flex-wrap gap-2 px-5 pt-4" role="group" aria-label="Show posts by update state">
          {(['all', ...UPDATE_STATES] as const).map((s) => {
            const count = facets?.states[s] ?? 0;
            const on = s === 'all' ? !view.state : view.state === s;
            if (!on && s !== 'all' && s !== 'none' && count === 0) return null;
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => change({ state: s === 'all' ? '' : s })}
                className={cx(
                  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition',
                  on ? 'border-[var(--text)] bg-[var(--text)] font-medium text-[var(--bg)]' : 'border-app hover:bg-[var(--surface-2)]',
                )}
              >
                {s === 'all' ? 'All posts' : UPDATE_STATE_LABEL[s]}
                <span className={cx('tabular-nums text-xs', on ? 'opacity-80' : 'text-muted')}>{count.toLocaleString('en')}</span>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 gap-3 px-5 pt-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <Field label="Search" htmlFor="up-q" className="sm:col-span-2 lg:col-span-4 xl:col-span-2">
            <div className="relative">
              <Search className="text-muted pointer-events-none absolute top-2.5 left-2.5 h-4 w-4" aria-hidden />
              <Input id="up-q" type="search" placeholder="Title or address" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </Field>
          <Field label="Not changed for" htmlFor="up-older">
            <Select id="up-older" value={view.older} onChange={(e) => change({ older: e.target.value })}>
              <option value="">Any time</option>
              {POST_AGES.map((m) => (
                <option key={m} value={String(m)}>
                  {AGE_LABEL(m)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Category" htmlFor="up-fcat">
            <Select id="up-fcat" value={view.category} onChange={(e) => change({ category: e.target.value })}>
              <option value="">All categories</option>
              {view.category && !facets?.categories.some((c) => String(c.id) === view.category) ? <option value={view.category}>{categoryName.get(Number(view.category)) ?? view.category} (0)</option> : null}
              {(facets?.categories ?? []).map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name} ({c.count.toLocaleString('en')})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Published" htmlFor="up-year">
            <Select id="up-year" value={view.year} onChange={(e) => change({ year: e.target.value })}>
              <option value="">Any year</option>
              {view.year && !facets?.years.some((y) => String(y.year) === view.year) ? <option value={view.year}>{view.year} (0)</option> : null}
              {(facets?.years ?? []).map((y) => (
                <option key={y.year} value={String(y.year)}>
                  {y.year} ({y.count.toLocaleString('en')})
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Length" htmlFor="up-length">
            <Select id="up-length" value={view.length} onChange={(e) => change({ length: e.target.value as PostLength | '' })}>
              <option value="">Any length</option>
              {POST_LENGTHS.map((l) => (
                <option key={l} value={l}>
                  {POST_LENGTH_LABEL[l]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Written by" htmlFor="up-source">
            <Select id="up-source" value={view.source} onChange={(e) => change({ source: e.target.value as PostSource | '' })}>
              <option value="">Anyone</option>
              <option value="app">The app</option>
              <option value="other">Not the app</option>
            </Select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-5 py-3">
          {active.map((f) => (
            <span key={f.key} className="border-app inline-flex items-center gap-1 rounded-full border bg-[var(--surface-2)] py-0.5 pr-1 pl-2.5 text-xs">
              {f.label}
              <button
                type="button"
                aria-label={`Remove filter: ${f.label}`}
                className="rounded-full p-0.5 hover:bg-[var(--surface)]"
                onClick={() => {
                  if (f.key === 'q') setQ('');
                  change({ [f.key]: '' } as Partial<View>);
                }}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ))}
          {active.length ? (
            <button type="button" className="text-muted text-xs underline" onClick={clearAll}>
              Clear all filters
            </button>
          ) : null}
          <div className="ml-auto flex items-center gap-2 text-sm">
            <label htmlFor="up-sort" className="text-muted whitespace-nowrap">
              Sort by
            </label>
            <div className="w-60">
              <Select id="up-sort" value={view.sort} onChange={(e) => change({ sort: e.target.value as PostSort })}>
                {POST_SORTS.map((s) => (
                  <option key={s} value={s}>
                    {POST_SORT_LABEL[s]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </div>

        {!data ? null : data.posts.length === 0 ? (
          <div className="px-5 pb-6">
            {data.all === 0 ? (
              <EmptyState title="No posts read yet" description="Use “Read posts” above." />
            ) : (
              <EmptyState
                title="No post matches these filters"
                description={
                  <>
                    {plural(data.all, 'post')} in all.{' '}
                    <button type="button" className="underline" onClick={clearAll}>
                      Clear all filters
                    </button>
                  </>
                }
              />
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="table-app">
              <thead>
                <tr>
                  <th className="w-8">
                    <input
                      type="checkbox"
                      aria-label="Select all on this page"
                      checked={selectable.length > 0 && selectable.every((p) => selected.has(p.id))}
                      onChange={(e) => setSelected(e.target.checked ? new Set([...selected, ...selectable.map((p) => p.id)]) : new Set([...selected].filter((id) => !selectable.some((p) => p.id === id))))}
                    />
                  </th>
                  <SortHeader label="Post" column="title" sort={view.sort} onSort={(s) => change({ sort: s })} />
                  <SortHeader label="Published" column="published" sort={view.sort} onSort={(s) => change({ sort: s })} />
                  <SortHeader label="Last changed" column="changed" sort={view.sort} onSort={(s) => change({ sort: s })} />
                  <SortHeader label="Words" column="words" sort={view.sort} onSort={(s) => change({ sort: s })} />
                  <SortHeader label="Update" column="update" sort={view.sort} onSort={(s) => change({ sort: s })} />
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.posts.map((p) => {
                  const st = p.lastUpdate ? UPDATE_STATUS[p.lastUpdate.status] : null;
                  const busyPost = Boolean(p.lastUpdate && ACTIVE.includes(p.lastUpdate.status));
                  const cats = p.categoryIds.map((c) => categoryName.get(c)).filter(Boolean);
                  return (
                    <tr key={p.id}>
                      <td>
                        <input type="checkbox" aria-label={`Select ${p.title}`} disabled={busyPost} checked={selected.has(p.id)} onChange={(e) => setSelected((s) => (e.target.checked ? new Set([...s, p.id]) : new Set([...s].filter((x) => x !== p.id))))} />
                      </td>
                      <td className="max-w-md">
                        <a className="link inline-flex items-center gap-1 font-medium" href={p.url} target="_blank" rel="noreferrer">
                          {p.title || `Post #${p.wpPostId}`} <ExternalLink className="text-muted h-3 w-3 shrink-0" aria-hidden />
                        </a>
                        {cats.length || p.taskId ? (
                          <div className="text-muted mt-0.5 flex flex-wrap gap-x-2 text-xs">
                            {cats.length ? <span>{cats.join(', ')}</span> : null}
                            {p.taskId ? (
                              <Link className="underline" href={`/articles/${p.taskId}`}>
                                written by the app
                              </Link>
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap" title={formatDateTime(p.publishedAt)}>
                        {p.publishedAt ? new Date(p.publishedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                      </td>
                      <td className="whitespace-nowrap" title={formatDateTime(p.modifiedAt)}>
                        {ageAgo(p.modifiedAt)}
                      </td>
                      <td className="tabular-nums">{p.words.toLocaleString('en')}</td>
                      <td>
                        {p.lastUpdate && st ? (
                          <div className="flex flex-col items-start gap-0.5">
                            <Link href={`/update-posts/${p.lastUpdate.id}`}>
                              <Chip tone={st.tone}>{st.label}</Chip>
                            </Link>
                            <span className="text-muted text-xs">
                              <RelativeTime value={p.lastUpdate.createdAt} />
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted text-sm">—</span>
                        )}
                      </td>
                      <td className="text-right whitespace-nowrap">
                        {busyPost ? (
                          <Link className="inline-flex items-center gap-1 text-sm font-medium underline" href={`/update-posts/${p.lastUpdate!.id}`}>
                            Open <ArrowRight className="h-3.5 w-3.5" />
                          </Link>
                        ) : (
                          <Button size="sm" onClick={() => void update([p.id])} disabled={busy}>
                            <FileClock className="h-3.5 w-3.5" /> Update to latest
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {data && data.total > 0 ? (
          <div className="border-app border-t px-5">
            <Pagination total={data.total} page={data.page} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} label="posts" />
          </div>
        ) : null}
      </Card>
    </div>
  );
}
