'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUpToLine, Eye, Plus, RotateCcw, Save, X } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, useToast } from '@/components/client';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/form';
import { Alert, Card, Chip, StatusChip, cx, type ChipTone } from '@/components/ui';
import { formatInZone } from '@/lib/workflow/time';
import { inspectionProperty, inspectionUrl } from '@/lib/workflow/search-console';

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
const KW_LABEL: Record<string, string> = { WAITING: 'waiting', WRITING: 'writing', READY: 'draft ready', SCHEDULED: 'scheduled', PUBLISHED: 'published', INDEXING_REQUESTED: 'indexing requested', INDEXED: 'indexed (verified)', FAILED: 'failed', SKIPPED: 'skipped', DONE: 'draft kept (publish yourself)' };

export function WorkflowPage({ sites, initialSiteId }: { sites: Site[]; initialSiteId: string }) {
  const toast = useToast();
  const [siteId, setSiteId] = useState(initialSiteId);
  const [view, setView] = useState<View | null>(null);
  const [form, setForm] = useState({ active: false, writerPreference: 'AUTO', slots: ['9:00 AM'], weekdays: [] as number[], writeAheadHours: 24, maxBacklog: 10, imagesOverride: 'inherit', requestIndexing: false, searchConsoleProperty: '', maxRetries: 3 });
  const [newSlot, setNewSlot] = useState('');
  const [saving, setSaving] = useState(false);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    const v = await api<View>(`/api/websites/${siteId}/workflow`);
    setView(v);
    return v;
  }, [siteId]);

  useEffect(() => {
    void load().then((v) => {
      if (v.workflow) setForm({ active: v.workflow.active, writerPreference: v.workflow.writerPreference, slots: v.workflow.slots, weekdays: v.workflow.weekdays, writeAheadHours: v.workflow.writeAheadHours, maxBacklog: v.workflow.maxBacklog, imagesOverride: v.workflow.imagesOverride, requestIndexing: v.workflow.requestIndexing, searchConsoleProperty: v.workflow.searchConsoleProperty ?? '', maxRetries: v.workflow.maxRetries });
      else setForm((f) => ({ ...f, active: false }));
    });
    const t = setInterval(() => void load().catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function save() {
    setSaving(true);
    try {
      await api(`/api/websites/${siteId}/workflow`, { method: 'PUT', body: form });
      toast('success', form.active ? 'Workflow saved and switched on. The scheduler checks every minute.' : 'Workflow saved (switched off).');
      await load();
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
      if (r.problems.length) toast('info', r.problems.join(' '));
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function addAll() {
    try {
      const r = await api<{ added: number; skippedDuplicates: number; invalid: number }>(`/api/websites/${siteId}/workflow/keywords`, { body: { text, keepDuplicates: [...keep] } });
      toast('success', `${r.added} keyword(s) added${r.skippedDuplicates ? `, ${r.skippedDuplicates} duplicate(s) left out` : ''}${r.invalid ? `, ${r.invalid} invalid` : ''}.`);
      setText('');
      setPreview(null);
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function action(act: string, extra: Record<string, unknown> = {}) {
    try {
      const r = await api<{ changed: number; notes: string[] }>(`/api/websites/${siteId}/workflow/keywords/action`, { body: { keywordIds: [...selected], action: act, ...extra } });
      toast(r.notes.length ? 'info' : 'success', `${r.changed} keyword(s) updated.${r.notes.length ? ` ${r.notes.slice(0, 3).join(' ')}` : ''}`);
      setSelected(new Set());
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const k of view?.keywords ?? []) c[k.status] = (c[k.status] ?? 0) + 1;
    return c;
  }, [view]);

  if (!view) return <Card><p className="text-muted text-sm">Loading…</p></Card>;
  const tz = form.slots.length ? (view.workflow?.slotTimezone ?? 'Asia/Karachi') : 'Asia/Karachi';

  return (
    <div className="space-y-6">
      <Card padded={false}>
        <div className="flex flex-wrap items-center gap-3 p-3">
          <label htmlFor="wf-site" className="text-sm font-medium">
            Website
          </label>
          <Select id="wf-site" className="w-auto min-w-48" value={siteId} onChange={(e) => { setSiteId(e.target.value); setSelected(new Set()); setPreview(null); }}>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.active ? '' : ' (inactive)'}
              </option>
            ))}
          </Select>
          {view.website.canPublish ? <Chip tone="warning">publishing allowed (scheduler only)</Chip> : <Chip>drafts only</Chip>}
          <Link className="text-sm text-indigo-600 underline" href={`/websites/${view.website.id}`}>
            Publishing permission →
          </Link>
          <Link className="ml-auto text-sm text-indigo-600 underline" href="/calendar">
            Publishing calendar →
          </Link>
        </div>
      </Card>

      {!view.website.canPublish ? (
        <Alert tone="info" title="Drafts only">
          Articles are written into their slots and saved as verified drafts. Nothing is scheduled or published until you allow publishing for this website (with the typed acknowledgement) on its page.
        </Alert>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[420px_minmax(0,1fr)]">
        <Card title="Workflow settings" description="Slots are Pakistan time (Asia/Karachi) and stored as UTC. One article per slot per website.">
          <div className="space-y-3">
            <Checkbox label="Workflow on" help="The scheduler starts articles for upcoming slots and (if allowed) schedules ready drafts." checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
            <Field label="Writer" htmlFor="wf-writer">
              <Select id="wf-writer" value={form.writerPreference} onChange={(e) => setForm({ ...form, writerPreference: e.target.value })}>
                <option value="AUTO">Per keyword (Smart Router; unclear ones wait for you)</option>
                <option value="celebrity-writer">Celebrity Article Writer for every keyword</option>
                <option value="tigram-writer">Tigram Article Writer for every keyword</option>
              </Select>
            </Field>
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
                <Input aria-label="New slot" placeholder="3:30 PM" value={newSlot} onChange={(e) => setNewSlot(e.target.value)} className="w-32" />
                <Button size="sm" onClick={() => { if (newSlot.trim()) setForm({ ...form, slots: [...form.slots, newSlot.trim()] }); setNewSlot(''); }}>
                  <Plus className="h-4 w-4" /> Add
                </Button>
              </div>
            </div>
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">Days (none = every day)</legend>
              <div className="flex flex-wrap gap-1">
                {DAYS.map((d, i) => (
                  <button key={d} type="button" aria-pressed={form.weekdays.includes(i)} onClick={() => setForm({ ...form, weekdays: form.weekdays.includes(i) ? form.weekdays.filter((x) => x !== i) : [...form.weekdays, i] })} className={cx('rounded-md px-2 py-1 text-xs', form.weekdays.includes(i) ? 'bg-indigo-600 text-white' : 'surface-2')}>
                    {d}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="grid grid-cols-3 gap-2">
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
            <Field label="Images" htmlFor="wf-images">
              <Select id="wf-images" value={form.imagesOverride} onChange={(e) => setForm({ ...form, imagesOverride: e.target.value })}>
                <option value="inherit">Website setting</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </Select>
            </Field>
            <Checkbox
              label="Request indexing after publishing"
              help="With Search Console connected (Search Performance page): about 35 seconds after a verified publish, the site's sitemap is resubmitted to Google, then Google's URL Inspection is asked for proof (1 h, 6 h, 24 h, then daily for 14 days). “Indexed” appears only when Google says the URL is on Google. Without the connection, a Search Console link appears and you request indexing yourself."
              checked={form.requestIndexing}
              onChange={(e) => setForm({ ...form, requestIndexing: e.target.checked })}
            />
            {form.requestIndexing ? (
              <Field label="Search Console property" htmlFor="wf-gsc" help="“https://example.com/” (URL prefix) or “sc-domain:example.com” (domain). Empty = the website URL.">
                <Input id="wf-gsc" placeholder={view.website.publicUrl} value={form.searchConsoleProperty} onChange={(e) => setForm({ ...form, searchConsoleProperty: e.target.value })} />
              </Field>
            ) : null}
            <Button variant="primary" onClick={() => void save()} loading={saving}>
              <Save className="h-4 w-4" /> Save workflow
            </Button>
            {view.nextSlots.length ? (
              <div className="text-muted text-xs">
                Next slots: {view.nextSlots.slice(0, 4).map((s) => formatInZone(s, tz)).join(' · ')} (Pakistan) — {formatInZone(view.nextSlots[0], view.website.timezone)} on the website’s clock ({view.website.timezone}).
              </div>
            ) : null}
          </div>
        </Card>

        <div className="min-w-0 space-y-6">
          <Card title="Add keywords" description="One per line, “keyword | secondary | title”, CSV or spreadsheet columns. Keywords already in this workflow are left out unless you keep them.">
            <Textarea aria-label="Workflow keywords" rows={5} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} />
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => void runPreview()} disabled={!text.trim()}>
                <Eye className="h-4 w-4" /> Preview
              </Button>
              {preview ? (
                <Button size="sm" variant="primary" onClick={() => void addAll()}>
                  <Plus className="h-4 w-4" /> Add {preview.filter((r) => !r.errors.length && (!r.duplicateOf || keep.has(r.line))).length} keyword(s)
                </Button>
              ) : null}
            </div>
            {preview ? (
              <ul className="mt-3 space-y-1 text-sm">
                {preview.map((r) => (
                  <li key={r.line} className="flex flex-wrap items-center gap-2">
                    <span className="text-muted w-8 text-xs">{r.line}</span>
                    <span className="font-medium">{r.keyword}</span>
                    <Chip tone={r.writerType === 'UNKNOWN' ? 'warning' : 'brand'}>{r.writerType === 'UNKNOWN' ? 'choose writer later' : r.writerType.toLowerCase()}</Chip>
                    {r.errors.length ? <span className="text-xs text-rose-600">{r.errors.join(' ')}</span> : null}
                    {r.duplicateOf ? (
                      <label className="flex items-center gap-1 text-xs text-amber-700">
                        <input type="checkbox" checked={keep.has(r.line)} onChange={(e) => setKeep((k) => { const n = new Set(k); e.target.checked ? n.add(r.line) : n.delete(r.line); return n; })} /> duplicate of {r.duplicateOf} — keep anyway
                      </label>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>

          <Card
            title="Keyword queue"
            description={Object.entries(counts).map(([k, n]) => `${n} ${KW_LABEL[k] ?? k.toLowerCase()}`).join(' · ') || 'Empty'}
            actions={
              selected.size ? (
                <div className="flex flex-wrap gap-1">
                  <Button size="sm" onClick={() => void action('writer', { writer: 'celebrity-writer' })}>Celebrity</Button>
                  <Button size="sm" onClick={() => void action('writer', { writer: 'tigram-writer' })}>Tigram</Button>
                  <Button size="sm" onClick={() => void action('top')}><ArrowUpToLine className="h-3.5 w-3.5" /> To top</Button>
                  <Button size="sm" onClick={() => void action('retry')}><RotateCcw className="h-3.5 w-3.5" /> Retry</Button>
                  <Button size="sm" onClick={() => void action('skip')}>Skip</Button>
                  <Button size="sm" onClick={() => void action('restore')}>Restore</Button>
                  <Button size="sm" onClick={() => void action('indexing-requested')}>Indexing requested</Button>
                  <Button size="sm" onClick={() => void action('indexed')}>Verified indexed</Button>
                </div>
              ) : null
            }
          >
            {view.keywords.length === 0 ? <p className="text-muted text-sm">No keywords yet.</p> : null}
            <div className="overflow-x-auto">
              <table className="table-app">
                <tbody>
                  {view.keywords.map((k) => (
                    <tr key={k.id}>
                      <td>
                        <input type="checkbox" aria-label={`Select ${k.keyword}`} checked={selected.has(k.id)} onChange={(e) => setSelected((s) => { const n = new Set(s); e.target.checked ? n.add(k.id) : n.delete(k.id); return n; })} />
                      </td>
                      <td className="max-w-72">
                        <div className="font-medium">{k.keyword}</div>
                        <div className="text-muted text-xs" title={k.detectionReason ?? undefined}>
                          {k.writerType === 'UNKNOWN' ? 'writer: choose' : `writer: ${k.writerType.toLowerCase()}`}
                        </div>
                      </td>
                      <td>
                        <Chip tone={KW_TONE[k.status] ?? 'neutral'}>{KW_LABEL[k.status] ?? k.status}</Chip>
                      </td>
                      <td className="text-xs">{k.scheduledAt ? `${formatInZone(k.scheduledAt, tz)} PK` : '—'}</td>
                      <td className="text-xs">
                        {k.task ? (
                          <Link href={`/articles/${k.task.id}`}>
                            <StatusChip status={k.task.status} />
                          </Link>
                        ) : null}
                        {k.publishedUrl ? (
                          <a className="ml-1 text-indigo-600 underline" href={k.publishedUrl} target="_blank" rel="noreferrer">
                            live post
                          </a>
                        ) : null}
                        {k.publishedUrl && view.workflow?.requestIndexing && ['PUBLISHED', 'INDEXING_REQUESTED'].includes(k.status) ? (
                          <a className="ml-1 text-indigo-600 underline" href={inspectionUrl(inspectionProperty(view.workflow.searchConsoleProperty, view.website.publicUrl), k.publishedUrl)} target="_blank" rel="noreferrer">
                            inspect in Search Console
                          </a>
                        ) : null}
                      </td>
                      <td className={cx('max-w-72 text-xs', k.lastError ? 'text-amber-700 dark:text-amber-300' : k.status === 'INDEXED' ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted')}>{k.lastError ?? k.indexingStatus ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
