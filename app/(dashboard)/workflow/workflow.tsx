'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpToLine,
  CalendarClock,
  ChevronDown,
  ExternalLink,
  Eye,
  FastForward,
  ImageIcon,
  Lightbulb,
  ListFilter,
  MoreHorizontal,
  PenLine,
  Plus,
  RotateCcw,
  Save,
  ScanSearch,
  Search,
  Send,
  Settings2,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, ConfirmDialog, DialogSection, Modal, useToast } from '@/components/client';
import { Menu, MenuCheck, MenuItem, MenuLabel, Pagination, pageSlice, usePageSize } from '@/components/data-table';
import { TimePicker } from '@/components/time-picker';
import { IndexingPanel } from '@/components/indexing-panel';
import { ScreenshotModal } from '@/components/screenshot-modal';
import { KeywordIdeas } from './keyword-ideas';
import { MoveKeywords } from './move-keywords';
import { Field, Input, Select, Switch, Textarea } from '@/components/form';
import { Card, Chip, PageHeader, StatusChip, cx, type ChipTone } from '@/components/ui';
import { formatInZone } from '@/lib/workflow/time';
import { inspectionProperty, searchConsoleHome } from '@/lib/workflow/search-console';
import { KEYWORD_LABEL as KW_LABEL, KEYWORD_STATUSES, filterKeywords, readableTimes, statusCounts } from '@/lib/workflow/queue-view';

