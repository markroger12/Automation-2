'use client';

import { useState } from 'react';
import { Card, Chip, cx, type ChipTone } from './ui';

/** Shapes produced by src/lib/humanizer/plan.ts (serialized). */
export interface HumanizerParagraph {
  id: string;
  status: 'rewritten' | 'kept' | 'unchanged' | 'skipped';
  original: string;
  edited: string | null;
  reasons: string[];
  flags: string[];
}

export interface HumanizerDiagnostics {
  paragraphs: number;
  words: number;
  flaggedParagraphs: number;
  fillerPhrases: number;
  bannedOpeners: number;
  inflatedWords: number;
  dashes: number;
  repeatedOpeners: { word: string; count: number }[];
  sentenceLength: { mean: number; sd: number; sentences: number };
}

export interface HumanizerSummary {
  rewritten: number;
  kept: number;
  unchanged: number;
  skipped: number;
  before: HumanizerDiagnostics;
  after: HumanizerDiagnostics;
}

const TONE: Record<HumanizerParagraph['status'], ChipTone> = { rewritten: 'success', kept: 'warning', unchanged: 'neutral', skipped: 'neutral' };
const LABEL: Record<HumanizerParagraph['status'], string> = { rewritten: 'edited', kept: 'kept original', unchanged: 'unchanged', skipped: 'not sent' };

export function HumanizerSummaryCard({ summary, observations }: { summary: HumanizerSummary; observations?: string[] }) {
  const rows: [string, (d: HumanizerDiagnostics) => string | number][] = [
    ['Paragraphs flagged by the local editor', (d) => d.flaggedParagraphs],
    ['Empty phrases', (d) => d.fillerPhrases],
    ['Banned sentence openers', (d) => d.bannedOpeners],
    ['Inflated words', (d) => d.inflatedWords],
    ['Dashes', (d) => d.dashes],
    ['Repeated sentence openers', (d) => (d.repeatedOpeners.length ? d.repeatedOpeners.map((r) => `${r.word} ×${r.count}`).join(', ') : '—')],
    ['Sentence length (mean ± sd, words)', (d) => `${d.sentenceLength.mean} ± ${d.sentenceLength.sd}`],
    ['Words', (d) => d.words],
  ];
  return (
    <Card title="Editorial diagnostics" description="What a copy editor would mark, before and after. This is not an AI-detection score.">
      <div className="mb-3 flex flex-wrap gap-2 text-sm">
        <Chip tone="success">{summary.rewritten} edited</Chip>
        <Chip tone="warning">{summary.kept} kept by fact locks</Chip>
        <Chip>{summary.unchanged} unchanged</Chip>
        <Chip>{summary.skipped} not sent</Chip>
      </div>
      <table className="table-app">
        <thead>
          <tr>
            <th>Measure</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, f]) => (
            <tr key={label}>
              <td>{label}</td>
              <td>{f(summary.before)}</td>
              <td>{f(summary.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {observations?.length ? (
        <ul className="text-muted mt-3 list-disc pl-5 text-sm">
          {observations.map((o, i) => (
            <li key={i}>{o}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

export function ParagraphComparison({ paragraphs }: { paragraphs: HumanizerParagraph[] }) {
  const [filter, setFilter] = useState<'all' | HumanizerParagraph['status']>('all');
  const shown = filter === 'all' ? paragraphs : paragraphs.filter((p) => p.status === filter);
  return (
    <Card
      title="Paragraphs side by side"
      actions={
        <div className="flex flex-wrap gap-1" role="group" aria-label="Filter paragraphs">
          {(['all', 'rewritten', 'kept', 'unchanged', 'skipped'] as const).map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={cx('rounded-md px-2 py-1 text-xs', filter === f ? 'bg-[var(--primary)] text-[var(--primary-fg)]' : 'surface-2')}>
              {f === 'all' ? `All (${paragraphs.length})` : `${LABEL[f]} (${paragraphs.filter((p) => p.status === f).length})`}
            </button>
          ))}
        </div>
      }
    >
      {shown.length === 0 ? <p className="text-muted text-sm">No paragraphs in this group.</p> : null}
      <ol className="space-y-3">
        {shown.map((p) => (
          <li key={p.id} className="border-app rounded-lg border p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              <code className="font-semibold">{p.id}</code>
              <Chip tone={TONE[p.status]}>{LABEL[p.status]}</Chip>
              {p.flags.map((f, i) => (
                <Chip key={i} tone="info">
                  {f}
                </Chip>
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <p className="text-muted mb-1 text-[11px] font-semibold uppercase">Original</p>
                <p className="text-sm whitespace-pre-wrap">{p.original}</p>
              </div>
              <div>
                <p className="text-muted mb-1 text-[11px] font-semibold uppercase">{p.status === 'kept' && p.edited ? 'Rejected rewrite' : 'Result'}</p>
                <p className={cx('text-sm whitespace-pre-wrap', p.status === 'kept' && 'text-muted line-through decoration-rose-400/60')}>{p.edited ?? (p.status === 'rewritten' ? '' : p.original)}</p>
              </div>
            </div>
            {p.reasons.length ? (
              <ul className="mt-2 list-disc pl-5 text-xs text-amber-800 dark:text-amber-300">
                {p.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
      </ol>
    </Card>
  );
}

const RUN_STATUS: Record<string, { label: string; tone: ChipTone }> = {
  QUEUED: { label: 'queued', tone: 'neutral' },
  WAITING: { label: 'waiting for ChatGPT', tone: 'info' },
  COMPLETED: { label: 'finished', tone: 'success' },
  FAILED: { label: 'failed', tone: 'danger' },
  CANCELLED: { label: 'cancelled', tone: 'neutral' },
};

/** Status of a Humanizer page run (not an article status). */
export function RunStatusChip({ status }: { status: string }) {
  const s = RUN_STATUS[status] ?? { label: status.toLowerCase(), tone: 'neutral' as ChipTone };
  return <Chip tone={s.tone}>{s.label}</Chip>;
}
