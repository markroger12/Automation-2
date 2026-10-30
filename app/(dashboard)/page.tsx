import Link from 'next/link';
import { Layers, PenLine } from 'lucide-react';
import { db } from '@/lib/db';
import { getExtensionHealth, getWorkerHealth } from '@/lib/health';
import { siteSummaries, taskGroupCounts } from '@/lib/stats';
import { LANGUAGE_LABELS, moduleDisplayName, type Language } from '@/lib/domain';
import { Card, Chip, EmptyState, LinkButton, PageHeader, ProgressBar, Stat, StatusChip, formatRelative } from '@/components/ui';

export const metadata = { title: 'Overview' };

export default async function OverviewPage() {
  // The health warnings are in the banner above every page (app/(dashboard)/layout.tsx), not repeated here.
  const [counts, worker, extension, sites, recent] = await Promise.all([
    taskGroupCounts(),
    getWorkerHealth(),
    getExtensionHealth(),
    siteSummaries(),
    db.articleTask.findMany({
      orderBy: { updatedAt: 'desc' },
      take: 10,
      select: { id: true, keyword: true, status: true, percent: true, moduleKey: true, updatedAt: true, message: true, website: { select: { name: true } } },
    }),
  ]);

  return (
    <>
      <PageHeader
        title="Overview"
        description="Everything below is read from the local database and live heartbeats — no simulated numbers."
        actions={
          <>
            <LinkButton href="/single-article" variant="primary">
              <PenLine className="h-4 w-4" /> Single Article
            </LinkButton>
            <LinkButton href="/campaigns">
              <Layers className="h-4 w-4" /> Bulk Campaign
            </LinkButton>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        <Stat label="All articles" value={counts.total} hint="Article History" href="/history" />
        <Stat label="Queued" value={counts.queued} hint="waiting to start" href="/queue?group=queued" />
        <Stat label="Running" value={counts.running} hint="being written" href="/queue?group=running" />
        <Stat label="Review" value={counts.review} tone={counts.review ? 'warning' : undefined} hint="needs you" href="/queue?group=review" />
        <Stat label="Paused" value={counts.paused} tone={counts.paused ? 'warning' : undefined} hint="sign-in or limits" href="/queue?group=paused" />
        <Stat label="Drafts" value={counts.draft} tone={counts.draft ? 'success' : undefined} hint="in WordPress" href="/history?group=draft" />
        <Stat label="Failed" value={counts.failed} tone={counts.failed ? 'danger' : undefined} hint="open to retry" href="/queue?group=failed" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-3">
        <Card title="Recent work" className="xl:col-span-2" padded={false} actions={<LinkButton href="/queue" size="sm">Open queue</LinkButton>}>
          {recent.length === 0 ? (
            <EmptyState
              title="No articles yet"
              description="Start one article from Single Article, or import many keywords in Bulk Campaigns."
              action={<LinkButton href="/single-article" variant="primary">Write a single article</LinkButton>}
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="table-app">
                <thead>
                  <tr>
                    <th>Article</th>
                    <th>Status</th>
                    <th className="w-36">Progress</th>
                    <th className="text-right">Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((task) => (
                    <tr key={task.id}>
                      <td className="max-w-0 w-full">
                        <Link className="block truncate font-medium hover:underline" href={`/articles/${task.id}`} title={task.keyword}>
                          {task.keyword}
                        </Link>
                        <div className="text-muted truncate text-xs" title={task.message ?? undefined}>
                          {task.website.name} · {moduleDisplayName(task.moduleKey)}
                        </div>
                      </td>
                      <td className="whitespace-nowrap">
                        <StatusChip status={task.status} />
                      </td>
                      <td>
                        <ProgressBar label={`Progress of ${task.keyword}`} value={task.percent} tone={task.status === 'FAILED' ? 'danger' : task.status === 'COMPLETED' ? 'success' : 'brand'} />
                      </td>
                      <td className="text-muted whitespace-nowrap text-right">{formatRelative(task.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="System health" description="Live heartbeats; stale ones count as offline.">
          <ul className="space-y-3 text-sm">
            <li className="flex items-center justify-between gap-3">
              <span>Worker</span>
              <Chip tone={worker.state === 'online' ? 'success' : 'danger'}>
                {worker.state === 'online' ? 'Online' : worker.state === 'stale' ? 'Stale heartbeat' : 'Offline'}
              </Chip>
            </li>
            <li className="text-muted -mt-2 text-xs">Last heartbeat: {formatRelative(worker.lastSeenAt)}{worker.pid ? ` · PID ${worker.pid}` : ''}</li>
            <li className="flex items-center justify-between gap-3">
              <span>ChatGPT extension</span>
              <Chip tone={extension.state === 'connected' ? 'success' : 'warning'}>
                {extension.state === 'connected' ? `Connected · ${extension.tabs} tab(s)` : extension.state === 'stale' ? 'Not responding' : 'Not paired'}
              </Chip>
            </li>
            <li className="text-muted -mt-2 text-xs">
              Last seen: {formatRelative(extension.lastSeenAt)}
              {extension.version ? ` · v${extension.version}` : ''}
            </li>
            <li className="flex items-center justify-between gap-3">
              <span>WordPress sessions</span>
              <span className="text-muted text-xs">
                {sites.filter((s) => s.sessionState === 'ACTIVE').length} active / {sites.length} site(s)
              </span>
            </li>
          </ul>
          <div className="mt-4 flex gap-2">
            <LinkButton href="/diagnostics" size="sm">Diagnostics</LinkButton>
            <LinkButton href="/automation-chrome" size="sm">Automation Chrome</LinkButton>
          </div>
        </Card>
      </div>

      <Card title="Websites" className="mt-6" padded={false} actions={<LinkButton href="/websites" size="sm">Manage</LinkButton>}>
        {sites.length === 0 ? (
          <EmptyState title="No websites configured" description="Add a WordPress site, log in once in the visible browser, then sync categories." action={<LinkButton href="/websites" variant="primary">Add website</LinkButton>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-app">
              <thead>
                <tr>
                  <th>Website</th>
                  <th>Language</th>
                  <th>Session</th>
                  <th>Categories</th>
                  <th>Queued</th>
                  <th>Running</th>
                  <th>Review</th>
                  <th>Drafts</th>
                  <th>Failed</th>
                  <th title="Verified complete drafts in the last 24 hours">Verified 24h</th>
                  <th>Publishing</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((site) => (
                  <tr key={site.id}>
                    <td>
                      <Link href={`/websites/${site.id}`} className="font-medium hover:underline">
                        {site.name}
                      </Link>
                      {!site.active ? <Chip className="ml-2">inactive</Chip> : site.paused ? <Chip tone="warning" className="ml-2">paused</Chip> : null}
                    </td>
                    <td>{LANGUAGE_LABELS[site.language as Language] ?? site.language}</td>
                    <td>
                      <Chip tone={site.sessionState === 'ACTIVE' ? 'success' : site.sessionState === 'LOGIN_REQUIRED' ? 'warning' : site.sessionState === 'ERROR' ? 'danger' : 'neutral'}>
                        {site.sessionState.replace('_', ' ').toLowerCase()}
                      </Chip>
                    </td>
                    <td className="tabular-nums">{site.categories}</td>
                    <td className="tabular-nums">{site.counts.queued}</td>
                    <td className="tabular-nums">{site.counts.running}</td>
                    <td className="tabular-nums">{site.counts.review}</td>
                    <td className="tabular-nums">{site.counts.draft}</td>
                    <td className="tabular-nums">{site.counts.failed}</td>
                    <td className="tabular-nums">{site.verified24h}</td>
                    <td>{site.canPublish ? <Chip tone="danger">can publish</Chip> : <Chip>drafts only</Chip>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
