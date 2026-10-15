import Link from 'next/link';
import { db } from '@/lib/db';
import { RUNNING_STATUSES } from '@/lib/domain';
import { listBackups } from '@/lib/backup';
import { Card, Chip, EmptyState, PageHeader, StatusChip, formatDateTime, formatRelative } from '@/components/ui';
import { IncidentActions, StalledTaskActions } from './actions';

export const metadata = { title: 'Recovery Center' };

export default async function RecoveryPage() {
  const now = new Date();
  const [open, recent, expiredLeases, stalled, backups] = await Promise.all([
    db.recoveryIncident.findMany({ where: { status: 'OPEN' }, orderBy: [{ severity: 'asc' }, { createdAt: 'desc' }], take: 200 }),
    db.recoveryIncident.findMany({ where: { status: { not: 'OPEN' } }, orderBy: { createdAt: 'desc' }, take: 50 }),
    db.queueJob.findMany({ where: { status: 'ACTIVE', leaseUntil: { lt: now } }, take: 100 }),
    db.articleTask.findMany({ where: { status: { in: RUNNING_STATUSES }, updatedAt: { lt: new Date(now.getTime() - 30 * 60_000) } }, take: 100, select: { id: true, keyword: true, status: true, stage: true, updatedAt: true, message: true } }),
    Promise.resolve(listBackups().slice(0, 5)),
  ]);
  const taskIds = [...new Set(open.map((i) => i.taskId).filter((x): x is string => Boolean(x)))];
  const shots = taskIds.length
    ? await db.log.findMany({ where: { taskId: { in: taskIds }, screenshotPath: { not: null } }, orderBy: { createdAt: 'desc' }, select: { taskId: true, screenshotPath: true, createdAt: true } })
    : [];
  return (
    <>
      <PageHeader
        title="Recovery Center"
        description="Stalled jobs and actions whose outcome could not be proven (a sent prompt without a saved answer, a WordPress create without an acknowledgement). Nothing here is retried blindly: verify, then resume from the saved checkpoint."
      />
      <Card title={`Open incidents (${open.length})`} padded={false}>
        {open.length === 0 ? (
          <EmptyState title="No open incidents" description="Restarts and lease expiries that were recovered automatically are listed below." />
        ) : (
          <table className="table-app">
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Description</th>
                <th>Evidence</th>
                <th className="text-right">Reconcile</th>
              </tr>
            </thead>
            <tbody>
              {open.map((i) => {
                const shot = shots.find((s) => s.taskId === i.taskId);
                return (
                  <tr key={i.id}>
                    <td className="text-xs whitespace-nowrap">{formatDateTime(i.createdAt)}</td>
                    <td>
                      <Chip tone={i.severity === 'critical' ? 'danger' : 'warning'}>{i.kind}</Chip>
                    </td>
                    <td className="max-w-[420px] text-sm">
                      {i.description}
                      {i.taskId ? (
                        <div>
                          <Link className="text-xs text-indigo-600 hover:underline" href={i.kind === 'UNCERTAIN_WP_CREATE' ? `/articles/${i.taskId}?tab=wordpress` : `/articles/${i.taskId}`}>
                            {i.kind === 'UNCERTAIN_WP_CREATE' ? 'Choose the right WordPress post' : `Open article${i.stageKey ? ` (${i.stageKey})` : ''}`}
                          </Link>
                        </div>
                      ) : null}
                    </td>
                    <td className="max-w-[260px] text-xs">
                      <code className="break-all">{i.evidence}</code>
                      {shot?.screenshotPath ? (
                        <div>
                          <a className="text-indigo-600 underline" href={`/api/files/screenshot?path=${encodeURIComponent(shot.screenshotPath)}`} target="_blank" rel="noreferrer">
                            last screenshot ({formatRelative(shot.createdAt)})
                          </a>
                        </div>
                      ) : null}
                    </td>
                    <td>
                      <IncidentActions id={i.id} hasTask={Boolean(i.taskId)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title={`Expired leases (${expiredLeases.length})`} description="Swept automatically every 15 seconds by the worker." padded={false}>
          {expiredLeases.length === 0 ? (
            <EmptyState title="None" />
          ) : (
            <table className="table-app">
              <tbody>
                {expiredLeases.map((j) => (
                  <tr key={j.id}>
                    <td>
                      {j.queue}/{j.kind}
                    </td>
                    <td className="text-xs">{j.claimedByTab ? `tab ${j.claimedByTab}` : j.lockedBy}</td>
                    <td className="text-xs">expired {formatRelative(j.leaseUntil)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title={`Slow / possibly stalled tasks (${stalled.length})`} description="Running with no update for 30+ minutes." padded={false}>
          {stalled.length === 0 ? (
            <EmptyState title="None" />
          ) : (
            <table className="table-app">
              <tbody>
                {stalled.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link className="hover:underline" href={`/articles/${t.id}`}>
                        {t.keyword}
                      </Link>
                    </td>
                    <td>
                      <StatusChip status={t.status} />
                    </td>
                    <td className="text-xs">{formatRelative(t.updatedAt)}</td>
                    <td className="text-right">
                      <StalledTaskActions taskId={t.id} stage={t.stage} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
      <Card title="Recently resolved / automatic recoveries" className="mt-6" padded={false}>
        {recent.length === 0 ? (
          <EmptyState title="Nothing yet" />
        ) : (
          <table className="table-app">
            <tbody>
              {recent.map((i) => (
                <tr key={i.id}>
                  <td className="text-xs whitespace-nowrap">{formatDateTime(i.createdAt)}</td>
                  <td>
                    <Chip>{i.status.toLowerCase().replace('_', ' ')}</Chip>
                  </td>
                  <td className="text-xs">{i.kind}</td>
                  <td className="text-sm">{i.description}</td>
                  <td className="text-muted text-xs">{i.resolution}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Local backups" className="mt-6" description="Create backups from Diagnostics or `npm run db:backup -- --media`. Profile folders are never deleted automatically.">
        {backups.length === 0 ? <p className="text-muted text-sm">No backups yet.</p> : <ul className="text-sm">{backups.map((b) => <li key={b.name}>{b.name} · {(b.sizeBytes / 1024).toFixed(0)} KB</li>)}</ul>}
      </Card>
    </>
  );
}
