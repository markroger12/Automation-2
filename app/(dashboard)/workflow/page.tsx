import Link from 'next/link';
import { CalendarClock } from 'lucide-react';
import { db } from '@/lib/db';
import { Card, EmptyState, PageHeader, buttonClasses } from '@/components/ui';
import { WorkflowPage } from './workflow';

export const metadata = { title: 'Workflow' };

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const sites = await db.website.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }], select: { id: true, name: true, active: true } });
  const initial = sites.find((s) => s.id === sp.site)?.id ?? sites[0]?.id;
  const description = 'A keyword queue per website that writes one article per publishing slot. It saves verified drafts and, only where you allowed publishing, schedules them for their slot.';
  return (
    <>
      {initial ? (
        <WorkflowPage sites={sites} initialSiteId={initial} description={description} />
      ) : (
        <>
          <PageHeader title="Workflow" description={description} />
          <Card>
            <EmptyState icon={<CalendarClock className="h-8 w-8" />} title="No websites yet" description="A workflow belongs to a website." action={<Link className={buttonClasses('primary')} href="/websites?add=1">Add a website</Link>} />
          </Card>
        </>
      )}
    </>
  );
}
