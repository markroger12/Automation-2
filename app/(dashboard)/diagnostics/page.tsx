import { collectDiagnostics } from '@/lib/diagnostics';
import { Card, Chip, EmptyState, KeyValue, PageHeader, formatDateTime, formatRelative } from '@/components/ui';
import { DiagnosticsActions } from './actions';

export const metadata = { title: 'Diagnostics' };

export default async function DiagnosticsPage() {
  const d = await collectDiagnostics();
  const lock = d.lock as { state: string; workerId?: string; pid?: number; pidAlive?: boolean; heartbeatAgeSec?: number };
  return (
    <>
      <PageHeader
        title="Logs / Diagnostics"
        description="Live state of the worker, its lock, queue leases, sessions and the extension. The downloadable bundle strips cookies, keys and tokens."
        actions={<DiagnosticsActions />}
      />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Worker">
          <KeyValue
            items={[
              { label: 'State', value: <Chip tone={d.worker.state === 'online' ? 'success' : 'danger'}>{d.worker.state}</Chip> },
              { label: 'Last heartbeat', value: `${formatDateTime(d.worker.lastSeenAt)} (${formatRelative(d.worker.lastSeenAt)})` },
              { label: 'PID', value: d.worker.pid ?? '—' },
              { label: 'Version', value: d.worker.version ?? '—' },
              {
                label: 'Lock file',
                value:
                  lock.state === 'held' ? (
                    <span>
                      held by {lock.workerId} · PID {lock.pid} {lock.pidAlive ? <Chip tone="success">alive</Chip> : <Chip tone="danger">dead</Chip>} · heartbeat {lock.heartbeatAgeSec}s ago
                    </span>
                  ) : (
                    lock.state
                  ),
              },
            ]}
          />
        </Card>
        <Card title="ChatGPT extension">
          <KeyValue
            items={[
              { label: 'State', value: <Chip tone={d.extension.state === 'connected' ? 'success' : 'warning'}>{d.extension.state}</Chip> },
              { label: 'Last seen', value: formatRelative(d.extension.lastSeenAt) },
              { label: 'Version', value: d.extension.version ?? '—' },
              { label: 'Open ChatGPT tabs', value: d.extension.tabs },
              { label: 'Last backoff / 429', value: String((d.extension.diagnostics as Record<string, unknown>).backoff ?? '—') },
            ]}
          />
        </Card>
        <Card title="Queue" padded={false}>
          {d.queue.counts.length === 0 ? (
            <EmptyState title="Queue is empty" />
          ) : (
            <table className="table-app">
              <thead>
                <tr>
                  <th>Queue</th>
                  <th>Status</th>
                  <th>Jobs</th>
                </tr>
              </thead>
              <tbody>
                {d.queue.counts.map((c) => (
                  <tr key={`${c.queue}-${c.status}`}>
                    <td>{c.queue}</td>
                    <td>{c.status}</td>
                    <td className="tabular-nums">{c.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Active leases" padded={false}>
          {d.queue.activeLeases.length === 0 ? (
            <EmptyState title="No active leases" />
          ) : (
            <table className="table-app">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Owner</th>
                  <th>Lease until</th>
                  <th>Heartbeat</th>
                </tr>
              </thead>
              <tbody>
                {d.queue.activeLeases.map((j) => (
                  <tr key={j.id}>
                    <td>
                      {j.queue}/{j.kind}
                      <div className="text-muted text-xs">{j.id}</div>
                    </td>
                    <td className="text-xs">{j.claimedByTab ? `tab ${j.claimedByTab}` : j.lockedBy}</td>
                    <td className="text-xs">{formatDateTime(j.leaseUntil)}</td>
                    <td className="text-xs">{formatRelative(j.heartbeatAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Card title="Browsers & profiles">
          <KeyValue
            items={[
              { label: 'Installed browsers', value: d.browsers.length ? d.browsers.map((b) => `${b.name} (${b.path})`).join(', ') : <Chip tone="warning">none found</Chip> },
              { label: 'Browser profiles', value: d.profiles.length ? d.profiles.map((p) => `${p.name} [${p.kind}] ${p.sessionState}`).join(' · ') : '—' },
            ]}
          />
        </Card>
        <Card title="Database & backups">
          <KeyValue
            items={[
              { label: 'Database size', value: `${(d.database.sizeBytes / 1024).toFixed(0)} KB` },
              { label: 'Migrations', value: d.database.migrations.map((m) => m.migration_name).join(', ') || '—' },
              { label: 'Recent backups', value: d.backups.length ? d.backups.slice(0, 5).map((b) => b.name).join(', ') : 'none yet' },
              { label: 'Runtime', value: `Node ${d.app.node} · ${d.app.platform}` },
            ]}
          />
        </Card>
      </div>
      <Card title="Recent errors" className="mt-6" padded={false}>
        {d.logs.recentErrors.length === 0 ? (
          <EmptyState title="No errors logged" />
        ) : (
          <table className="table-app">
            <thead>
              <tr>
                <th>Time</th>
                <th>Category</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {d.logs.recentErrors.map((e, i) => (
                <tr key={i}>
                  <td className="whitespace-nowrap text-xs">{formatDateTime(e.createdAt)}</td>
                  <td>{e.category}</td>
                  <td className="break-words">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
