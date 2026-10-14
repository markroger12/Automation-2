'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Code2, Columns2, Eye, RefreshCcw, Save, Undo2 } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { SerializedTaskDetail } from '@/lib/tasks/detail';
import { ImagesTab } from './images-tab';
import { Button, CopyButton, useToast } from '@/components/client';
import { Field, Input, Textarea } from '@/components/form';
import { Alert, Card, Chip, EmptyState, KeyValue, cx, formatDateTime } from '@/components/ui';

export const EXTRA_TABS = ['titles', 'research', 'editor', 'seo', 'images'] as const;
export type ExtraTab = (typeof EXTRA_TABS)[number];

type Props = { tab: ExtraTab; task: SerializedTaskDetail; onChanged: () => Promise<void> };

export function ArticleExtraTabs({ tab, task, onChanged }: Props) {
  if (tab === 'titles') return <TitlesTab task={task} onChanged={onChanged} />;
  if (tab === 'research') return <ResearchTab task={task} />;
  if (tab === 'editor') return <EditorTab task={task} onChanged={onChanged} />;
  if (tab === 'seo') return <SeoTab task={task} onChanged={onChanged} />;
  return <ImagesTab task={task} onChanged={onChanged} />;
}

function TitlesTab({ task, onChanged }: { task: SerializedTaskDetail; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [title, setTitle] = useState(task.selectedTitle ?? task.recommendedTitle ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => setTitle(task.selectedTitle ?? task.recommendedTitle ?? ''), [task.selectedTitle, task.recommendedTitle]);
  if (task.titleOptionList.length === 0 && !task.selectedTitle) return <Card><EmptyState title="No titles yet" description="Titles appear after the TITLES stage (Celebrity Article Writer). Tigram titles come from the SEO TITLE line." /></Card>;
  const awaiting = task.status === 'AWAITING_TITLE_APPROVAL';
  async function approve() {
    setBusy(true);
    try {
      const res = await api<{ note: string | null }>(`/api/tasks/${task.id}/approve-title`, { body: { title } });
      toast('success', awaiting ? 'Title approved — writing continues.' : 'Title saved.');
      if (res.note) toast('info', res.note);
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card title="Title options" description={task.exampleTitle ? `Your example title (guidance only): “${task.exampleTitle}”` : undefined}>
        <div role="radiogroup" className="space-y-2">
          {task.titleOptionList.map((t, i) => (
            <label key={i} className={cx('flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm', title === t ? 'border-indigo-400 bg-indigo-50/50 dark:bg-indigo-950/40' : 'border-app')}>
              <input type="radio" name="title" checked={title === t} onChange={() => setTitle(t)} className="mt-1" />
              <span className="flex-1">{t}</span>
              {t === task.recommendedTitle ? <Chip tone="brand">recommended</Chip> : null}
            </label>
          ))}
        </div>
      </Card>
      <Card title={awaiting ? 'Approve the title' : 'Selected title'}>
        {awaiting ? (
          <div className="mb-3">
            <Alert tone="warning">The article waits for your title approval. You can edit the title before approving.</Alert>
          </div>
        ) : null}
        <Field label="Title" htmlFor="title-edit" help={`${title.length} characters`}>
          <Input id="title-edit" value={title} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void approve()} loading={busy} disabled={title.trim().length < 5}>
            <CheckCircle2 className="h-4 w-4" /> {awaiting ? 'Approve title' : 'Save title'}
          </Button>
          <CopyButton text={title} label="Copy title" size="md" />
        </div>
        <div className="mt-4">
          <KeyValue items={[{ label: 'Approved', value: formatDateTime(task.titleApprovedAt) }]} />
        </div>
      </Card>
    </div>
  );
}

function ResearchTab({ task }: { task: SerializedTaskDetail }) {
  const ev = task.stages.find((s) => s.key === 'RESEARCH_EVIDENCE');
  const analysis = ev?.outputJson ? (JSON.parse(ev.outputJson) as { sources: { url: string; context: string }[]; uncertain: string[]; estimates: string[]; warnings: string[] }) : null;
  if (!task.researchNotes) return <Card><EmptyState title="No research yet" /></Card>;
  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Research notes" className="xl:col-span-2" description="Stored separately from the article; never published." actions={<CopyButton text={task.researchNotes} />}>
        <pre className="surface-2 max-h-[70vh] overflow-auto rounded-lg p-3 text-xs whitespace-pre-wrap">{task.researchNotes}</pre>
      </Card>
      <Card title="Evidence summary" description="Cited sources are recorded, not yet verified. AI assertions are not evidence by themselves.">
        {analysis ? (
          <div className="space-y-4 text-sm">
            {analysis.warnings.map((w, i) => (
              <Alert key={i} tone="warning">
                {w}
              </Alert>
            ))}
            <div>
              <div className="text-muted mb-1 text-xs font-semibold uppercase">Sources ({analysis.sources.length})</div>
              <ul className="space-y-1 text-xs">
                {analysis.sources.map((s) => (
                  <li key={s.url} className="break-all">
                    <a className="text-indigo-600 underline" href={s.url} target="_blank" rel="noreferrer">
                      {s.url}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="text-muted mb-1 text-xs font-semibold uppercase">Uncertain / disputed ({analysis.uncertain.length})</div>
              <ul className="list-disc space-y-1 pl-4 text-xs">{analysis.uncertain.map((u, i) => <li key={i}>{u}</li>)}</ul>
            </div>
            <div>
              <div className="text-muted mb-1 text-xs font-semibold uppercase">Estimates ({analysis.estimates.length})</div>
              <ul className="list-disc space-y-1 pl-4 text-xs">{analysis.estimates.map((u, i) => <li key={i}>{u}</li>)}</ul>
            </div>
          </div>
        ) : (
          <p className="text-muted text-sm">Not analysed yet.</p>
        )}
      </Card>
    </div>
  );
}

function htmlToText(html: string): string {
  if (typeof document === 'undefined') return html;
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.innerText;
}

function paragraphs(html: string): string[] {
  if (typeof document === 'undefined') return [];
  const div = document.createElement('div');
  div.innerHTML = html;
  return Array.from(div.querySelectorAll('p,h2,h3,li,td')).map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

function EditorTab({ task, onChanged }: { task: SerializedTaskDetail; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const original = task.assembledHtml ?? task.bodyHtml ?? '';
  const server = task.editedHtml ?? original;
  const draftKey = `bas:editor:${task.id}`;
  const [mode, setMode] = useState<'visual' | 'html' | 'compare'>('visual');
  const [html, setHtml] = useState(server);
  const [baseVersion, setBaseVersion] = useState(task.version);
  const [saving, setSaving] = useState(false);
  const [restored, setRestored] = useState(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const [meta, setMeta] = useState({ seoTitle: task.seoTitle ?? '', metaDescription: task.metaDescription ?? '', slug: task.slug ?? '', focusKeyword: task.focusKeyword ?? task.keyword, tags: task.tagList.join(', ') });

  useEffect(() => {
    try {
      const draft = localStorage.getItem(draftKey);
      if (draft && draft !== server) {
        setHtml(draft);
        setRestored(true);
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (mode === 'visual' && editorRef.current && editorRef.current.innerHTML !== html) editorRef.current.innerHTML = html;
  }, [mode, html]);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        if (html !== server) localStorage.setItem(draftKey, html);
        else localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
    }, 800);
    return () => clearTimeout(t);
  }, [html, server, draftKey]);

  const dirty = html !== server;
  const diff = useMemo(() => {
    const a = paragraphs(original);
    const b = paragraphs(html);
    const setA = new Set(a);
    const setB = new Set(b);
    return { removed: a.filter((p) => !setB.has(p)), added: b.filter((p) => !setA.has(p)) };
  }, [original, html, mode]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!original) return <Card><EmptyState title="No article body yet" description="The editor opens once the article has been written and assembled." /></Card>;

  async function save() {
    setSaving(true);
    try {
      const res = await api<{ version: number; html: string }>(`/api/tasks/${task.id}/content`, { method: 'PUT', body: { html, baseVersion } });
      setBaseVersion(res.version);
      setHtml(res.html);
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* ignore */
      }
      setRestored(false);
      toast('success', 'Edits saved (sanitized). The generated original is kept for comparison.');
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function saveMeta() {
    try {
      const res = await api<{ version: number }>(`/api/tasks/${task.id}/metadata`, {
        method: 'PUT',
        body: { seoTitle: meta.seoTitle, metaDescription: meta.metaDescription, slug: meta.slug, focusKeyword: meta.focusKeyword, tags: meta.tags.split(',').map((t) => t.trim()).filter(Boolean), baseVersion },
      });
      setBaseVersion(res.version);
      toast('success', 'Metadata saved.');
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function approve() {
    try {
      if (dirty) await save();
      await api(`/api/tasks/${task.id}/approve-article`, { method: 'POST' });
      toast('success', 'Article approved — the WordPress draft step continues.');
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function discard() {
    try {
      const res = await api<{ version: number }>(`/api/tasks/${task.id}/discard-edits`, { method: 'POST' });
      setBaseVersion(res.version);
      setHtml(original);
      localStorage.removeItem(draftKey);
      toast('success', 'Reverted to the generated article (your edit is kept in history).');
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card
        className="xl:col-span-2"
        title={
          <span className="flex items-center gap-2">
            Article {task.editedHtml ? <Chip tone="brand">edited</Chip> : <Chip>generated</Chip>} {dirty ? <Chip tone="warning">unsaved changes</Chip> : null}
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-1">
            <Button size="sm" variant={mode === 'visual' ? 'primary' : 'ghost'} onClick={() => setMode('visual')}>
              <Eye className="h-3.5 w-3.5" /> Visual
            </Button>
            <Button size="sm" variant={mode === 'html' ? 'primary' : 'ghost'} onClick={() => setMode('html')}>
              <Code2 className="h-3.5 w-3.5" /> HTML
            </Button>
            <Button size="sm" variant={mode === 'compare' ? 'primary' : 'ghost'} onClick={() => setMode('compare')}>
              <Columns2 className="h-3.5 w-3.5" /> Compare
            </Button>
          </div>
        }
      >
        {restored ? (
          <div className="mb-3">
            <Alert tone="info">An unsaved draft from this browser was restored. Save it or discard it.</Alert>
          </div>
        ) : null}
        {task.status === 'AWAITING_ARTICLE_APPROVAL' ? (
          <div className="mb-3">
            <Alert tone="warning" title="Waiting for your approval" action={<Button size="sm" variant="primary" onClick={() => void approve()}>Approve article</Button>}>
              Review and edit below; approving continues with the WordPress draft.
            </Alert>
          </div>
        ) : null}
        {mode === 'visual' ? (
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            className="article-preview min-h-[400px] rounded-lg border p-4 focus:outline-none"
            onInput={(e) => setHtml((e.target as HTMLDivElement).innerHTML)}
            aria-label="Article editor"
          />
        ) : mode === 'html' ? (
          <Textarea className="min-h-[500px] font-mono text-xs" value={html} onChange={(e) => setHtml(e.target.value)} aria-label="Article HTML" />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="text-muted mb-2 text-xs font-semibold uppercase">Generated original</div>
              <div className="article-preview max-h-[600px] overflow-auto rounded-lg border p-3" dangerouslySetInnerHTML={{ __html: original }} />
            </div>
            <div>
              <div className="text-muted mb-2 text-xs font-semibold uppercase">Current edit</div>
              <div className="article-preview max-h-[600px] overflow-auto rounded-lg border p-3" dangerouslySetInnerHTML={{ __html: html }} />
            </div>
            <div className="md:col-span-2">
              <div className="text-muted mb-1 text-xs font-semibold uppercase">
                Changed blocks: {diff.removed.length} removed, {diff.added.length} added
              </div>
              <ul className="space-y-1 text-xs">
                {diff.removed.slice(0, 30).map((p, i) => (
                  <li key={`r${i}`} className="rounded bg-rose-50 px-2 py-1 text-rose-900 line-through dark:bg-rose-950 dark:text-rose-200">
                    {p}
                  </li>
                ))}
                {diff.added.slice(0, 30).map((p, i) => (
                  <li key={`a${i}`} className="rounded bg-emerald-50 px-2 py-1 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
                    {p}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty}>
            <Save className="h-4 w-4" /> Save edits
          </Button>
          {task.editedHtml ? (
            <Button onClick={() => void discard()}>
              <Undo2 className="h-4 w-4" /> Revert to generated
            </Button>
          ) : null}
          <CopyButton text={html} label="Copy HTML" size="md" />
          <CopyButton text={htmlToText(html)} label="Copy text" size="md" />
        </div>
      </Card>
      <Card title="Metadata" description="Sent to WordPress / Rank Math with the draft.">
        <div className="space-y-3">
          <Field label="SEO title" htmlFor="m-title" help={`${meta.seoTitle.length}/60`}>
            <Input id="m-title" value={meta.seoTitle} onChange={(e) => setMeta({ ...meta, seoTitle: e.target.value })} />
          </Field>
          <Field label="Meta description" htmlFor="m-meta" help={`${meta.metaDescription.length} characters`}>
            <Textarea id="m-meta" rows={3} value={meta.metaDescription} onChange={(e) => setMeta({ ...meta, metaDescription: e.target.value })} />
          </Field>
          <Field label="Slug" htmlFor="m-slug">
            <Input id="m-slug" value={meta.slug} onChange={(e) => setMeta({ ...meta, slug: e.target.value })} />
          </Field>
          <Field label="Focus keyword" htmlFor="m-fk">
            <Input id="m-fk" value={meta.focusKeyword} onChange={(e) => setMeta({ ...meta, focusKeyword: e.target.value })} />
          </Field>
          <Field label="Tags (comma-separated)" htmlFor="m-tags">
            <Input id="m-tags" value={meta.tags} onChange={(e) => setMeta({ ...meta, tags: e.target.value })} />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void saveMeta()}>
              <Save className="h-4 w-4" /> Save metadata
            </Button>
            <CopyButton text={`SEO title: ${meta.seoTitle}\nMeta description: ${meta.metaDescription}\nSlug: ${meta.slug}\nFocus keyword: ${meta.focusKeyword}\nTags: ${meta.tags}`} label="Copy all" size="md" />
          </div>
        </div>
      </Card>
    </div>
  );
}

interface CheckRow {
  id: string;
  label: string;
  passed: boolean;
  severity: string;
  weight: number;
  detail: string;
  fix?: string;
}

function SeoTab({ task, onChanged }: { task: SerializedTaskDetail; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const internal = task.seoReports.filter((r) => r.source === 'INTERNAL');
  const rankmath = task.seoReports.filter((r) => r.source === 'RANKMATH');
  const latest = internal[0];
  const checks = latest ? (JSON.parse(latest.checks) as CheckRow[]) : [];
  const metrics = latest ? (JSON.parse(latest.metrics) as Record<string, unknown>) : {};
  async function rerun() {
    setBusy(true);
    try {
      const res = await api<{ score: number }>(`/api/tasks/${task.id}/seo-rerun`, { method: 'POST' });
      toast('success', `SEO readiness: ${res.score}/100`);
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <div className="text-muted text-xs">Internal SEO readiness</div>
          <div className="text-3xl font-semibold tabular-nums">{latest?.score ?? '—'}</div>
          <div className="text-muted text-xs">Heuristic on-page checks — not a ranking promise, not fact-checking.</div>
        </Card>
        <Card>
          <div className="text-muted text-xs">Rank Math (live)</div>
          <div className="text-3xl font-semibold tabular-nums">{task.rankMathScore ?? <span className="text-muted text-base">not verified</span>}</div>
          <div className="text-muted text-xs">Read only from the WordPress panel after the draft is saved.</div>
        </Card>
        <Card>
          <Button onClick={() => void rerun()} loading={busy} disabled={!task.assembledHtml}>
            <RefreshCcw className="h-4 w-4" /> Rerun SEO analysis
          </Button>
          <p className="text-muted mt-2 text-xs">Uses your edited version when one exists.</p>
        </Card>
      </div>
      {latest ? (
        <Card title="Checks" description={`Evaluated ${formatDateTime(latest.createdAt)}. Each failed check shows the evidence and a fix suggestion.`} padded={false}>
          <table className="table-app">
            <thead>
              <tr>
                <th>Check</th>
                <th>Result</th>
                <th>Evidence</th>
                <th>Suggestion</th>
                <th>Weight</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c) => (
                <tr key={c.id}>
                  <td className="font-medium">{c.label}</td>
                  <td>{c.passed ? <Chip tone="success">pass</Chip> : <Chip tone={c.severity === 'error' ? 'danger' : 'warning'}>{c.severity === 'error' ? 'fail' : 'advice'}</Chip>}</td>
                  <td className="text-xs">{c.detail}</td>
                  <td className="text-muted text-xs">{c.passed ? '' : c.fix}</td>
                  <td className="text-muted text-xs tabular-nums">{c.weight}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <Card>
          <EmptyState title="No SEO report yet" />
        </Card>
      )}
      {latest ? (
        <Card title="Measured metrics">
          <pre className="surface-2 max-h-80 overflow-auto rounded p-3 text-xs">{JSON.stringify(metrics, null, 2)}</pre>
        </Card>
      ) : null}
      {rankmath.length ? (
        <Card title="Rank Math history">
          <ul className="text-sm">
            {rankmath.map((r) => (
              <li key={r.id}>
                {formatDateTime(r.createdAt)} — {r.score ?? 'not verified'}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
