'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Ban, Check, Download, Play, RefreshCw } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, ConfirmDialog, CopyButton, RelativeTime, useToast } from '@/components/client';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/form';
import { Alert, Card, Chip, EmptyState, cx } from '@/components/ui';
import { HumanizerSummaryCard, ParagraphComparison, RunStatusChip, type HumanizerParagraph, type HumanizerSummary } from '@/components/humanizer-results';

interface Meta {
  prompt: { content: string; version: string };
  settings: { scope: 'all' | 'flagged'; batchWords: number; tolerancePct: number; defaultLanguage: 'en' | 'de' };
  articles: { id: string; keyword: string; selectedTitle: string | null; language: string; status: string; updatedAt: string; edited: boolean; website: { name: string } }[];
}
interface RunRow {
  id: string;
  taskId: string | null;
  source: string;
  title: string;
  language: string;
  scope: string;
  status: string;
  message: string | null;
  appliedAt: string | null;
  createdAt: string;
  customPrompt: boolean;
}
interface RunDetail extends RunRow {
  keyword: string;
  outputHtml: string | null;
  inputHtml: string;
  articleChanged: boolean;
  task: { id: string; keyword: string } | null;
  result: { paragraphs?: HumanizerParagraph[]; summary?: HumanizerSummary; observations?: string[]; batches?: number };
}

const FINISHED = ['COMPLETED', 'FAILED', 'CANCELLED'];

