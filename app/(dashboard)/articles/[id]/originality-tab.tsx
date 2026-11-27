'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ScanSearch } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { SerializedTaskDetail } from '@/lib/tasks/detail';
import { RelativeTime } from '@/components/client';
import { Card, Chip, buttonClasses, type ChipTone } from '@/components/ui';

interface CheckRow {
  id: string;
  title: string;
  status: string;
  message: string | null;
  createdAt: string;
}

const TONE: Record<string, ChipTone> = { QUEUED: 'neutral', RUNNING: 'info', COMPLETED: 'success', FAILED: 'danger', CANCELLED: 'neutral' };

/** Plagiarism evidence checks of this article (the checker itself lives on its own page). */
export function OriginalityTab({ task }: { task: SerializedTaskDetail }) {
  const [checks, setChecks] = useState<CheckRow[] | null>(null);
  useEffect(() => {
    void api<{ checks: CheckRow[] }>(`/api/plagiarism/checks?taskId=${task.id}`).then((r) => setChecks(r.checks)).catch(() => setChecks([]));
  }, [task.id]);
  const hasText = Boolean(task.editedHtml || task.assembledHtml || task.bodyHtml);
  return (
    <Card
      title="Plagiarism evidence"
      description="Matching passages between this article and your other articles, the pages it links to, Wikipedia and (if configured) a licensed search API. Evidence to review, never a verdict."
      actions={
        hasText ? (
          <Link href={`/plagiarism?task=${task.id}`} className={buttonClasses('secondary', 'sm')}>
            <ScanSearch className="h-4 w-4" /> Check this article
          </Link>
        ) : null
      }
    >
      {checks === null ? <p className="text-muted text-sm">Loading…</p> : checks.length === 0 ? <p className="text-muted text-sm">No checks yet.</p> : null}
      <ul className="space-y-2 text-sm">
        {(checks ?? []).map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
            <Link className="min-w-0 truncate link" href={`/plagiarism?check=${c.id}`}>
              {c.message ?? c.title}
            </Link>
            <span className="flex shrink-0 items-center gap-2">
              <Chip tone={TONE[c.status] ?? 'neutral'}>{c.status.toLowerCase()}</Chip>
              <span className="text-muted text-xs">
                <RelativeTime value={c.createdAt} />
              </span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
