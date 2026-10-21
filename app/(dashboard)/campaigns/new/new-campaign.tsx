'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Eye, Save, Upload } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, useToast } from '@/components/client';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/form';
import { Alert, Card, Chip, cx } from '@/components/ui';
import { RowStatusChip, WRITER_LABEL } from '../shared';

interface Site {
  id: string;
  name: string;
  active: boolean;
  language: string;
  categories: { id: string; name: string }[];
}
interface Issue {
  kind: string;
  message: string;
  ref?: string;
}
interface PreviewRow {
  line: number;
  raw: string;
  keyword: string;
  secondaryKeywords: string[];
  exampleTitle: string | null;
  websiteId: string | null;
  websiteName: string | null;
  categoryId: string | null;
  categoryName: string | null;
  language: string | null;
  writer: string | null;
  writerSource: string | null;
  routerConfidence: number | null;
  routerRationale: string | null;
  status: string;
  issues: Issue[];
  confirmedVariant: boolean;
}
interface Preview {
  format: string;
  problems: string[];
  rows: PreviewRow[];
  summary: Record<string, number>;
}
interface Template {
  name: string;
  websiteId: string;
  defaultWriter: 'AUTO' | 'celebrity-writer' | 'tigram-writer';
  options: Record<string, unknown>;
}
type Override = { include?: boolean; writer?: string | null; categoryId?: string | null; confirmVariant?: boolean };
type Tri = '' | 'on' | 'off';

const PAGE = 100;
const FILTERS = [
  ['all', 'All'],
  ['READY', 'Ready'],
  ['NEEDS_WRITER', 'Choose writer'],
  ['NEEDS_CATEGORY', 'Choose category'],
  ['DUPLICATE', 'Duplicates'],
  ['INVALID', 'Invalid'],
  ['SKIPPED', 'Excluded'],
] as const;

