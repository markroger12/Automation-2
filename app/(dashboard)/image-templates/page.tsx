import Link from 'next/link';
import { ImageIcon } from 'lucide-react';
import { db } from '@/lib/db';
import { Card, EmptyState, PageHeader, buttonClasses } from '@/components/ui';
import { TemplateDesigner } from './designer';

export const metadata = { title: 'Image Template Designer' };

export default async function ImageTemplatesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const sites = await db.website.findMany({ orderBy: [{ active: 'desc' }, { name: 'asc' }], select: { id: true, name: true, active: true } });
  const initial = sites.find((s) => s.id === sp.site)?.id ?? sites[0]?.id ?? null;
  return (
    <>
      <PageHeader
        title="Image Template Designer"
        description="Branded featured and body images per website, on a true 1920×1080 canvas. The preview is drawn by the same renderer the article pipeline uses."
      />
      {initial ? (
        <TemplateDesigner sites={sites} initialSiteId={initial} />
      ) : (
        <Card>
          <EmptyState
            icon={<ImageIcon className="h-8 w-8" />}
            title="No websites yet"
            description="Templates belong to a website. Add a website first."
            action={
              <Link href="/websites?add=1" className={buttonClasses('primary')}>
                Add a website
              </Link>
            }
          />
        </Card>
      )}
    </>
  );
}
