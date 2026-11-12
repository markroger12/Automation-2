'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Ban, Download, ExternalLink, Play, RefreshCw } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, RelativeTime, useToast } from '@/components/client';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/form';
import { Alert, Card, Chip, EmptyState, cx, type ChipTone } from '@/components/ui';
import type { CoverageEntry, EvidenceItem, Highlight, PlagiarismOptions, PlagiarismResult, SourceReport } from '@/lib/plagiarism/types';

interface Meta {
  searchConfigured: boolean;
  limits: { userUrls: number; linkedPages: number; searchQueries: number; searchResults: number; minWords: number };
  defaultLanguage: 'en' | 'de';
  articles: { id: string; keyword: string; selectedTitle: string | null; language: string; status: string; updatedAt: string; website: { name: string } }[];
}
interface CheckRow {
  id: string;
  taskId: string | null;
  source: string;
  title: string;
  language: string;
  status: string;
  message: string | null;
  progress: string | null;
  createdAt: string;
  finishedAt: string | null;
}
interface CheckDetail extends CheckRow {
  keyword: string;
  inputWords: number;
  options: PlagiarismOptions;
  result: PlagiarismResult | null;
}

const FINISHED = ['COMPLETED', 'FAILED', 'CANCELLED'];
const STATUS: Record<string, { label: string; tone: ChipTone }> = {
  QUEUED: { label: 'queued', tone: 'neutral' },
  RUNNING: { label: 'checking', tone: 'info' },
  COMPLETED: { label: 'finished', tone: 'success' },
  FAILED: { label: 'failed', tone: 'danger' },
  CANCELLED: { label: 'cancelled', tone: 'neutral' },
};
const KIND_LABEL: Record<SourceReport['kind'], string> = { OWNER_ARTICLE: 'your article', LINKED_PAGE: 'linked page', USER_URL: 'your URL', WIKIPEDIA: 'Wikipedia', SEARCH_RESULT: 'search result' };
const COVERAGE_TONE: Record<CoverageEntry['status'], ChipTone> = { CHECKED: 'success', FAILED: 'danger', SKIPPED: 'neutral', NOT_CONFIGURED: 'warning' };
const COVERAGE_LABEL: Record<CoverageEntry['status'], string> = { CHECKED: 'compared', FAILED: 'could not read', SKIPPED: 'skipped', NOT_CONFIGURED: 'not configured' };

function StatusChip({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status.toLowerCase(), tone: 'neutral' as ChipTone };
  return <Chip tone={s.tone}>{s.label}</Chip>;
}

function Marked({ h }: { h: Highlight }) {
  return (
    <p className="text-sm leading-relaxed">
      <span className="text-muted">{h.before}</span>
      <mark className="rounded bg-amber-200/70 px-0.5 text-inherit dark:bg-amber-700/50">{h.match}</mark>
      <span className="text-muted">{h.after}</span>
    </p>
  );
}

function SourceLink({ s }: { s: SourceReport }) {
  if (s.taskId)
    return (
      <Link className="link" href={`/articles/${s.taskId}`}>
        {s.title}
      </Link>
    );
  if (s.url)
    return (
      <a className="inline-flex items-center gap-1 break-all link" href={s.url} target="_blank" rel="noreferrer noopener">
        {s.title} <ExternalLink className="h-3 w-3 shrink-0" />
      </a>
    );
  return <span>{s.title}</span>;
}

function EvidenceCard({ e, s }: { e: EvidenceItem; s: SourceReport }) {
  return (
    <li className="border-app rounded-lg border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        {e.kind === 'exact' ? <Chip tone="warning">identical run · {e.words} words</Chip> : <Chip tone="info">similar sentence · {e.shared} of {e.contentWords} content words, {Math.round((e.ordered ?? 0) * 100)} % in the same order</Chip>}
        <span className="text-muted">{KIND_LABEL[s.kind]}:</span>
        <SourceLink s={s} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <div className="text-muted mb-1 text-xs font-medium uppercase">Your text</div>
          <Marked h={e.article} />
        </div>
        <div>
          <div className="text-muted mb-1 text-xs font-medium uppercase">Source</div>
          <Marked h={e.match} />
        </div>
      </div>
    </li>
  );
}

