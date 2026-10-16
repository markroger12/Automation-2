import { db } from '@/lib/db';
import { PageHeader, LinkButton } from '@/components/ui';
import { TaskTable } from '@/components/task-table';
import { allowedSlots, getRateState } from '@/lib/chatgpt/rate';
import { getWorkerHealth } from '@/lib/health';
import { PenLine } from 'lucide-react';

export const metadata = { title: 'Article Queue' };

const GROUPS = ['all', 'queued', 'running', 'review', 'paused', 'draft', 'failed', 'cancelled'] as const;

export default async function QueuePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const group = GROUPS.includes(sp.group as (typeof GROUPS)[number]) ? (sp.group as (typeof GROUPS)[number]) : undefined;
  const [websites, slots, rate, worker] = await Promise.all([
    db.website.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    allowedSlots(),
    getRateState(),
    getWorkerHealth(),
  ]);
  const backoff = rate.backoffUntil && new Date(rate.backoffUntil) > new Date() ? new Date(rate.backoffUntil) : null;
  return (
    <>
      <PageHeader
        title="Article Queue"
        description={
          <>
            Live progress for every task. Worker {worker.state === 'online' ? 'online' : <strong className="text-rose-700 dark:text-rose-400">{worker.state}</strong>} · {slots} article slot(s) active
            {backoff ? <strong className="text-amber-700"> · ChatGPT backoff until {backoff.toLocaleTimeString()} ({rate.reason})</strong> : null}
          </>
        }
        actions={
          <LinkButton href="/single-article" variant="primary">
            <PenLine className="h-4 w-4" /> New single article
          </LinkButton>
        }
      />
      <TaskTable storageKey="queue" mode="queue" websites={websites} initialGroup={group} />
    </>
  );
}