export function HumanizerPage({ initialTaskId, initialRunId }: { initialTaskId?: string; initialRunId?: string }) {
  const toast = useToast();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selected, setSelected] = useState<string | null>(initialRunId ?? null);
  const [run, setRun] = useState<RunDetail | null>(null);

  // New run form
  const [source, setSource] = useState<'ARTICLE' | 'PASTE'>('ARTICLE');
  const [taskId, setTaskId] = useState(initialTaskId ?? '');
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<'en' | 'de'>('en');
  const [keyword, setKeyword] = useState('');
  const [text, setText] = useState('');
  const [scope, setScope] = useState<'all' | 'flagged'>('all');
  const [editPrompt, setEditPrompt] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadMeta = useCallback(async (q = '') => {
    const m = await api<Meta>(`/api/humanizer/meta${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    setMeta(m);
    return m;
  }, []);
  const loadRuns = useCallback(async () => setRuns((await api<{ runs: RunRow[] }>('/api/humanizer/runs')).runs), []);

  useEffect(() => {
    void loadMeta().then((m) => {
      setScope(m.settings.scope);
      setLanguage(m.settings.defaultLanguage);
      setPrompt(m.prompt.content);
      if (!initialTaskId && m.articles[0]) setTaskId(m.articles[0].id);
      if (!m.articles.length) setSource('PASTE');
    });
    void loadRuns();
  }, [loadMeta, loadRuns, initialTaskId]);

  useEffect(() => {
    const t = setTimeout(() => void loadMeta(query), 300);
    return () => clearTimeout(t);
  }, [query, loadMeta]);

  // Selected run: poll until finished.
  useEffect(() => {
    if (!selected) return setRun(null);
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = (await api<{ run: RunDetail }>(`/api/humanizer/runs/${selected}`)).run;
        if (stop) return;
        setRun(r);
        if (!FINISHED.includes(r.status)) timer = setTimeout(() => void tick(), 3000);
        else void loadRuns();
      } catch (e) {
        if (!stop) toast('error', (e as Error).message);
      }
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [selected, loadRuns, toast]);

  async function start() {
    setStarting(true);
    try {
      const body = {
        source,
        taskId: source === 'ARTICLE' ? taskId : undefined,
        html: source === 'PASTE' ? text : undefined,
        title: source === 'PASTE' ? title : undefined,
        language: source === 'PASTE' ? language : undefined,
        keyword: source === 'PASTE' ? keyword : undefined,
        scope,
        promptOverride: editPrompt && meta && prompt !== meta.prompt.content ? prompt : null,
      };
      const res = await api<{ run: { id: string; message: string } }>('/api/humanizer/runs', { body });
      toast('success', `Run queued. ${res.run.message}`);
      setSelected(res.run.id);
      await loadRuns();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function act(kind: 'cancel' | 'apply') {
    if (!run) return;
    setBusy(true);
    try {
      const res = await api<{ message?: string }>(`/api/humanizer/runs/${run.id}/${kind}`, { method: 'POST' });
      toast('success', res.message ?? (kind === 'cancel' ? 'Run cancelled.' : 'Applied.'));
      setRun((await api<{ run: RunDetail }>(`/api/humanizer/runs/${run.id}`)).run);
      await loadRuns();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
      setConfirmApply(false);
    }
  }

  function exportFile(kind: 'html' | 'txt') {
    if (!run?.outputHtml) return;
    const content =
      kind === 'html'
        ? run.outputHtml
        : (run.result.paragraphs ?? [])
            .map((p) => (p.status === 'rewritten' && p.edited ? p.edited : p.original))
            .join('\n\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: kind === 'html' ? 'text/html' : 'text/plain' }));
    a.download = `${run.title.replace(/[^\w-]+/g, '-').slice(0, 60) || 'humanized'}.${kind}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const resultText = (run?.result.paragraphs ?? []).map((p) => (p.status === 'rewritten' && p.edited ? p.edited : p.original)).join('\n\n');

  return (
    <div className="grid gap-6 xl:grid-cols-[400px_minmax(0,1fr)]">
      <div className="space-y-6">
        <Card title="New run" description={`Paragraphs are edited in batches of about ${meta?.settings.batchWords ?? 1200} words with fact locks (numbers, dates, quotes, names, links, bold/italic, keyword count, language, uncertainty, length ±${meta?.settings.tolerancePct ?? 20} %).`}>
          <div className="space-y-4">
            <div className="surface-2 inline-flex rounded-lg p-0.5" role="tablist" aria-label="Source">
              {(['ARTICLE', 'PASTE'] as const).map((s) => (
                <button key={s} type="button" role="tab" aria-selected={source === s} onClick={() => setSource(s)} className={cx('rounded-md px-3 py-1.5 text-sm font-medium', source === s ? 'surface shadow-sm' : 'text-muted')}>
                  {s === 'ARTICLE' ? 'Saved article' : 'Paste text'}
                </button>
              ))}
            </div>
            {source === 'ARTICLE' ? (
              <>
                <Field label="Find an article" htmlFor="hz-q">
                  <Input id="hz-q" placeholder="Keyword…" value={query} onChange={(e) => setQuery(e.target.value)} />
                </Field>
                <Field label="Article" htmlFor="hz-task" help="Uses your edited version if you edited it, otherwise the assembled article.">
                  <Select id="hz-task" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                    {!meta?.articles.length ? <option value="">No articles with text yet</option> : null}
                    {meta?.articles.map((a) => (
                      <option key={a.id} value={a.id}>
                        {(a.selectedTitle ?? a.keyword).slice(0, 70)} · {a.website.name}
                        {a.edited ? ' · edited' : ''}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            ) : (
              <>
                <Field label="Title (for your history)" htmlFor="hz-title">
                  <Input id="hz-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Language" htmlFor="hz-lang">
                    <Select id="hz-lang" value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'de')}>
                      <option value="en">English</option>
                      <option value="de">German</option>
                    </Select>
                  </Field>
                  <Field label="Primary keyword" htmlFor="hz-kw" help="Optional; its count per paragraph is locked.">
                    <Input id="hz-kw" value={keyword} maxLength={200} onChange={(e) => setKeyword(e.target.value)} />
                  </Field>
                </div>
                <Field label="Text or HTML" htmlFor="hz-text" help="Separate paragraphs with a blank line, or paste HTML with <p> paragraphs. Links, bold and italic are preserved.">
                  <Textarea id="hz-text" rows={10} value={text} onChange={(e) => setText(e.target.value)} />
                </Field>
              </>
            )}
            <fieldset>
              <legend className="mb-1.5 text-sm font-medium">Paragraphs</legend>
              <div className="space-y-1 text-sm">
                <label className="flex items-center gap-2">
                  <input type="radio" name="hz-scope" checked={scope === 'all'} onChange={() => setScope('all')} /> All eligible paragraphs
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" name="hz-scope" checked={scope === 'flagged'} onChange={() => setScope('flagged')} /> Only paragraphs the local editor flagged
                </label>
              </div>
            </fieldset>
            <Checkbox label="Edit the rewriting prompt for this run" help="Your saved prompt is edited in Prompt Manager; this change applies to this run only." checked={editPrompt} onChange={(e) => setEditPrompt(e.target.checked)} />
            {editPrompt ? (
              <Field label={`Prompt (saved ${meta?.prompt.version ?? ''})`} htmlFor="hz-prompt" help="Must keep {{paragraphs}}; {{problems}} and {{keyword}} are filled in for you.">
                <Textarea id="hz-prompt" rows={10} className="font-mono text-xs" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
              </Field>
            ) : null}
            <Button variant="primary" onClick={() => void start()} loading={starting} disabled={source === 'ARTICLE' ? !taskId : !text.trim()}>
              <Play className="h-4 w-4" /> Run humanizer
            </Button>
            <p className="text-muted text-xs">Results are never sent to WordPress automatically. Apply a result to its article, then re-save the draft yourself.</p>
          </div>
        </Card>

        <Card title="History" actions={<Button size="sm" variant="ghost" aria-label="Refresh" onClick={() => void loadRuns()}><RefreshCw className="h-4 w-4" /></Button>}>
          {runs.length === 0 ? <p className="text-muted text-sm">No runs yet.</p> : null}
          <ul className="space-y-1">
            {runs.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setSelected(r.id)} className={cx('w-full rounded-lg border px-2.5 py-2 text-left text-sm', selected === r.id ? 'border-indigo-400 bg-indigo-50/50 dark:bg-indigo-950/40' : 'border-app hover:bg-[var(--surface-2)]')}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{r.title}</span>
                    <RunStatusChip status={r.status} />
                  </span>
                  <span className="text-muted mt-0.5 block text-xs">
                    {r.source === 'ARTICLE' ? 'article' : 'pasted'} · {r.scope === 'flagged' ? 'flagged only' : 'all paragraphs'}
                    {r.customPrompt ? ' · custom prompt' : ''}
                    {r.appliedAt ? ' · applied' : ''} · <RelativeTime value={r.createdAt} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="min-w-0 space-y-6">
        {!run ? (
          <Card>
            <EmptyState title="Choose or start a run" description="Original and edited paragraphs appear side by side, with the reason whenever a fact lock kept the original." />
          </Card>
        ) : (
          <>
            <Card
              title={run.title}
              description={run.message ?? undefined}
              actions={
                <div className="flex flex-wrap gap-2">
                  {!FINISHED.includes(run.status) ? (
                    <Button size="sm" onClick={() => void act('cancel')} loading={busy}>
                      <Ban className="h-4 w-4" /> Cancel
                    </Button>
                  ) : null}
                  {run.status === 'COMPLETED' ? (
                    <>
                      <CopyButton text={run.outputHtml ?? ''} label="Copy HTML" />
                      <CopyButton text={resultText} label="Copy text" />
                      <Button size="sm" onClick={() => exportFile('html')}>
                        <Download className="h-4 w-4" /> .html
                      </Button>
                      <Button size="sm" onClick={() => exportFile('txt')}>
                        <Download className="h-4 w-4" /> .txt
                      </Button>
                    </>
                  ) : null}
                  {run.status === 'COMPLETED' && run.source === 'ARTICLE' ? (
                    <Button size="sm" variant="primary" disabled={Boolean(run.appliedAt) || run.articleChanged} onClick={() => setConfirmApply(true)}>
                      <Check className="h-4 w-4" /> {run.appliedAt ? 'Applied' : 'Apply to article'}
                    </Button>
                  ) : null}
                </div>
              }
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <RunStatusChip status={run.status} />
                <Chip>{run.language === 'de' ? 'German' : 'English'}</Chip>
                <Chip>{run.scope === 'flagged' ? 'flagged only' : 'all paragraphs'}</Chip>
                {run.task ? (
                  <Link className="text-indigo-600 underline" href={`/articles/${run.task.id}`}>
                    Open article
                  </Link>
                ) : null}
              </div>
              {run.articleChanged && !run.appliedAt && run.status === 'COMPLETED' ? (
                <div className="mt-3">
                  <Alert tone="warning">The article changed after this run started, so it cannot be applied. Run the humanizer again on the current version.</Alert>
                </div>
              ) : null}
              {!FINISHED.includes(run.status) ? <p className="text-muted mt-3 text-sm">ChatGPT answers arrive through the extension; this page refreshes by itself.</p> : null}
            </Card>
            {run.result.summary ? <HumanizerSummaryCard summary={run.result.summary} observations={run.result.observations} /> : null}
            {run.result.paragraphs ? <ParagraphComparison paragraphs={run.result.paragraphs} /> : null}
          </>
        )}
      </div>

      <ConfirmDialog open={confirmApply} title="Apply to the article?" confirmLabel="Apply" busy={busy} onCancel={() => setConfirmApply(false)} onConfirm={() => void act('apply')}>
        The edited text becomes your edited version of the article; the previous version is kept in its history. The WordPress draft is not changed until you use “Save again” on the article’s WordPress tab.
      </ConfirmDialog>
    </div>
  );
}