export function PlagiarismPage({ initialTaskId, initialCheckId }: { initialTaskId?: string; initialCheckId?: string }) {
  const toast = useToast();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [checks, setChecks] = useState<CheckRow[]>([]);
  const [selected, setSelected] = useState<string | null>(initialCheckId ?? null);
  const [check, setCheck] = useState<CheckDetail | null>(null);
  const [sourceFilter, setSourceFilter] = useState<number | 'all'>('all');

  const [source, setSource] = useState<'ARTICLE' | 'PASTE'>('ARTICLE');
  const [taskId, setTaskId] = useState(initialTaskId ?? '');
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [language, setLanguage] = useState<'en' | 'de'>('en');
  const [keyword, setKeyword] = useState('');
  const [text, setText] = useState('');
  const [urls, setUrls] = useState('');
  const [opts, setOpts] = useState({ ownerArticles: true, linkedPages: true, wikipedia: true, search: false });
  const [starting, setStarting] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadMeta = useCallback(async (q = '') => {
    const m = await api<Meta>(`/api/plagiarism/meta${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    setMeta(m);
    return m;
  }, []);
  const loadChecks = useCallback(async () => setChecks((await api<{ checks: CheckRow[] }>('/api/plagiarism/checks')).checks), []);

  useEffect(() => {
    void loadMeta().then((m) => {
      setLanguage(m.defaultLanguage);
      setOpts((o) => ({ ...o, search: m.searchConfigured }));
      if (!initialTaskId && m.articles[0]) setTaskId(m.articles[0].id);
      if (!m.articles.length) setSource('PASTE');
    });
    void loadChecks();
  }, [loadMeta, loadChecks, initialTaskId]);

  useEffect(() => {
    const t = setTimeout(() => void loadMeta(query), 300);
    return () => clearTimeout(t);
  }, [query, loadMeta]);

  useEffect(() => {
    setSourceFilter('all');
    if (!selected) return setCheck(null);
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const c = (await api<{ check: CheckDetail }>(`/api/plagiarism/checks/${selected}`)).check;
        if (stop) return;
        setCheck(c);
        if (!FINISHED.includes(c.status)) timer = setTimeout(() => void tick(), 2000);
        else void loadChecks();
      } catch (e) {
        if (!stop) toast('error', (e as Error).message);
      }
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [selected, loadChecks, toast]);

  const urlList = useMemo(() => urls.split(/\s+/).map((u) => u.trim()).filter(Boolean), [urls]);

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
        urls: urlList,
        ...opts,
        search: opts.search && Boolean(meta?.searchConfigured),
      };
      const res = await api<{ check: { id: string } }>('/api/plagiarism/checks', { body });
      toast('success', 'Check queued.');
      setSelected(res.check.id);
      await loadChecks();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function cancel() {
    if (!check) return;
    setBusy(true);
    try {
      await api(`/api/plagiarism/checks/${check.id}/cancel`, { method: 'POST' });
      setCheck((await api<{ check: CheckDetail }>(`/api/plagiarism/checks/${check.id}`)).check);
      await loadChecks();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function exportJson() {
    if (!check?.result) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ title: check.title, ...check.result }, null, 2)], { type: 'application/json' }));
    a.download = `plagiarism-evidence-${check.title.replace(/[^\w-]+/g, '-').slice(0, 50) || check.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const r = check?.result ?? null;
  const evidence = r ? r.evidence.filter((e) => sourceFilter === 'all' || e.source === sourceFilter) : [];
  const tooMany = urlList.length > (meta?.limits.userUrls ?? 10);

  return (
    <div className="grid gap-6 xl:grid-cols-[400px_minmax(0,1fr)]">
      <div className="space-y-6">
        <Card title="New check" description="Finds identical runs of 8+ words and closely matching sentences, and shows them next to their source. It never decides whether something is plagiarism.">
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
                <Field label="Find an article" htmlFor="pl-q">
                  <Input id="pl-q" placeholder="Keyword…" value={query} onChange={(e) => setQuery(e.target.value)} />
                </Field>
                <Field label="Article" htmlFor="pl-task" help="Uses your edited version if there is one.">
                  <Select id="pl-task" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                    {!meta?.articles.length ? <option value="">No articles with text yet</option> : null}
                    {meta?.articles.map((a) => (
                      <option key={a.id} value={a.id}>
                        {(a.selectedTitle ?? a.keyword).slice(0, 70)} · {a.website.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </>
            ) : (
              <>
                <Field label="Title (for your history)" htmlFor="pl-title">
                  <Input id="pl-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Language" htmlFor="pl-lang">
                    <Select id="pl-lang" value={language} onChange={(e) => setLanguage(e.target.value as 'en' | 'de')}>
                      <option value="en">English</option>
                      <option value="de">German</option>
                    </Select>
                  </Field>
                  <Field label="Topic" htmlFor="pl-kw" help="For the Wikipedia lookup.">
                    <Input id="pl-kw" value={keyword} maxLength={200} onChange={(e) => setKeyword(e.target.value)} />
                  </Field>
                </div>
                <Field label="Text or HTML" htmlFor="pl-text" help={`At least ${meta?.limits.minWords ?? 50} words. Separate paragraphs with a blank line, or paste HTML.`}>
                  <Textarea id="pl-text" rows={10} value={text} onChange={(e) => setText(e.target.value)} />
                </Field>
              </>
            )}
            <fieldset className="space-y-2">
              <legend className="mb-1 text-sm font-medium">Compare with</legend>
              <Checkbox label="My saved articles" help="All websites; recurring site text is exempt." checked={opts.ownerArticles} onChange={(e) => setOpts({ ...opts, ownerArticles: e.target.checked })} />
              <Checkbox label={`Pages linked from the text (up to ${meta?.limits.linkedPages ?? 10})`} checked={opts.linkedPages} onChange={(e) => setOpts({ ...opts, linkedPages: e.target.checked })} />
              <Checkbox label="Wikipedia extracts for the topic" checked={opts.wikipedia} onChange={(e) => setOpts({ ...opts, wikipedia: e.target.checked })} />
              <Checkbox
                label="Search the web for distinctive passages"
                help={meta?.searchConfigured ? `Licensed search API (Serper): up to ${meta.limits.searchQueries} passages, ${meta.limits.searchResults} result pages read.` : 'Needs a SERPER_API_KEY in .env (licensed search API). Search engine pages are never scraped.'}
                checked={opts.search && Boolean(meta?.searchConfigured)}
                disabled={!meta?.searchConfigured}
                onChange={(e) => setOpts({ ...opts, search: e.target.checked })}
              />
            </fieldset>
            <Field label={`Extra URLs (up to ${meta?.limits.userUrls ?? 10})`} htmlFor="pl-urls" help="One per line. Public pages only." error={tooMany ? `At most ${meta?.limits.userUrls ?? 10} URLs.` : undefined}>
              <Textarea id="pl-urls" rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="https://…" />
            </Field>
            <Button variant="primary" onClick={() => void start()} loading={starting} disabled={tooMany || (source === 'ARTICLE' ? !taskId : !text.trim())}>
              <Play className="h-4 w-4" /> Check
            </Button>
          </div>
        </Card>

        <Card title="History" actions={<Button size="sm" variant="ghost" aria-label="Refresh" onClick={() => void loadChecks()}><RefreshCw className="h-4 w-4" /></Button>}>
          {checks.length === 0 ? <p className="text-muted text-sm">No checks yet.</p> : null}
          <ul className="space-y-1">
            {checks.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => setSelected(c.id)} className={cx('w-full rounded-lg border px-2.5 py-2 text-left text-sm', selected === c.id ? 'border-indigo-400 bg-indigo-50/50 dark:bg-indigo-950/40' : 'border-app hover:bg-[var(--surface-2)]')}>
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{c.title}</span>
                    <StatusChip status={c.status} />
                  </span>
                  <span className="text-muted mt-0.5 block text-xs">
                    {c.source === 'ARTICLE' ? 'article' : 'pasted'} · <RelativeTime value={c.createdAt} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="min-w-0 space-y-6">
        {!check ? (
          <Card>
            <EmptyState title="Choose or start a check" description="Matching passages appear next to their source, with the list of everything that was (and was not) compared." />
          </Card>
        ) : (
          <>
            <Card
              title={check.title}
              description={check.message ?? undefined}
              actions={
                <div className="flex flex-wrap gap-2">
                  {!FINISHED.includes(check.status) ? (
                    <Button size="sm" onClick={() => void cancel()} loading={busy}>
                      <Ban className="h-4 w-4" /> Cancel
                    </Button>
                  ) : null}
                  {r ? (
                    <Button size="sm" onClick={exportJson}>
                      <Download className="h-4 w-4" /> Evidence .json
                    </Button>
                  ) : null}
                </div>
              }
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <StatusChip status={check.status} />
                <Chip>{check.language === 'de' ? 'German' : 'English'}</Chip>
                <Chip>{check.inputWords} words</Chip>
                {check.taskId ? (
                  <Link className="link" href={`/articles/${check.taskId}`}>
                    Open article
                  </Link>
                ) : null}
              </div>
              {check.progress && !FINISHED.includes(check.status) ? <p className="text-muted mt-3 text-sm">{check.progress}</p> : null}
            </Card>

            {r ? (
              <>
                <Card title="What was found">
                  <dl className="grid gap-3 text-sm sm:grid-cols-4">
                    <div>
                      <dt className="text-muted text-xs">Words in identical runs (8+ words)</dt>
                      <dd className="text-lg font-semibold">
                        {r.wordsInExactRuns} <span className="text-muted text-sm font-normal">of {r.articleWords}</span>
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted text-xs">Closely matching sentences</dt>
                      <dd className="text-lg font-semibold">{r.nearSentences}</dd>
                    </div>
                    <div>
                      <dt className="text-muted text-xs">Sources with findings</dt>
                      <dd className="text-lg font-semibold">{r.sources.filter((s) => s.exactRuns || s.nearMatches).length}</dd>
                    </div>
                    <div>
                      <dt className="text-muted text-xs">Documents compared</dt>
                      <dd className="text-lg font-semibold">{r.documentsCompared}</dd>
                    </div>
                  </dl>
                  <div className="mt-3">
                    <Alert tone="info">These are counts of matching wording, not a plagiarism score. Read each passage and its source before deciding anything.</Alert>
                  </div>
                </Card>

                <Card
                  title="Evidence"
                  description="Your text on the left, the source on the right. Identical runs are verified word for word in the source."
                  actions={
                    r.sources.length > 1 ? (
                      <Select aria-label="Filter by source" value={String(sourceFilter)} onChange={(e) => setSourceFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}>
                        <option value="all">All sources</option>
                        {r.sources.map((s, i) => (s.exactRuns || s.nearMatches ? (
                          <option key={i} value={i}>
                            {s.title.slice(0, 60)}
                          </option>
                        ) : null))}
                      </Select>
                    ) : undefined
                  }
                >
                  {evidence.length ? (
                    <ul className="space-y-3">
                      {evidence.map((e, i) => (
                        <EvidenceCard key={i} e={e} s={r.sources[e.source]} />
                      ))}
                    </ul>
                  ) : (
                    <p className="text-muted text-sm">No identical runs of 8+ words and no closely matching sentences in the sources compared.</p>
                  )}
                </Card>

                <Card title="Coverage" description="Everything that was compared, and what could not be.">
                  <ul className="divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
                    {r.coverage.map((c, i) => (
                      <li key={i} className="flex flex-wrap items-start gap-2 py-2">
                        <Chip tone={COVERAGE_TONE[c.status]}>{COVERAGE_LABEL[c.status]}</Chip>
                        <span className="min-w-0 flex-1">
                          {c.url ? (
                            <a className="break-all link" href={c.url} target="_blank" rel="noreferrer noopener">
                              {c.label}
                            </a>
                          ) : (
                            <span className="font-medium">{c.label}</span>
                          )}
                          <span className="text-muted block text-xs">{c.detail}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                </Card>

                {r.exemptMatches.length || r.exempt.boilerplateBlocks.length ? (
                  <Card title="Not counted" description="Matches inside quotations, and text that recurs across your own website.">
                    <ul className="space-y-2 text-sm">
                      {r.exemptMatches.map((x, i) => (
                        <li key={`m${i}`}>
                          <Chip>{x.reason === 'quotation' ? 'quotation' : 'site boilerplate'}</Chip> <span className="text-muted">“{x.text.slice(0, 220)}”</span> — {r.sources[x.source]?.title}
                        </li>
                      ))}
                      {r.exempt.boilerplateBlocks.map((b, i) => (
                        <li key={`b${i}`}>
                          <Chip>recurring site text</Chip> <span className="text-muted">“{b.text.slice(0, 220)}”</span> — in {b.articles} other articles of this website
                        </li>
                      ))}
                    </ul>
                  </Card>
                ) : null}

                <Card title="Limitations">
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {r.limitations.map((l, i) => (
                      <li key={i}>{l}</li>
                    ))}
                  </ul>
                </Card>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
