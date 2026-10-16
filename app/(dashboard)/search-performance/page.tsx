import { db } from '@/lib/db';
import { PageHeader } from '@/components/ui';
import { SearchPerformance } from './search';

export const metadata = { title: 'Search Performance' };
export const dynamic = 'force-dynamic';

export default async function SearchPerformancePage({ searchParams }: { searchParams: Promise<{ site?: string }> }) {
  const { site } = await searchParams;
  const websites = await db.website.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true } });
  return (
    <>
      <PageHeader
        title="Search Performance"
        description="Clicks, impressions, CTR and position from Search Console: live through your service account (Google’s official API), or from reports you export and import. Nothing is estimated. Indexing requests are kept apart from Google’s own evidence of indexing."
      />
      <SearchPerformance websites={websites} initialSite={site && websites.some((w) => w.id === site) ? site : null} />
    </>
  );
}