interface Site {
  id: string;
  name: string;
  active: boolean;
}
interface Keyword {
  id: string;
  keyword: string;
  secondaryKeywords: string[];
  writerType: string;
  detectionReason: string | null;
  status: string;
  scheduledAt: string | null;
  publishedUrl: string | null;
  indexingStatus: string | null;
  retries: number;
  lastError: string | null;
  position: number;
  task: { id: string; status: string; wpPostId: number | null; wpEditUrl: string | null } | null;
  /** Screenshot of Search Console's answer after “Request indexing”. */
  proofId?: string | null;
  /** Google's URL Inspection link for the post (from the URL Inspection API). */
  inspectLink?: string | null;
}
interface View {
  website: { id: string; name: string; timezone: string; canPublish: boolean; publicUrl: string };
  workflow: null | { id: string; active: boolean; writerPreference: string; slots: string[]; weekdays: number[]; slotTimezone: string; writeAheadHours: number; maxBacklog: number; imagesOverride: string; requestIndexing: boolean; searchConsoleProperty: string | null; maxRetries: number };
  nextSlots: string[];
  keywords: Keyword[];
}
interface PreviewRow {
  line: number;
  keyword: string;
  writerType: string;
  detectionReason: string;
  duplicateOf: string | null;
  errors: string[];
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const KW_TONE: Record<string, ChipTone> = { WAITING: 'neutral', WRITING: 'info', READY: 'brand', SCHEDULED: 'brand', PUBLISHED: 'success', INDEXING_REQUESTED: 'success', INDEXED: 'success', FAILED: 'danger', SKIPPED: 'neutral', DONE: 'neutral' };
const COLUMNS = [
  { id: 'writer', label: 'Writer' },
  { id: 'slot', label: 'Slot (PK)' },
  { id: 'article', label: 'Article' },
  { id: 'links', label: 'Links' },
  { id: 'notes', label: 'Google / notes' },
] as const;
type ColumnId = (typeof COLUMNS)[number]['id'];
const COLUMNS_KEY = 'bas:workflow-columns';

export function WorkflowPage({ sites, initialSiteId, description }: { sites: Site[]; initialSiteId: string; description: string }) {
  const toast = useToast();
  const [siteId, setSiteId] = useState(initialSiteId);
  const [view, setView] = useState<View | null>(null);
  const [form, setForm] = useState({ active: false, writerPreference: 'AUTO', slots: ['9:00 AM'], weekdays: [] as number[], writeAheadHours: 24, maxBacklog: 10, imagesOverride: 'inherit', requestIndexing: false, searchConsoleProperty: '', maxRetries: 3 });
  const [newSlot, setNewSlot] = useState('');
  const [saving, setSaving] = useState(false);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [keep, setKeep] = useState<Set<number>>(new Set());
  // Owner request: choose the writer right in Add keywords (by line; missing = the detected one).
  const [writers, setWriters] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [acted, setActed] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteArticles, setDeleteArticles] = useState(false);
  const [confirmForce, setConfirmForce] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Owner request: “I have to scroll so much” — settings and new keywords open in a window, the queue has pages.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [q, setQ] = useState('');
  const [statuses, setStatuses] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePageSize('workflow-keywords', 20);
  const [hidden, setHidden] = useState<ColumnId[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // The Search Console screenshot shown over the page (owner request: not in a new tab).
  const [shot, setShot] = useState<{ id: string; title: string; caption?: string } | null>(null);
  // Keyword ideas from Search Console and Google (owner request).
  const [ideasOpen, setIdeasOpen] = useState(false);

  useEffect(() => {
    try {
      setHidden(JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? '[]') as ColumnId[]);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const toggleColumn = (id: ColumnId, show: boolean) =>
    setHidden((h) => {
      const next = show ? h.filter((x) => x !== id) : [...h, id];
      try {
        localStorage.setItem(COLUMNS_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  const shows = (id: ColumnId) => !hidden.includes(id);

  const fillForm = (v: View) => {
    if (v.workflow) setForm({ active: v.workflow.active, writerPreference: v.workflow.writerPreference, slots: v.workflow.slots, weekdays: v.workflow.weekdays, writeAheadHours: v.workflow.writeAheadHours, maxBacklog: v.workflow.maxBacklog, imagesOverride: v.workflow.imagesOverride, requestIndexing: v.workflow.requestIndexing, searchConsoleProperty: v.workflow.searchConsoleProperty ?? '', maxRetries: v.workflow.maxRetries });
    else setForm((f) => ({ ...f, active: false }));
  };

  const load = useCallback(async () => {
    const v = await api<View>(`/api/websites/${siteId}/workflow`);
    setView(v);
    return v;
  }, [siteId]);

  useEffect(() => {
    void load().then(fillForm);
    const t = setInterval(() => void load().catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      await api(`/api/websites/${siteId}/workflow`, { method: 'PUT', body: form });
      toast('success', form.active ? 'Workflow saved and switched on. The scheduler checks every minute.' : 'Workflow saved (switched off).');
      await load();
      setSettingsOpen(false);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function runPreview() {
    try {
      const r = await api<{ rows: PreviewRow[]; problems: string[] }>(`/api/websites/${siteId}/workflow/keywords/preview`, { body: { text } });
      setPreview(r.rows);
      setKeep(new Set());
      setWriters({});
      if (r.problems.length) toast('info', r.problems.join(' '));
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function addAll() {
    try {
      const r = await api<{ added: number; skippedDuplicates: number; invalid: number }>(`/api/websites/${siteId}/workflow/keywords`, { body: { text, keepDuplicates: [...keep], writers } });
      toast('success', `${r.added} keyword(s) added${r.skippedDuplicates ? `, ${r.skippedDuplicates} duplicate(s) left out` : ''}${r.invalid ? `, ${r.invalid} invalid` : ''}.`);
      setText('');
      setPreview(null);
      setAddOpen(false);
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function action(act: string, extra: Record<string, unknown> = {}, done = (n: number) => `${n} keyword(s) updated.`) {
    try {
      const r = await api<{ changed: number; notes: string[] }>(`/api/websites/${siteId}/workflow/keywords/action`, { body: { keywordIds: [...selected], action: act, ...extra } });
      toast(r.notes.length ? 'info' : 'success', `${done(r.changed)}${r.notes.length ? ` ${r.notes.slice(0, 3).join(' ')}` : ''}`);
      setSelected(new Set());
      await load();
      setActed((n) => n + 1);
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function removeKeywords() {
    setBusy(true);
    try {
      const r = await api<{ changed: number; notes: string[] }>(`/api/websites/${siteId}/workflow/keywords/action`, { body: { keywordIds: [...selected], action: 'delete', articles: deleteArticles } });
      toast('success', `${r.changed} keyword(s) deleted${deleteArticles ? ' with their articles' : ''}. WordPress was not changed.${r.notes.length ? ` ${r.notes.slice(0, 3).join(' ')}` : ''}`);
      setSelected(new Set());
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  const counts = useMemo(() => statusCounts(view?.keywords ?? []), [view]);
  const rows = useMemo(() => filterKeywords(view?.keywords ?? [], { q, statuses }), [view, q, statuses]);
  const shown = pageSlice(rows, page, pageSize);
  // A new search or filter starts on the first page.
  useEffect(() => setPage(1), [q, statuses, siteId]);

  const siteSelect = (
    <Select
      aria-label="Website"
      className="h-9 w-56! py-0"
      value={siteId}
      onChange={(e) => {
        setSiteId(e.target.value);
        setSelected(new Set());
        setPreview(null);
        setView(null);
      }}
    >
      {sites.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
          {s.active ? '' : ' (inactive)'}
        </option>
      ))}
    </Select>
  );

  if (!view)
    return (
      <>
        <PageHeader title="Workflow" description={description} actions={siteSelect} />
        <Card>
          <p className="text-muted text-sm">Loading…</p>
        </Card>
      </>
    );
  const tz = form.slots.length ? (view.workflow?.slotTimezone ?? 'Asia/Karachi') : 'Asia/Karachi';
  const pageIds = shown.map((k) => k.id);
  const pageAllSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const selectedRows = view.keywords.filter((k) => selected.has(k.id));

  return (
    <div>
      <PageHeader
        title="Workflow"
        description={description}
        actions={
          <>
            {siteSelect}
            <Button onClick={() => { if (view) fillForm(view); setSettingsOpen(true); }}>
              <Settings2 className="h-4 w-4" /> Settings
            </Button>
            <Button onClick={() => setIdeasOpen(true)}>
              <Lightbulb className="h-4 w-4" /> Keyword ideas
            </Button>
            <Button variant="primary" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4" /> Add keywords
            </Button>
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <Chip tone={view.workflow?.active ? 'success' : 'neutral'}>{view.workflow?.active ? 'Workflow on' : 'Workflow off'}</Chip>
        {view.website.canPublish ? (
          <Chip tone="warning">publishing allowed (scheduler only)</Chip>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <Chip>drafts only</Chip>
            <span className="text-muted">Nothing is scheduled or published until you allow publishing on the website's page.</span>
          </span>
        )}
        {view.nextSlots.length ? (
          <span className="text-muted flex items-center gap-1.5" title={`${formatInZone(view.nextSlots[0], view.website.timezone)} on the website's clock (${view.website.timezone})`}>
            <CalendarClock className="h-4 w-4" aria-hidden /> Next slot: <span className="text-[var(--text)]">{formatInZone(view.nextSlots[0], tz)} PK</span>
          </span>
        ) : null}
        <span className="ml-auto flex gap-4">
          <Link className="text-muted hover:text-[var(--text)] hover:underline" href={`/websites/${view.website.id}`}>
            Publishing permission →
          </Link>
          <Link className="text-muted hover:text-[var(--text)] hover:underline" href="/calendar">
            Publishing calendar →
          </Link>
        </span>
      </div>

      {view.workflow?.requestIndexing || view.keywords.some((k) => k.publishedUrl) ? (
        <div className="mb-6">
          <IndexingPanel version={acted} />
        </div>
      ) : null}

      <section aria-label="Keyword queue">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-base font-semibold">Keyword queue</h2>
          <label className="surface border-app flex h-8 w-64 max-w-full items-center gap-2 rounded-md border px-2.5">
            <Search className="text-muted h-4 w-4 shrink-0" aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search keywords" aria-label="Search keywords" className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-[var(--text-muted)]" />
            {q ? (
              <button type="button" aria-label="Clear the search" onClick={() => setQ('')}>
                <X className="text-muted h-3.5 w-3.5" />
              </button>
            ) : null}
          </label>
          <Menu label="Filter" icon={<ListFilter className="h-3.5 w-3.5" />} badge={statuses.length ? <span className="rounded bg-[var(--surface-2)] px-1 tabular-nums">{statuses.length}</span> : null}>
            {() => (
              <>
                <MenuLabel>Status</MenuLabel>
                {KEYWORD_STATUSES.filter((s) => counts[s] || statuses.includes(s)).map((s) => (
                  <MenuCheck key={s} checked={statuses.includes(s)} count={counts[s] ?? 0} onChange={(v) => setStatuses((x) => (v ? [...x, s] : x.filter((y) => y !== s)))}>
                    {KW_LABEL[s] ?? s.toLowerCase()}
                  </MenuCheck>
                ))}
                {statuses.length ? <MenuItem onClick={() => setStatuses([])}>Show every status</MenuItem> : null}
              </>
            )}
          </Menu>
          {statuses.map((s) => (
            <button key={s} type="button" onClick={() => setStatuses((x) => x.filter((y) => y !== s))} className="inline-flex" aria-label={`Remove the filter ${KW_LABEL[s] ?? s}`}>
              <Chip tone={KW_TONE[s] ?? 'neutral'}>
                {KW_LABEL[s] ?? s} <X className="h-3 w-3" aria-hidden />
              </Chip>
            </button>
          ))}
          <div className="ml-auto">
            <Menu label="View" icon={<SlidersHorizontal className="h-3.5 w-3.5" />} align="end">
              {() => (
                <>
                  <MenuLabel>Columns</MenuLabel>
                  {COLUMNS.map((c) => (
                    <MenuCheck key={c.id} checked={shows(c.id)} onChange={(v) => toggleColumn(c.id, v)}>
                      {c.label}
                    </MenuCheck>
                  ))}
                </>
              )}
            </Menu>
          </div>
        </div>

        {selected.size ? (
          <div className="border-app surface-2 mb-3 flex flex-wrap items-center gap-1.5 rounded-lg border px-3 py-2 text-sm">
            <strong className="mr-1">{selected.size} selected</strong>
            <Button size="sm" onClick={() => void action('retry')}>
              <RotateCcw className="h-3.5 w-3.5" /> Retry
            </Button>
            <Button size="sm" onClick={() => setConfirmForce(true)} title="Continue a stopped article despite the problems found">
              <FastForward className="h-3.5 w-3.5" /> Force continue
            </Button>
            <Button size="sm" onClick={() => void action('request-indexing', {}, (n) => `Automation Chrome requests indexing in Search Console for ${n} keyword(s) now; Google's answer shows on each keyword.`)} title="Automation Chrome inspects the post URL in Search Console and clicks REQUEST INDEXING now">
              <Send className="h-3.5 w-3.5" /> Request indexing
            </Button>
            <Button size="sm" onClick={() => setMoveOpen(true)} title="Move the selected keywords to another day's slots (e.g. all to tomorrow)">
              <CalendarClock className="h-3.5 w-3.5" /> Move to day
            </Button>
            <Menu label="More" icon={<MoreHorizontal className="h-3.5 w-3.5" />}>
              {(close) => (
                <>
                  <MenuLabel>Writer</MenuLabel>
                  <MenuItem icon={<PenLine className="h-3.5 w-3.5" />} onClick={() => { close(); void action('writer', { writer: 'celebrity-writer' }); }}>
                    Celebrity
                  </MenuItem>
                  <MenuItem icon={<PenLine className="h-3.5 w-3.5" />} onClick={() => { close(); void action('writer', { writer: 'tigram-writer' }); }}>
                    Tigram
                  </MenuItem>
                  <MenuLabel>Queue</MenuLabel>
                  <MenuItem icon={<ArrowUpToLine className="h-3.5 w-3.5" />} onClick={() => { close(); void action('top'); }}>
                    To top
                  </MenuItem>
                  <MenuItem onClick={() => { close(); void action('skip'); }}>Skip</MenuItem>
                  <MenuItem onClick={() => { close(); void action('restore'); }}>Restore</MenuItem>
                  <MenuLabel>Indexing done by you</MenuLabel>
                  <MenuItem title="You requested indexing yourself in Search Console" onClick={() => { close(); void action('indexing-requested'); }}>
                    Mark requested
                  </MenuItem>
                  <MenuItem title="You checked in Search Console that the URL is on Google" onClick={() => { close(); void action('indexed'); }}>
                    Mark indexed
                  </MenuItem>
                </>
              )}
            </Menu>
            <Button size="sm" variant="danger" onClick={() => { setDeleteArticles(false); setConfirmDelete(true); }}>
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>
              Clear selection
            </Button>
          </div>
        ) : null}

        <div className="table-box">
          <table className="table-app">
            <thead>
              <tr>
                <th className="w-10">
                  <input
                    type="checkbox"
                    aria-label="Select every keyword on this page"
                    checked={pageAllSelected}
                    onChange={() =>
                      setSelected((s) => {
                        const n = new Set(s);
                        for (const id of pageIds) pageAllSelected ? n.delete(id) : n.add(id);
                        return n;
                      })
                    }
                  />
                </th>
                <th>Keyword</th>
                {shows('writer') ? <th>Writer</th> : null}
                <th>Status</th>
                {shows('slot') ? <th>Slot (PK)</th> : null}
                {shows('article') ? <th>Article</th> : null}
                {shows('links') ? <th>Links</th> : null}
                {shows('notes') ? <th className="w-[38%]">Google / notes</th> : null}
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-muted py-10 text-center text-sm">
                    {view.keywords.length === 0 ? 'No keywords yet. Use “Add keywords” to start the queue.' : 'No keyword matches this search or filter.'}
                  </td>
                </tr>
              ) : null}
              {shown.map((k) => {
                const note = k.lastError ?? k.indexingStatus ?? '';
                const open = expanded.has(k.id);
                const indexingLink = k.publishedUrl && view.workflow?.requestIndexing && ['PUBLISHED', 'INDEXING_REQUESTED'].includes(k.status);
                return (
                  <tr key={k.id} className={selected.has(k.id) ? 'bg-[var(--surface-2)]' : undefined}>
                    <td>
                      <input type="checkbox" aria-label={`Select ${k.keyword}`} checked={selected.has(k.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); e.target.checked ? n.add(k.id) : n.delete(k.id); return n; })} />
                    </td>
                    <td className="max-w-64">
                      {/* Owner request: the keyword opens its article page in the tool (once an article was started). */}
                      {k.task ? (
                        <Link href={`/articles/${k.task.id}`} className="block truncate font-medium hover:underline" title={`Open the article: ${k.keyword}`}>
                          {k.keyword}
                        </Link>
                      ) : (
                        <div className="truncate font-medium" title={`${k.keyword} — no article yet`}>
                          {k.keyword}
                        </div>
                      )}
                    </td>
                    {shows('writer') ? (
                      <td className="text-muted text-xs whitespace-nowrap" title={k.detectionReason ?? undefined}>
                        {k.writerType === 'UNKNOWN' ? <Chip tone="warning">choose</Chip> : k.writerType.toLowerCase()}
                      </td>
                    ) : null}
                    <td>
                      <Chip tone={KW_TONE[k.status] ?? 'neutral'}>{KW_LABEL[k.status] ?? k.status}</Chip>
                    </td>
                    {shows('slot') ? <td className="text-xs whitespace-nowrap">{k.scheduledAt ? formatInZone(k.scheduledAt, tz) : '—'}</td> : null}
                    {shows('article') ? (
                      <td className="whitespace-nowrap">
                        {k.task ? (
                          <Link href={`/articles/${k.task.id}`}>
                            <StatusChip status={k.task.status} />
                          </Link>
                        ) : (
                          <span className="text-muted">—</span>
                        )}
                      </td>
                    ) : null}
                    {shows('links') ? (
                      <td className="whitespace-nowrap">
                        <div className="flex items-center gap-1">
                          {k.publishedUrl ? (
                            <a className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border)] hover:bg-[var(--surface-2)]" href={k.publishedUrl} target="_blank" rel="noreferrer" data-tip="Live post" aria-label={`Live post: ${k.keyword}`}>
                              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                            </a>
                          ) : null}
                          {k.proofId ? (
                            <button
                              type="button"
                              className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border)] hover:bg-[var(--surface-2)]"
                              onClick={() => setShot({ id: k.proofId!, title: `Search Console screenshot: ${k.keyword}`, caption: k.publishedUrl ?? undefined })}
                              data-tip="Search Console screenshot"
                              aria-label={`Search Console screenshot: ${k.keyword}`}
                            >
                              <ImageIcon className="h-3.5 w-3.5" aria-hidden />
                            </button>
                          ) : null}
                          {indexingLink ? (
                            <a
                              className="grid h-7 w-7 place-items-center rounded-md border border-[var(--border)] hover:bg-[var(--surface-2)]"
                              href={k.inspectLink ?? searchConsoleHome(inspectionProperty(view.workflow!.searchConsoleProperty, view.website.publicUrl))}
                              target="_blank"
                              rel="noreferrer"
                              data-tip={k.inspectLink ? 'Inspect in Search Console' : 'Open Search Console'}
                              aria-label={`${k.inspectLink ? 'Inspect in Search Console' : 'Open Search Console'}: ${k.keyword}`}
                            >
                              <ScanSearch className="h-3.5 w-3.5" aria-hidden />
                            </a>
                          ) : null}
                          {!k.publishedUrl && !k.proofId ? <span className="text-muted">—</span> : null}
                        </div>
                      </td>
                    ) : null}
                    {shows('notes') ? (
                      <td className={cx('text-xs', k.lastError ? 'text-amber-700 dark:text-amber-300' : k.status === 'INDEXED' ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted')}>
                        {note ? (
                          <div className="flex items-start gap-1.5">
                            <span className={cx('min-w-0 flex-1', open ? 'whitespace-pre-wrap break-words' : 'line-clamp-1 break-all')} title={open ? undefined : readableTimes(note, tz)}>
                              {readableTimes(note, tz)}
                            </span>
                            {note.length > 70 ? (
                              <button
                                type="button"
                                aria-expanded={open}
                                aria-label={open ? 'Show less' : 'Show the whole message'}
                                onClick={() => setExpanded((s) => { const n = new Set(s); open ? n.delete(k.id) : n.add(k.id); return n; })}
                                className="text-muted -my-0.5 shrink-0 rounded p-0.5 hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
                              >
                                <ChevronDown className={cx('h-3.5 w-3.5 transition', open && 'rotate-180')} aria-hidden />
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Pagination total={rows.length} page={page} pageSize={pageSize} onPage={setPage} onPageSize={setPageSize} label="keywords" />
      </section>

      <Modal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Workflow settings"
        description={`${view.website.name}: one article per slot. Slots are Pakistan time (Asia/Karachi) and stored as UTC.`}
        footer={
          <>
            <Button onClick={() => setSettingsOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => void save()} loading={saving}>
              <Save className="h-4 w-4" /> Save workflow
            </Button>
          </>
        }
      >
        <Switch label={form.active ? 'Workflow on' : 'Workflow off'} help="The scheduler starts articles for upcoming slots and (if allowed) schedules ready drafts." checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
        <DialogSection icon={<PenLine className="h-3.5 w-3.5" />} title="Writer">
          <Field label="Writer" htmlFor="wf-writer">
            <Select id="wf-writer" value={form.writerPreference} onChange={(e) => setForm({ ...form, writerPreference: e.target.value })}>
              <option value="AUTO">Per keyword (Smart Router; unclear ones wait for you)</option>
              <option value="celebrity-writer">Celebrity Article Writer for every keyword</option>
              <option value="tigram-writer">Tigram Article Writer for every keyword</option>
            </Select>
          </Field>
        </DialogSection>
        <DialogSection icon={<CalendarClock className="h-3.5 w-3.5" />} title="Schedule">
          <div>
            <p className="mb-1.5 text-sm font-medium">Publishing slots (Pakistan time)</p>
            <div className="flex flex-wrap gap-1.5">
              {form.slots.map((s) => (
                <span key={s} className="surface-2 inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm">
                  {s}
                  <button type="button" aria-label={`Remove ${s}`} onClick={() => setForm({ ...form, slots: form.slots.filter((x) => x !== s) })}>
                    <X className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
            </div>
            <div className="mt-2 flex gap-2">
              <TimePicker ariaLabel="New slot" placeholder="3:30 PM" value={newSlot} onChange={setNewSlot} className="w-36" />
              <Button size="sm" onClick={() => { if (newSlot.trim()) setForm({ ...form, slots: [...form.slots, newSlot.trim()] }); setNewSlot(''); }}>
                <Plus className="h-4 w-4" /> Add
              </Button>
            </div>
          </div>
          <fieldset>
            <legend className="mb-1.5 text-sm font-medium">Days (none = every day)</legend>
            <div className="flex flex-wrap gap-1">
              {DAYS.map((d, i) => (
                <button key={d} type="button" aria-pressed={form.weekdays.includes(i)} onClick={() => setForm({ ...form, weekdays: form.weekdays.includes(i) ? form.weekdays.filter((x) => x !== i) : [...form.weekdays, i] })} className={cx('rounded-md px-2.5 py-1 text-xs', form.weekdays.includes(i) ? 'bg-[var(--primary)] text-[var(--primary-fg)]' : 'surface-2')}>
                  {d}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Write ahead (h)" htmlFor="wf-ahead" help="0 = start at once">
              <Input id="wf-ahead" type="number" min={0} max={336} value={form.writeAheadHours} onChange={(e) => setForm({ ...form, writeAheadHours: Number(e.target.value) })} />
            </Field>
            <Field label="Backlog cap" htmlFor="wf-backlog">
              <Input id="wf-backlog" type="number" min={1} max={50} value={form.maxBacklog} onChange={(e) => setForm({ ...form, maxBacklog: Number(e.target.value) })} />
            </Field>
            <Field label="Retries" htmlFor="wf-retries">
              <Input id="wf-retries" type="number" min={0} max={10} value={form.maxRetries} onChange={(e) => setForm({ ...form, maxRetries: Number(e.target.value) })} />
            </Field>
          </div>
          {view.nextSlots.length ? (
            <p className="text-muted text-xs">
              Next slots: {view.nextSlots.slice(0, 4).map((s) => formatInZone(s, tz)).join(' · ')} (Pakistan) — {formatInZone(view.nextSlots[0], view.website.timezone)} on the website’s clock ({view.website.timezone}).
            </p>
          ) : null}
        </DialogSection>
        <DialogSection icon={<ImageIcon className="h-3.5 w-3.5" />} title="Images">
          <Field label="Images" htmlFor="wf-images">
            <Select id="wf-images" value={form.imagesOverride} onChange={(e) => setForm({ ...form, imagesOverride: e.target.value })}>
              <option value="inherit">Website setting</option>
              <option value="on">On</option>
              <option value="off">Off</option>
            </Select>
          </Field>
        </DialogSection>
        <DialogSection icon={<ScanSearch className="h-3.5 w-3.5" />} title="Indexing">
          <Switch
            label="Request indexing after publishing"
            help="As you do it by hand: about 35 seconds after a verified publish, Automation Chrome opens the URL in Search Console (URL Inspection) and clicks “Request indexing”. Sign in to Google once in Automation Chrome with the account that owns the property; Search Console allows only a few requests a day, the rest wait for the next day. With Search Console connected (Search Performance page), Google's URL Inspection is then asked for proof (1 h, 6 h, 24 h, then daily for 14 days). “Indexed” appears only when Google says the URL is on Google."
            checked={form.requestIndexing}
            onChange={(e) => setForm({ ...form, requestIndexing: e.target.checked })}
          />
          {form.requestIndexing ? (
            <Field label="Search Console property" htmlFor="wf-gsc" help="“https://example.com/” (URL prefix) or “sc-domain:example.com” (domain). Empty = the website URL.">
              <Input id="wf-gsc" placeholder={view.website.publicUrl} value={form.searchConsoleProperty} onChange={(e) => setForm({ ...form, searchConsoleProperty: e.target.value })} />
            </Field>
          ) : null}
        </DialogSection>
      </Modal>

      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add keywords"
        description="One per line, “keyword | secondary | title”, CSV or spreadsheet columns. Keywords already in this workflow are left out unless you keep them."
        footer={
          <>
            <Button onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button onClick={() => void runPreview()} disabled={!text.trim()}>
              <Eye className="h-4 w-4" /> Preview
            </Button>
            {preview ? (
              <Button variant="primary" onClick={() => void addAll()}>
                <Plus className="h-4 w-4" /> Add {preview.filter((r) => !r.errors.length && (!r.duplicateOf || keep.has(r.line))).length} keyword(s)
              </Button>
            ) : null}
          </>
        }
      >
        <Textarea aria-label="Workflow keywords" rows={8} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} />
        {preview ? (
          <div className="table-box">
            <div className="border-app flex flex-wrap items-center gap-3 border-b px-3 py-2 text-sm">
              <span className="font-medium">
                {preview.length} keyword{preview.length === 1 ? '' : 's'}
              </span>
              <span className="text-muted text-xs">
                {preview.filter((r) => (writers[r.line] ?? r.writerType) === 'UNKNOWN').length ? `${preview.filter((r) => (writers[r.line] ?? r.writerType) === 'UNKNOWN').length} without a writer` : 'every keyword has a writer'}
              </span>
              <label className="ml-auto flex items-center gap-2 text-xs">
                <span className="text-muted">Writer for all</span>
                <Select
                  aria-label="Writer for all keywords"
                  className="h-8 w-40! py-0 text-xs"
                  value=""
                  onChange={(e) => {
                    const w = e.target.value;
                    if (w) setWriters(Object.fromEntries(preview.map((r) => [r.line, w])));
                  }}
                >
                  <option value="">Set all to…</option>
                  <option value="CELEBRITY">Celebrity</option>
                  <option value="TIGRAM">Tigram</option>
                  <option value="UNKNOWN">Choose later</option>
                </Select>
              </label>
            </div>
            <ul className="max-h-[45vh] divide-y divide-[var(--border)] overflow-y-auto text-sm">
              {preview.map((r) => {
                const writer = writers[r.line] ?? r.writerType;
                return (
                  <li key={r.line} className={cx('flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2', r.errors.length > 0 && 'opacity-70')}>
                    <span className="text-muted w-6 text-right text-xs tabular-nums">{r.line}</span>
                    <span className="min-w-0 flex-1 font-medium">{r.keyword || <em className="text-muted">empty</em>}</span>
                    {r.errors.length ? (
                      <span className="text-xs text-rose-600">{r.errors.join(' ')}</span>
                    ) : (
                      <Select
                        aria-label={`Writer for ${r.keyword}`}
                        title={writers[r.line] ? 'Chosen by you' : `Detected: ${r.detectionReason}`}
                        className={cx('h-8 w-40! py-0 text-xs', writer === 'UNKNOWN' && 'border-amber-500/60')}
                        value={writer}
                        onChange={(e) => setWriters((w) => ({ ...w, [r.line]: e.target.value }))}
                      >
                        <option value="CELEBRITY">Celebrity{r.writerType === 'CELEBRITY' ? ' (detected)' : ''}</option>
                        <option value="TIGRAM">Tigram{r.writerType === 'TIGRAM' ? ' (detected)' : ''}</option>
                        <option value="UNKNOWN">Choose later</option>
                      </Select>
                    )}
                    {r.duplicateOf ? (
                      <label className="flex w-full items-center gap-1 pl-9 text-xs text-amber-700">
                        <input type="checkbox" checked={keep.has(r.line)} onChange={(e) => setKeep((k) => { const n = new Set(k); e.target.checked ? n.add(r.line) : n.delete(r.line); return n; })} /> duplicate of {r.duplicateOf} — keep anyway
                      </label>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </Modal>

      <ScreenshotModal shot={shot} onClose={() => setShot(null)} />
      {siteId ? (
        <MoveKeywords
          open={moveOpen}
          onClose={() => setMoveOpen(false)}
          siteId={siteId}
          keywordIds={[...selected]}
          timezone={view.workflow?.slotTimezone ?? 'Asia/Karachi'}
          onMoved={() => {
            setSelected(new Set());
            void load();
            setActed((n) => n + 1);
          }}
        />
      ) : null}
      {siteId ? <KeywordIdeas open={ideasOpen} onClose={() => setIdeasOpen(false)} siteId={siteId} seeds={[...view.keywords].reverse().map((k) => k.keyword)} onAdded={() => void load()} /> : null}
      <ConfirmDialog
        open={confirmForce}
        title={`Force continue ${selectedRows.filter((k) => k.status === 'FAILED').length} keyword(s)?`}
        confirmLabel="Force continue"
        busy={busy}
        onCancel={() => setConfirmForce(false)}
        onConfirm={() => {
          setConfirmForce(false);
          void action('force');
        }}
      >
        <div className="space-y-2">
          <p>You accept the problems found below. A saved draft is published at the next free slot like any other (only on a website with publishing switched on); an article held for review continues as with “Approve despite review reasons”. This is recorded.</p>
          <ul className="max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-xs">
            {selectedRows
              .filter((k) => k.status === 'FAILED')
              .map((k) => (
                <li key={k.id}>
                  <span className="font-medium">{k.keyword}</span>: {k.lastError ?? 'stopped'}
                </li>
              ))}
          </ul>
          {selectedRows.some((k) => k.status !== 'FAILED') ? <p className="text-muted text-xs">Keywords that are not stopped are left as they are.</p> : null}
        </div>
      </ConfirmDialog>
      <ConfirmDialog open={confirmDelete} title={`Delete ${selected.size} keyword(s)?`} confirmLabel="Delete" tone="danger" busy={busy} onCancel={() => setConfirmDelete(false)} onConfirm={() => void removeKeywords()}>
        <div className="space-y-2">
          <p>The keywords are removed from this workflow. Drafts and posts in WordPress stay as they are.</p>
          {selectedRows.some((k) => k.task) ? (
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={deleteArticles} onChange={(e) => setDeleteArticles(e.target.checked)} />
              <span>Also delete their articles from the app (a report of each is saved in data\backups\deleted-articles first)</span>
            </label>
          ) : null}
        </div>
      </ConfirmDialog>
    </div>
  );
}
