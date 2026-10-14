'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { SerializedTaskDetail } from '@/lib/tasks/detail';
import { RelativeTime } from '@/components/client';
import { Card, Chip, EmptyState, StatusChip, buttonClasses } from '@/components/ui';
import { HumanizerSummaryCard, ParagraphComparison, RunStatusChip, type HumanizerParagraph, type HumanizerSummary } from '@/components/humanizer-results';

interface StageData {
  scope: string;
  batches: number;
  observations: string[];
  paragraphs: HumanizerParagraph[];
  summary: HumanizerSummary;
}
interface RunRow {
  id: string;
  title: string;
  status: string;
  scope: string;
  appliedAt: string | null;
  createdAt: string;
  customPrompt: boolean;
}

/** HUMANIZE stage results (side by side with reasons) and this article's Humanizer page runs. */
export function HumanizerTab({ task }: { task: SerializedTaskDetail }) {
  const stage = task.stages.find((s) => s.key === 'HUMANIZE');
  const data = stage?.outputJson ? (JSON.parse(stage.outputJson) as StageData) : null;
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  useEffect(() => {
    void api<{ runs: RunRow[] }>(`/api/humanizer/runs?taskId=${task.id}`).then((r) => setRuns(r.runs)).catch(() => setRuns([]));
  }, [task.id]);
  return (
    <div className="space-y-4">
      <Card
        title="Editorial humanizer"
        description={stage?.message ?? 'Runs after images and before assembly; rewrites that break a fact lock keep the original paragraph.'}
        actions={
          !task.legacy && (task.assembledHtml || task.editedHtml) ? (
            <Link href={`/humanizer?task=${task.id}`} className={buttonClasses('secondary', 'sm')}>
              <Sparkles className="h-4 w-4" /> Open in Humanizer
            </Link>
          ) : null
        }
      >
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {stage ? <StatusChip status={stage.status} /> : <span className="text-muted">The humanizer runs after the article text and images.</span>}
          {data ? <Chip>{data.scope === 'flagged' ? 'flagged paragraphs only' : 'all paragraphs'}</Chip> : null}
          {data ? <Chip>{data.batches} batch(es)</Chip> : null}
        </div>
      </Card>
      {data ? (
        <>
          <HumanizerSummaryCard summary={data.summary} observations={data.observations} />
          <ParagraphComparison paragraphs={data.paragraphs} />
        </>
      ) : stage?.status === 'SKIPPED' ? (
        <Card>
          <EmptyState title="Humanizer switched off" description="Turn it on in Settings → Content (or for this website) and regenerate the Humanizer stage." />
        </Card>
      ) : null}
      <Card title="Humanizer page runs for this article">
        {runs === null ? <p className="text-muted text-sm">Loading…</p> : runs.length === 0 ? <p className="text-muted text-sm">None yet.</p> : null}
        <ul className="space-y-2 text-sm">
          {(runs ?? []).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-2">
              <Link className="truncate text-indigo-600 underline" href={`/humanizer?run=${r.id}`}>
                {r.title}
              </Link>
              <span className="flex shrink-0 items-center gap-2">
                {r.appliedAt ? <Chip tone="success">applied</Chip> : null}
                <RunStatusChip status={r.status} />
                <span className="text-muted text-xs">
                  <RelativeTime value={r.createdAt} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
