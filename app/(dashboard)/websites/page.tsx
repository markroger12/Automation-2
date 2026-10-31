import Link from 'next/link';
import { Globe } from 'lucide-react';
import { db } from '@/lib/db';
import { LANGUAGE_LABELS, type Language } from '@/lib/domain';
import { Card, Chip, EmptyState, PageHeader, formatRelative } from '@/components/ui';
import { AddWebsite } from './add-website';

export const metadata = { title: 'Websites' };

export default async function WebsitesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const sites = await db.website.findMany({
    orderBy: [{ active: 'desc' }, { name: 'asc' }],
    include: { wordpressProfile: true, _count: { select: { categories: true, tasks: true } } },
  });
  return (
    <>
      <PageHeader
        title="Websites"
        description="WordPress sites, their persistent browser profiles and sessions. Each site has its own profile folder, cookies, categories and publishing permission."
        actions={<AddWebsite startOpen={sp.add === '1' || sites.length === 0} />}
      />
      {sites.length === 0 ? (
        <Card>
          <EmptyState icon={<Globe className="h-8 w-8" />} title="No websites yet" description="Add your first WordPress site with its user name and password: the app logs in and syncs its categories." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {sites.map((s) => {
            const state = s.wordpressProfile?.sessionState ?? 'UNKNOWN';
            return (
              <Link key={s.id} href={`/websites/${s.id}`} className="surface block rounded-xl border p-4 transition hover:border-[color-mix(in_oklab,var(--text)_35%,transparent)]">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-semibold">{s.name}</div>
                    <div className="text-muted truncate text-xs">{s.publicUrl}</div>
                  </div>
                  <Chip tone={state === 'ACTIVE' ? 'success' : state === 'LOGIN_REQUIRED' ? 'warning' : state === 'ERROR' ? 'danger' : 'neutral'}>
                    {state === 'ACTIVE' ? 'session active' : state === 'LOGIN_REQUIRED' ? 'login required' : state.toLowerCase()}
                  </Chip>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <Chip>{LANGUAGE_LABELS[s.language as Language] ?? s.language}</Chip>
                  <Chip>{s.timezone}</Chip>
                  <Chip>{s._count.categories} categories</Chip>
                  <Chip>{s.detectedEditor ? s.detectedEditor.toLowerCase() : 'editor ?'}</Chip>
                  {s.canPublish ? <Chip tone="danger">can publish</Chip> : <Chip tone="success">drafts only</Chip>}
                  {!s.active ? <Chip>inactive</Chip> : null}
                  {s.paused ? <Chip tone="warning">paused</Chip> : null}
                </div>
                <div className="text-muted mt-3 text-xs">
                  {s._count.tasks} article(s) · session checked {formatRelative(s.wordpressProfile?.lastCheckedAt)}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </>
  );
}
