import { db } from '@/lib/db';
import { PageHeader } from '@/components/ui';
import { TaskTable } from '@/components/task-table';

export const metadata = { title: 'Article History' };

const GROUPS = ['all', 'queued', 'running', 'review', 'paused', 'draft', 'failed', 'cancelled'] as const;

export default async function HistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const group = GROUPS.includes(sp.group as (typeof GROUPS)[number]) ? (sp.group as (typeof GROUPS)[number]) : undefined;
  const websites = await db.website.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
  return (
    <>
      <PageHeader
        title="Article History"
        description="Every article ever created, including read-only records of the retired Celebrity Writer 2.0. Rank Math scores are shown only when read from the live WordPress panel."
      />
      <TaskTable storageKey="history" mode="history" websites={websites} initialGroup={group} initialQuery={sp.q} pollMs={15000} />
    </>
  );
}
