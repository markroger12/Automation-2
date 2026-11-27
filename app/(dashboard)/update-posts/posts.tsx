'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, ExternalLink, FileClock, RefreshCw, Search } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, RelativeTime, useToast } from '@/components/client';
import { Field, Input, Select } from '@/components/form';
import { Alert, Card, Chip, EmptyState, formatDateTime, plural } from '@/components/ui';

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
  publishedAt: string | null;
  modifiedAt: string | null;
  lastUpdate: { id: string; status: string; createdAt: string; appliedAt: string | null } | null;
}
interface PostList {
  total: number;
  page: number;
  pageSize: number;
  posts: PostRow[];
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

export function UpdatePosts({ websites, initialWebsite }: { websites: WebsiteOption[]; initialWebsite: string | null }) {
  const toast = useToast();
  const [websiteId, setWebsiteId] = useState(initialWebsite && websites.some((w) => w.id === initialWebsite) ? initialWebsite : (websites[0]?.id ?? ''));
  const [age, setAge] = useState('12');
  const [category, setCategory] = useState('');
  const [q, setQ] = useState('');
  const [onlyOld, setOnlyOld] = useState(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PostList | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const site = websites.find((w) => w.id === websiteId);

  const load = useCallback(async () => {
    if (!websiteId) return;
    const params = new URLSearchParams({ websiteId, page: String(page) });
    if (q.trim()) params.set('q', q.trim());
    if (onlyOld) params.set('older', '12');
    setData(await api<PostList>(`/api/site-posts?${params}`));
  }, [websiteId, page, q, onlyOld]);

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
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const selectable = (data?.posts ?? []).filter((p) => !(p.lastUpdate && ACTIVE.includes(p.lastUpdate.status)));

  return (
    <div className="space-y-6">
      {websites.length > 1 ? (
        <Field label="Website" htmlFor="up-site" className="max-w-sm">
          <Select
            id="up-site"
            value={websiteId}
            onChange={(e) => {
              setWebsiteId(e.target.value);
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
          <Button size="sm" onClick={() => void update([...selected])} disabled={busy || !selected.size}>
            <FileClock className="h-3.5 w-3.5" /> Update selected{selected.size ? ` (${selected.size})` : ''}
          </Button>
        }
      >
        {site && !site.allowLiveUpdates ? (
          <div className="px-5 pt-4">
            <Alert tone="info" title="Published posts need your permission to change">
              Before an approved update can be written to a published post, turn on <strong>Allow approved updates to live posts</strong> on the website's page (Publishing permission). You still approve every update yourself, typing UPDATE LIVE POST.
            </Alert>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 px-5 py-4">
          <div className="relative w-full max-w-xs">
            <Search className="text-muted pointer-events-none absolute top-2.5 left-2.5 h-4 w-4" aria-hidden />
            <Input
              aria-label="Search titles"
              placeholder="Search titles"
              className="pl-8"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={onlyOld}
              onChange={(e) => {
                setOnlyOld(e.target.checked);
                setPage(1);
              }}
            />
            Only posts not changed for 12+ months
          </label>
          <span className="text-muted ml-auto text-sm">{data ? plural(data.total, 'post') : ''}</span>
        </div>
        {!data ? null : data.posts.length === 0 ? (
          <div className="px-5 pb-6">
            <EmptyState title={data.total === 0 && !q && !onlyOld ? 'No posts read yet' : 'No post matches'} description={data.total === 0 && !q && !onlyOld ? 'Use “Read posts” above.' : undefined} />
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
                  <th>Post</th>
                  <th>Last changed</th>
                  <th>Words</th>
                  <th>Update</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.posts.map((p) => {
                  const st = p.lastUpdate ? UPDATE_STATUS[p.lastUpdate.status] : null;
                  const active = Boolean(p.lastUpdate && ACTIVE.includes(p.lastUpdate.status));
                  return (
                    <tr key={p.id}>
                      <td>
                        <input type="checkbox" aria-label={`Select ${p.title}`} disabled={active} checked={selected.has(p.id)} onChange={(e) => setSelected((s) => (e.target.checked ? new Set([...s, p.id]) : new Set([...s].filter((x) => x !== p.id))))} />
                      </td>
                      <td className="max-w-md">
                        <a className="link inline-flex items-center gap-1 font-medium" href={p.url} target="_blank" rel="noreferrer">
                          {p.title || `Post #${p.wpPostId}`} <ExternalLink className="text-muted h-3 w-3 shrink-0" aria-hidden />
                        </a>
                        {p.taskId ? (
                          <div className="mt-0.5">
                            <Link className="text-muted text-xs underline" href={`/articles/${p.taskId}`}>
                              written by the app
                            </Link>
                          </div>
                        ) : null}
                      </td>
                      <td className="whitespace-nowrap" title={formatDateTime(p.modifiedAt)}>
                        <RelativeTime value={p.modifiedAt} />
                      </td>
                      <td className="tabular-nums">{p.words.toLocaleString('en')}</td>
                      <td>
                        {p.lastUpdate && st ? (
                          <Link href={`/update-posts/${p.lastUpdate.id}`}>
                            <Chip tone={st.tone}>{st.label}</Chip>
                          </Link>
                        ) : (
                          <span className="text-muted text-sm">—</span>
                        )}
                      </td>
                      <td className="text-right whitespace-nowrap">
                        {active ? (
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
        {data && pages > 1 ? (
          <div className="flex items-center justify-end gap-2 px-5 py-3 text-sm">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>
              Previous
            </Button>
            <span className="text-muted">
              Page {page} of {pages}
            </span>
            <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => setPage((n) => n + 1)}>
              Next
            </Button>
          </div>
        ) : null}
      </Card>
    </div>
  );
}
