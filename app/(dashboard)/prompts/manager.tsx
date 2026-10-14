'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { History, RotateCcw, Save } from 'lucide-react';
import { api, ApiClientError } from '@/lib/client/api';
import { renderTemplate, TemplateSyntaxError, referencedVariables } from '@/lib/prompts/template';
import { Button, ConfirmDialog, CopyButton, useToast } from '@/components/client';
import { Field, Input, Select, Textarea } from '@/components/form';
import { Alert, Card, Chip, EmptyState, cx, formatDateTime } from '@/components/ui';

interface ListItem {
  id: string;
  moduleKey: string;
  stageKey: string;
  name: string;
  description: string;
  version: number;
  customized: boolean;
  kind: string;
}
interface VariableDoc {
  name: string;
  description: string;
  required: boolean;
  source: string;
}
interface PromptDetail {
  id: string;
  moduleKey: string;
  stageKey: string;
  name: string;
  description: string;
  content: string;
  version: number;
  kind: string;
  isDefault: boolean;
  defaultContent: string | null;
  defaultVersion: number | null;
  variablesList: VariableDoc[];
  versions: { id: string; version: number; note: string | null; createdAt: string; content: string }[];
  submissions: { id: string; taskId: string; createdAt: string; status: string; renderedPrompt: string; task: { keyword: string } }[];
}

const GROUPS: { key: string; label: string }[] = [
  { key: 'celebrity-writer', label: 'Celebrity Article Writer' },
  { key: 'tigram-writer', label: 'Tigram Article Writer' },
  { key: 'shared', label: 'Shared stages' },
];

const SAMPLE = {
  keyword: 'Tom Kaulitz Heidi Klum',
  secondary_keywords: ['Tokio Hotel', 'wedding'],
  example_title: 'Tom & Heidi: Their Story',
  language: 'English',
  country: 'United States',
  selected_title: 'Tom Kaulitz and Heidi Klum: Inside Their Relationship',
  max_words: 1300,
  faq_count: 5,
  bio_rows_range: '11–13',
  min_keyword_occurrences: 15,
  max_keyword_occurrences: 18,
  word_range: '1500–2200 words',
  link_count: 7,
  wikipedia_site: 'English Wikipedia (en.wikipedia.org)',
  categories: 'Celebrities\nMusic\nTV',
  final_article: '(the current article text)',
  rankmath_issues: '- Focus keyword not in the first paragraph',
  image_brief: 'A flat illustration of a laptop with a checklist',
  photo_count: 3,
  problems: '- Repeated opener “Additionally”',
  paragraphs: '[P1]\nFirst paragraph…',
};

