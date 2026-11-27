import { db } from '@/lib/db';
import { PageHeader } from '@/components/ui';
import { UpdatePosts } from './posts';

export const metadata = { title: 'Update to Latest' };
export const dynamic = 'force-dynamic';

/** Owner request 2026-11-27: bring old posts up to date with ChatGPT, also the ones the app did not write. */
export default async function UpdatePostsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const websites = await db.website.findMany({ where: { active: true }, orderBy: { name: 'asc' }, select: { id: true, name: true, allowLiveUpdates: true, categories: { select: { externalId: true, name: true }, orderBy: { name: 'asc' } } } });
  return (
    <>
      <PageHeader
        title="Update to Latest"
        description="Bring old posts up to date — also the ones the app did not write. The app reads them from WordPress, ChatGPT checks each one against current sources and updates what is outdated, the app checks the answer, and you approve it before anything changes in WordPress."
      />
      <UpdatePosts websites={websites.map((w) => ({ id: w.id, name: w.name, allowLiveUpdates: w.allowLiveUpdates, categories: w.categories.map((c) => ({ id: c.externalId, name: c.name })) }))} initialWebsite={sp.website ?? null} initialView={sp} />
    </>
  );
}
