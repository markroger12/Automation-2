import Link from 'next/link';
import { Layers, PenLine } from 'lucide-react';
import { db } from '@/lib/db';
import { getExtensionHealth, getHealthWarnings, getWorkerHealth } from '@/lib/health';
import { siteSummaries, taskGroupCounts } from '@/lib/stats';
import { LANGUAGE_LABELS, moduleDisplayName, type Language } from '@/lib/domain';
import { Alert, Card, Chip, EmptyState, LinkButton, PageHeader, ProgressBar, Stat, StatusChip, formatRelative } from '@/components/ui';

export const metadata = { title: 'Overview' };

export default async function OverviewPage() {
  const [counts, worker, extension, warnings, sites, recent] = await Promise.all([
    taskGroupCounts(),
    getWorkerHealth(),
    getExtensionHealth(),
    getHealthWarnings(),
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
        <Stat label="Total tasks" value={counts.total} href="/history" />
        <Stat label="Queued" value={counts.queued} href="/queue?group=queued" />
        <Stat label="Running" value={counts.running} href="/queue?group=running" />
        <Stat label="Needs review / approval" value={counts.review} tone={counts.review ? 'warning' : undefined} href="/queue?group=review" />
        <Stat label="Paused (login/limits)" value={counts.paused} tone={counts.paused ? 'warning' : undefined} href="/queue?group=paused" />
        <Stat label="Drafts" value={counts.draft} tone={counts.draft ? 'success' : undefined} href="/history?group=draft" />
        <Stat label="Failed" value={counts.failed} tone={counts.failed ? 'danger' : undefined} href="/queue?group=failed" />
      </div>

      {warnings.length > 0 ? (
        <div className="mt-6 space-y-2">
          {warnings.map((w, i) => (
            <Alert
              key={i}
              tone={w.tone}
              title={w.title}
              action={w.href ? <LinkButton href={w.href} size="sm">{w.action ?? 'Open'}</LinkButton> : undefined}
            >
              {w.detail}
            </Alert>
          ))}
        </div>
      ) : null}

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
                    <th>Keyword</th>
                    <th>Writer</th>
                    <th>Website</th>
                    <th>Status</th>
                    <th className="w-40">Progress</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((task) => (
                    <tr key={task.id}>
                      <td>
                        <Link className="font-medium hover:underline" href={`/articles/${task.id}`}>
                          {task.keyword}
                        </Link>
                        {task.message ? <div className="text-muted line-clamp-1 text-xs">{task.message}</div> : null}
                      </td>
                      <td className="whitespace-nowrap">{moduleDisplayName(task.moduleKey)}</td>
                      <td>{task.website.name}</td>
                      <td>
                        <StatusChip status={task.status} />
                      </td>
                      <td>
                        <ProgressBar value={task.percent} tone={task.status === 'FAILED' ? 'danger' : task.status === 'COMPLETED' ? 'success' : 'brand'} />
                      </td>
                      <td className="text-muted whitespace-nowrap">{formatRelative(task.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card title="System health" description="Heartbeats must be fresh to count as online.">
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