export function PromptManager({ initialId }: { initialId?: string }) {
  const toast = useToast();
  const [list, setList] = useState<ListItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialId ?? null);
  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const [content, setContent] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<null | { version?: number }>(null);
  const [sample, setSample] = useState<Record<string, string>>({ keyword: SAMPLE.keyword, example_title: SAMPLE.example_title, secondary_keywords: SAMPLE.secondary_keywords.join(', '), language: 'English' });
  const [error, setError] = useState<string | null>(null);

  const loadList = useCallback(async () => {
    try {
      const res = await api<{ prompts: ListItem[] }>('/api/prompts');
      setList(res.prompts);
      if (!selected && res.prompts[0]) setSelected(res.prompts[0].id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [selected]);
  const loadDetail = useCallback(async (id: string) => {
    const res = await api<{ prompt: PromptDetail }>(`/api/prompts/${id}`);
    setDetail(res.prompt);
    setContent(res.prompt.content);
    setNote('');
  }, []);
  useEffect(() => {
    void loadList();
  }, [loadList]);
  useEffect(() => {
    if (selected) void loadDetail(selected).catch((e) => setError((e as Error).message));
  }, [selected, loadDetail]);

  const dirty = detail ? content !== detail.content : false;
  const analysis = useMemo(() => {
    const vars = { ...SAMPLE, ...sample, secondary_keywords: sample.secondary_keywords.split(',').map((s) => s.trim()).filter(Boolean) } as Record<string, string | number | string[]>;
    try {
      const r = renderTemplate(content, vars);
      const refs = referencedVariables(content);
      const known = new Set(detail?.variablesList.map((v) => v.name) ?? []);
      const unknown = refs.filter((v) => !known.has(v));
      const lang = detail?.kind === 'text' ? `\n\n${sample.language === 'German' ? 'Schreibe vollständig auf Deutsch für Leserinnen und Leser in Deutschland.' : 'Write in English for readers in the United States.'}` : '';
      return { text: r.text + lang, error: null as string | null, unknown, missing: r.missing };
    } catch (e) {
      return { text: '', error: e instanceof TemplateSyntaxError ? e.message : String(e), unknown: [], missing: [] };
    }
  }, [content, sample, detail]);

  async function save() {
    if (!detail) return;
    setSaving(true);
    try {
      const res = await api<{ version: number; warnings: string[]; unchanged: boolean }>(`/api/prompts/${detail.id}`, { method: 'PUT', body: { content, note: note || undefined } });
      toast('success', res.unchanged ? 'No changes.' : `Saved as version ${res.version}. New tasks use it; running tasks keep the prompt they already sent.`);
      for (const w of res.warnings) toast('info', w);
      await loadDetail(detail.id);
      await loadList();
    } catch (e) {
      toast('error', e instanceof ApiClientError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }
  async function restore() {
    if (!detail || !confirmRestore) return;
    try {
      const res = await api<{ version: number }>(`/api/prompts/${detail.id}/restore`, { body: confirmRestore });
      toast('success', `Restored as version ${res.version}.`);
      setConfirmRestore(null);
      await loadDetail(detail.id);
      await loadList();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  if (error) return <Alert tone="danger" title="Could not load prompts">{error}</Alert>;
  if (!list) return <div className="surface-2 h-96 animate-pulse rounded-xl" />;
  if (list.length === 0) return <Card><EmptyState title="No prompts seeded" description="Run npm run setup (or npm run db:seed) to insert the default prompts." /></Card>;

  return (
    <div className="grid gap-6 xl:grid-cols-[280px_1fr]">
      <nav aria-label="Prompts" className="surface h-fit rounded-xl border p-2">
        {GROUPS.map((g) => (
          <div key={g.key} className="mb-2">
            <div className="text-muted px-2 py-1 text-[11px] font-semibold uppercase">{g.label}</div>
            {list
              .filter((p) => p.moduleKey === g.key)
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => {
                    if (dirty && !window.confirm('Discard unsaved changes?')) return;
                    setSelected(p.id);
                  }}
                  className={cx('flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-sm', selected === p.id ? 'bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200' : 'hover:bg-[var(--surface-2)]')}
                >
                  <span className="truncate">{p.stageKey}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    {p.customized ? <Chip tone="brand">custom</Chip> : <Chip>default</Chip>}
                    <span className="text-muted text-[11px]">v{p.version}</span>
                  </span>
                </button>
              ))}
          </div>
        ))}
      </nav>

      {detail ? (
        <div className="space-y-6">
          <Card
            title={
              <span className="flex flex-wrap items-center gap-2">
                {detail.name} <code className="text-xs">{detail.moduleKey}/{detail.stageKey}</code> <Chip>v{detail.version}</Chip>
                {detail.isDefault ? <Chip>shipped default v{detail.defaultVersion}</Chip> : <Chip tone="brand">customized</Chip>}
                {dirty ? <Chip tone="warning">unsaved</Chip> : null}
                {detail.kind !== 'text' ? <Chip tone="info">{detail.kind} prompt — no language line</Chip> : null}
              </span>
            }
            description={detail.description}
            actions={
              <>
                {!detail.isDefault && detail.defaultContent ? (
                  <Button size="sm" onClick={() => setConfirmRestore({})}>
                    <RotateCcw className="h-3.5 w-3.5" /> Restore default
                  </Button>
                ) : null}
                <Button size="sm" variant="primary" onClick={() => void save()} loading={saving} disabled={!dirty || Boolean(analysis.error)}>
                  <Save className="h-3.5 w-3.5" /> Save version
                </Button>
              </>
            }
          >
            <Textarea className="min-h-[360px] font-mono text-xs" value={content} onChange={(e) => setContent(e.target.value)} aria-label="Prompt template" spellCheck={false} />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Input className="max-w-md" placeholder="Version note (optional)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Version note" />
              {analysis.error ? <Chip tone="danger">{analysis.error}</Chip> : <Chip tone="success">syntax OK</Chip>}
              {analysis.unknown.map((u) => (
                <Chip key={u} tone="warning" title="Undocumented variables are treated as required and block sending if empty">
                  unknown {`{{${u}}}`}
                </Chip>
              ))}
            </div>
            <p className="text-muted mt-2 text-xs">
              Syntax: <code>{'{{var}}'}</code>, <code>{'{{#if var}}…{{/if}}'}</code>, <code>{'{{#unless var}}…{{/unless}}'}</code>. Saving never changes prompts already sent. App updates never overwrite your customized prompt.
            </p>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Variables">
              <table className="table-app">
                <thead>
                  <tr>
                    <th>Variable</th>
                    <th>Source</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.variablesList.map((v) => (
                    <tr key={v.name}>
                      <td>
                        <button type="button" className="font-mono text-xs text-indigo-600 hover:underline" onClick={() => setContent((c) => `${c}{{${v.name}}}`)} title="Append to the prompt">
                          {`{{${v.name}}}`}
                        </button>
                        {v.required ? <Chip tone="warning" className="ml-1">required</Chip> : null}
                      </td>
                      <td className="text-xs">{v.source}</td>
                      <td className="text-xs">{v.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Live preview (sample inputs)" actions={<CopyButton text={analysis.text} />}>
              <div className="mb-3 grid gap-2 sm:grid-cols-2">
                <Field label="keyword" htmlFor="s-kw">
                  <Input id="s-kw" value={sample.keyword} onChange={(e) => setSample({ ...sample, keyword: e.target.value })} />
                </Field>
                <Field label="example_title" htmlFor="s-ex">
                  <Input id="s-ex" value={sample.example_title} onChange={(e) => setSample({ ...sample, example_title: e.target.value })} />
                </Field>
                <Field label="secondary_keywords" htmlFor="s-sec">
                  <Input id="s-sec" value={sample.secondary_keywords} onChange={(e) => setSample({ ...sample, secondary_keywords: e.target.value })} />
                </Field>
                <Field label="language" htmlFor="s-lang">
                  <Select id="s-lang" value={sample.language} onChange={(e) => setSample({ ...sample, language: e.target.value })}>
                    <option>English</option>
                    <option>German</option>
                  </Select>
                </Field>
              </div>
              <pre className="surface-2 max-h-96 overflow-auto rounded-lg p-3 text-xs whitespace-pre-wrap">{analysis.text || analysis.error}</pre>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title={<span className="flex items-center gap-2"><History className="h-4 w-4" /> Version history</span>} padded={false}>
              <table className="table-app">
                <tbody>
                  {detail.versions.map((v) => (
                    <tr key={v.id}>
                      <td className="tabular-nums">v{v.version}</td>
                      <td className="text-xs">{v.note}</td>
                      <td className="text-muted text-xs whitespace-nowrap">{formatDateTime(v.createdAt)}</td>
                      <td className="text-right">
                        {v.version !== detail.version ? (
                          <Button size="sm" variant="ghost" onClick={() => setConfirmRestore({ version: v.version })}>
                            Restore as new version
                          </Button>
                        ) : (
                          <Chip>current</Chip>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Exactly submitted prompts (latest 20)" padded={false}>
              {detail.submissions.length === 0 ? (
                <EmptyState title="Not used yet" />
              ) : (
                <ul className="divide-y divide-[var(--border)]">
                  {detail.submissions.map((s) => (
                    <li key={s.id} className="px-4 py-2 text-sm">
                      <div className="flex justify-between gap-2">
                        <Link className="font-medium hover:underline" href={`/articles/${s.taskId}?tab=prompts`}>
                          {s.task.keyword}
                        </Link>
                        <span className="text-muted text-xs">{formatDateTime(s.createdAt)}</span>
                      </div>
                      <details>
                        <summary className="text-muted cursor-pointer text-xs">show prompt ({s.status.toLowerCase()})</summary>
                        <pre className="surface-2 mt-1 max-h-48 overflow-auto rounded p-2 text-[11px] whitespace-pre-wrap">{s.renderedPrompt}</pre>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      ) : (
        <div className="surface-2 h-96 animate-pulse rounded-xl" />
      )}
      <ConfirmDialog open={Boolean(confirmRestore)} title={confirmRestore?.version ? `Restore version ${confirmRestore.version}?` : 'Restore the shipped default?'} confirmLabel="Restore" onCancel={() => setConfirmRestore(null)} onConfirm={() => void restore()}>
        The current text is kept in the history; the restored text becomes a new version.
      </ConfirmDialog>
    </div>
  );
}
