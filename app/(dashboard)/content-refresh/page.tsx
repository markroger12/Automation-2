import { db } from '@/lib/db';
import { PageHeader } from '@/components/ui';
import { ContentRefresh } from './refresh';

export const metadata = { title: 'Content Refresh' };
export const dynamic = 'force-dynamic';

export default async function ContentRefreshPage({ searchParams }: { searchParams: Promise<{ candidate?: string }> }) {
  const { candidate } = await searchParams;
  const websites = await db.website.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
  return (
    <>
      <PageHeader
        title="Content Refresh"
        description="Articles with evidence that something is out of date: a past edition year, a dead link, a contradicted fact or falling search traffic. You review and edit every revision; it is written to the same WordPress post only after you approve it, and live posts need the website's permission."
      />
      <ContentRefresh websites={websites} initialCandidate={candidate ?? null} />
    </>
  );
}