export function NewCampaign() {
  const router = useRouter();
  const toast = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [sites, setSites] = useState<Site[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [name, setName] = useState('');
  const [websiteId, setWebsiteId] = useState('');
  const [defaultWriter, setDefaultWriter] = useState<Template['defaultWriter']>('AUTO');
  const [images, setImages] = useState<'site' | 'on' | 'off'>('site');
  const [titleApproval, setTitleApproval] = useState<Tri>('');
  const [articleApproval, setArticleApproval] = useState<Tri>('');
  const [saveToWordPress, setSaveToWordPress] = useState(true);
  const [text, setText] = useState('');
  const [overrides, setOverrides] = useState<Record<string, Override>>({});
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('all');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  useEffect(() => {
    void api<{ websites: Site[] }>('/api/websites').then((r) => {
      setSites(r.websites);
      setWebsiteId((w) => w || r.websites.find((s) => s.active)?.id || '');
    });
    void api<{ templates: Template[] }>('/api/campaigns/templates').then((r) => setTemplates(r.templates));
  }, []);

  const options = useMemo(() => {
    const tri = (t: Tri) => (t === '' ? undefined : t === 'on');
    return { images, manualTitleApproval: tri(titleApproval), manualArticleApproval: tri(articleApproval), saveToWordPress };
  }, [images, titleApproval, articleApproval, saveToWordPress]);

  const runPreview = useCallback(
    async (nextOverrides = overrides) => {
      if (!text.trim() || !websiteId) return;
      setPreviewing(true);
      try {
        setPreview(await api<Preview>('/api/campaigns/preview', { body: { text, websiteId, defaultWriter, options, overrides: nextOverrides } }));
      } catch (e) {
        toast('error', (e as Error).message);
      } finally {
        setPreviewing(false);
      }
    },
    [text, websiteId, defaultWriter, options, overrides, toast],
  );

  // Re-preview after a correction (the server decides; the input text never changes).
  const override = (lines: number[], patch: Override) => {
    const next = { ...overrides };
    for (const l of lines) next[String(l)] = { ...next[String(l)], ...patch };
    setOverrides(next);
    void runPreview(next);
  };

  // A changed input invalidates earlier corrections, which refer to line numbers.
  useEffect(() => {
    setPreview(null);
    setOverrides({});
    setSelected(new Set());
  }, [text]);

  async function create() {
    setCreating(true);
    try {
      const res = await api<{ campaign: { id: string }; summary: Record<string, number> }>('/api/campaigns', { body: { name, text, websiteId, defaultWriter, options, overrides } });
      toast('success', `Campaign created: ${res.summary.ready} task(s) are being queued.`);
      router.push(`/campaigns/${res.campaign.id}`);
    } catch (e) {
      toast('error', (e as Error).message);
      setCreating(false);
    }
  }

  async function saveAsTemplate() {
    const tname = window.prompt('Template name');
    if (!tname?.trim()) return;
    try {
      await api('/api/campaigns/templates', { body: { name: tname.trim(), websiteId, defaultWriter, options } });
      setTemplates((await api<{ templates: Template[] }>('/api/campaigns/templates')).templates);
      toast('success', 'Template saved.');
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  function applyTemplate(t: Template) {
    setWebsiteId(t.websiteId);
    setDefaultWriter(t.defaultWriter);
    const o = t.options as { images?: 'site' | 'on' | 'off'; manualTitleApproval?: boolean; manualArticleApproval?: boolean; saveToWordPress?: boolean };
    setImages(o.images ?? 'site');
    setTitleApproval(o.manualTitleApproval === undefined ? '' : o.manualTitleApproval ? 'on' : 'off');
    setArticleApproval(o.manualArticleApproval === undefined ? '' : o.manualArticleApproval ? 'on' : 'off');
    setSaveToWordPress(o.saveToWordPress ?? true);
    setPreview(null);
  }

  const rows = useMemo(() => (preview?.rows ?? []).filter((r) => filter === 'all' || r.status === filter), [preview, filter]);
  const shown = rows.slice(page * PAGE, page * PAGE + PAGE);
  const s = preview?.summary;
  const siteById = new Map(sites.map((x) => [x.id, x]));
  const sel = [...selected];
  // Bulk category (owner request): the categories of the website the selected rows are on (one website at a time).
  const selSiteIds = [...new Set((preview?.rows ?? []).filter((r) => selected.has(r.line)).map((r) => r.websiteId).filter((x): x is string => Boolean(x)))];
  const selSite = selSiteIds.length === 1 ? siteById.get(selSiteIds[0]) : undefined;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Card title="Keywords" description="One per line · “keyword | secondary1, secondary2 | example title” · CSV with headers (keyword, secondary_keywords, title, website, category, kind, language, priority, notes) · or columns pasted from a spreadsheet. Up to 1,000 rows.">
          <Textarea aria-label="Keywords" rows={14} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={'Tom Kaulitz Heidi Klum | Tokio Hotel, wedding | Tom & Heidi: Their Story\nHow to Install WordPress\nbest free vpn apps'} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setText(await f.text());
                e.target.value = '';
              }}
            />
            <Button size="sm" onClick={() => fileRef.current?.click()}>
              <Upload className="h-4 w-4" /> Load a CSV/TXT file
            </Button>
            <Button size="sm" variant="primary" onClick={() => void runPreview()} loading={previewing} disabled={!text.trim() || !websiteId}>
              <Eye className="h-4 w-4" /> Preview
            </Button>
            <span className="text-muted text-xs">{text ? `${text.split('\n').filter((l) => l.trim()).length} non-empty line(s)` : ''}</span>
          </div>
        </Card>

        <Card title="Campaign">
          <div className="space-y-3">
            {templates.length ? (
              <Field label="Start from a template" htmlFor="c-tpl">
                <Select id="c-tpl" value="" onChange={(e) => { const t = templates.find((x) => x.name === e.target.value); if (t) applyTemplate(t); }}>
                  <option value="">Choose…</option>
                  {templates.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Name" htmlFor="c-name" help="Optional; a name with date and row count is used otherwise.">
              <Input id="c-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Website" htmlFor="c-site" help="For rows without a website column.">
              <Select id="c-site" value={websiteId} onChange={(e) => { setWebsiteId(e.target.value); setPreview(null); }}>
                {!sites.length ? <option value="">Add a website first</option> : null}
                {sites.map((x) => (
                  <option key={x.id} value={x.id} disabled={!x.active}>
                    {x.name}
                    {x.active ? '' : ' (inactive)'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Writer" htmlFor="c-writer" help="Automatic routing leaves unclear keywords for you to choose. A writer column or your correction always wins.">
              <Select id="c-writer" value={defaultWriter} onChange={(e) => { setDefaultWriter(e.target.value as Template['defaultWriter']); setPreview(null); }}>
                <option value="AUTO">Automatic (Smart Router)</option>
                <option value="celebrity-writer">Celebrity Article Writer for every row</option>
                <option value="tigram-writer">Tigram Article Writer for every row</option>
              </Select>
            </Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Images" htmlFor="c-img">
                <Select id="c-img" value={images} onChange={(e) => setImages(e.target.value as 'site' | 'on' | 'off')}>
                  <option value="site">Site</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </Select>
              </Field>
              <Field label="Title approval" htmlFor="c-ta">
                <Select id="c-ta" value={titleApproval} onChange={(e) => setTitleApproval(e.target.value as Tri)}>
                  <option value="">Site</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </Select>
              </Field>
              <Field label="Article approval" htmlFor="c-aa">
                <Select id="c-aa" value={articleApproval} onChange={(e) => setArticleApproval(e.target.value as Tri)}>
                  <option value="">Site</option>
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </Select>
              </Field>
            </div>
            <Checkbox label="Save each article to WordPress as a draft" help="Always a draft. A campaign never publishes." checked={saveToWordPress} onChange={(e) => setSaveToWordPress(e.target.checked)} />
            <Button size="sm" variant="ghost" onClick={() => void saveAsTemplate()} disabled={!websiteId}>
              <Save className="h-4 w-4" /> Save these settings as a template
            </Button>
          </div>
        </Card>
      </div>

      {preview ? (
        <Card
          title="Preview"
          description={`Format: ${preview.format}. Nothing is created until you press Create campaign. Your text is stored exactly as entered.`}
          actions={
            <Button variant="primary" onClick={() => void create()} loading={creating} disabled={!s?.ready}>
              <Check className="h-4 w-4" /> Create campaign · {s?.ready ?? 0} task(s)
            </Button>
          }
        >
          {preview.problems.length ? (
            <div className="mb-3">
              <Alert tone="warning">{preview.problems.join(' ')}</Alert>
            </div>
          ) : null}
          <div className="mb-3 flex flex-wrap gap-2 text-sm">
            <Chip>{s!.rows} rows</Chip>
            <Chip tone="success">{s!.ready} ready</Chip>
            <Chip tone="brand">{s!.celebrity} celebrity</Chip>
            <Chip tone="brand">{s!.tigram} tigram</Chip>
            {s!.needsWriter ? <Chip tone="warning">{s!.needsWriter} need a writer</Chip> : null}
            {s!.needsCategory ? <Chip tone="warning">{s!.needsCategory} need a category</Chip> : null}
            {s!.duplicates ? <Chip tone="warning">{s!.duplicates} possible duplicates</Chip> : null}
            {s!.invalid ? <Chip tone="danger">{s!.invalid} invalid</Chip> : null}
            {s!.skipped ? <Chip>{s!.skipped} excluded</Chip> : null}
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-1">
            {FILTERS.map(([id, label]) => (
              <button key={id} type="button" aria-pressed={filter === id} onClick={() => { setFilter(id); setPage(0); }} className={cx('rounded-md px-2 py-1 text-xs', filter === id ? 'bg-indigo-600 text-white' : 'surface-2')}>
                {label}
              </button>
            ))}
            {sel.length ? (
              <span className="ml-auto flex flex-wrap items-center gap-1 text-xs">
                <span className="text-muted">{sel.length} selected:</span>
                <Button size="sm" onClick={() => override(sel, { writer: 'celebrity-writer' })}>Celebrity</Button>
                <Button size="sm" onClick={() => override(sel, { writer: 'tigram-writer' })}>Tigram</Button>
                {selSite?.categories.length ? (
                  <span className="inline-block w-44"><Select aria-label="Category for the selected rows" className="px-2 py-1 text-xs" value="" onChange={(e) => { if (e.target.value) override(sel, { categoryId: e.target.value }); }}>
                    <option value="">Category…</option>
                    {selSite.categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </Select></span>
                ) : selSiteIds.length > 1 ? (
                  <span className="text-muted" title="The selected rows are on several websites; select rows of one website to set their category together.">Category: one website at a time</span>
                ) : null}
                <Button size="sm" onClick={() => override(sel, { confirmVariant: true })}>Keep as separate articles</Button>
                <Button size="sm" onClick={() => override(sel, { include: false })}>Exclude</Button>
                <Button size="sm" onClick={() => override(sel, { include: true })}>Include</Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
              </span>
            ) : null}
          </div>
          <div className="overflow-x-auto">
            <table className="table-app">
              <thead>
                <tr>
                  <th>
                    <input type="checkbox" aria-label="Select shown rows" checked={shown.length > 0 && shown.every((r) => selected.has(r.line))} onChange={(e) => setSelected((cur) => { const n = new Set(cur); for (const r of shown) e.target.checked ? n.add(r.line) : n.delete(r.line); return n; })} />
                  </th>
                  <th>Line</th>
                  <th>Keyword</th>
                  <th>Website</th>
                  <th>Writer</th>
                  <th>Category</th>
                  <th>Status</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const site = r.websiteId ? siteById.get(r.websiteId) : undefined;
                  return (
                    <tr key={r.line}>
                      <td>
                        <input type="checkbox" aria-label={`Select line ${r.line}`} checked={selected.has(r.line)} onChange={(e) => setSelected((cur) => { const n = new Set(cur); e.target.checked ? n.add(r.line) : n.delete(r.line); return n; })} />
                      </td>
                      <td className="text-muted text-xs">{r.line}</td>
                      <td className="max-w-80">
                        <div className="font-medium">{r.keyword || <span className="text-muted italic">empty</span>}</div>
                        {r.secondaryKeywords.length ? <div className="text-muted text-xs">+ {r.secondaryKeywords.join(', ')}</div> : null}
                        {r.exampleTitle ? <div className="text-muted text-xs">Title idea: {r.exampleTitle}</div> : null}
                      </td>
                      <td className="text-xs">{r.websiteName ?? '—'}</td>
                      <td>
                        {r.status === 'INVALID' ? (
                          '—'
                        ) : (
                          <Select aria-label={`Writer for line ${r.line}`} className="w-36 px-2 py-1 text-xs" value={r.writer ?? ''} onChange={(e) => override([r.line], { writer: e.target.value || null })}>
                            <option value="">Choose…</option>
                            <option value="celebrity-writer">Celebrity</option>
                            <option value="tigram-writer">Tigram</option>
                          </Select>
                        )}
                        {r.routerRationale ? (
                          <div className="text-muted mt-0.5 max-w-56 text-[11px]" title={r.routerRationale}>
                            {r.writerSource === 'RULE' ? `router ${Math.round((r.routerConfidence ?? 0) * 100)} %` : r.writerSource === 'OVERRIDE' ? 'your choice' : r.writerSource === 'CAMPAIGN' ? 'campaign writer' : `router: ${r.routerRationale.slice(0, 60)}`}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        {r.writer === 'celebrity-writer' && site ? (
                          <Select aria-label={`Category for line ${r.line}`} className="w-36 px-2 py-1 text-xs" value={r.categoryId ?? ''} onChange={(e) => override([r.line], { categoryId: e.target.value || null })}>
                            <option value="">Choose…</option>
                            {site.categories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </Select>
                        ) : (
                          <span className="text-muted text-xs">{r.writer === 'tigram-writer' ? 'chosen by the writer' : '—'}</span>
                        )}
                      </td>
                      <td>
                        <RowStatusChip status={r.status} />
                      </td>
                      <td className="max-w-72 text-xs">
                        {r.issues.map((i, k) => (
                          <div key={k} className={i.kind === 'ERROR' ? 'text-rose-600' : i.kind === 'INFO' ? 'text-muted' : 'text-amber-700 dark:text-amber-300'}>
                            {i.message}
                          </div>
                        ))}
                        {r.status === 'DUPLICATE' ? (
                          <button type="button" className="mt-1 text-indigo-600 underline" onClick={() => override([r.line], { confirmVariant: true })}>
                            Keep as a separate article
                          </button>
                        ) : null}
                        {r.status !== 'SKIPPED' && r.status !== 'INVALID' ? (
                          <button type="button" className="text-muted mt-1 block underline" onClick={() => override([r.line], { include: false })}>
                            Exclude
                          </button>
                        ) : r.status === 'SKIPPED' ? (
                          <button type="button" className="mt-1 block text-indigo-600 underline" onClick={() => override([r.line], { include: true })}>
                            Include again
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > PAGE ? (
            <div className="mt-3 flex items-center gap-2 text-sm">
              <Button size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span className="text-muted">
                {page * PAGE + 1}–{Math.min(rows.length, (page + 1) * PAGE)} of {rows.length}
              </span>
              <Button size="sm" disabled={(page + 1) * PAGE >= rows.length} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          ) : null}
          <p className="text-muted mt-3 text-xs">Writer labels: {Object.values(WRITER_LABEL).join(' / ')}. Rows that need a writer, a category or a duplicate decision are not created until you decide.</p>
        </Card>
      ) : null}
    </div>
  );
}
