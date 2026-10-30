import { collectDiagnostics } from '@/lib/diagnostics';
import { listPageCopies } from '@/lib/page-copies';
import { Card, Chip, EmptyState, KeyValue, PageHeader, formatDateTime, formatRelative } from '@/components/ui';
import { DiagnosticsActions } from './actions';
import { DiagnosticChecks } from './checks';

export const metadata = { title: 'Diagnostics' };

export default async function DiagnosticsPage() {
  const d = await collectDiagnostics();
  const copies = listPageCopies();
  const lock = d.lock as { state: string; workerId?: string; pid?: number; pidAlive?: boolean; heartbeatAgeSec?: number };
  return (
    <>
      <PageHeader
        title="Logs / Diagnostics"
        description="Live state of the worker, its lock, queue leases, sessions and the extension. The downloadable bundle strips cookies, keys and tokens."
        actions={<DiagnosticsActions />}
      />
      <div className="grid items-start gap-6 lg:grid-cols-2">
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
              { label: 'Capabilities', value: Object.keys(d.extension.capabilities).length ? Object.entries(d.extension.capabilities).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`).join(' · ') : '—' },
            ]}
          />
        </Card>
        <Card title="ChatGPT rate limits">
          <KeyValue
            items={[
              { label: 'Backoff', value: d.chatgptRate.backoffUntil && new Date(d.chatgptRate.backoffUntil) > new Date() ? <Chip tone="warning">until {formatDateTime(d.chatgptRate.backoffUntil)}</Chip> : <Chip tone="success">none</Chip> },
              { label: 'Last 429 / usage limit', value: d.chatgptRate.last429At ? `${formatDateTime(d.chatgptRate.last429At)} (${formatRelative(d.chatgptRate.last429At)})${d.chatgptRate.reason ? ` — ${d.chatgptRate.reason}` : ''}` : 'never' },
              { label: 'Recent 429s', value: d.chatgptRate.recent429Count },
              { label: 'Current concurrency', value: `${d.chatgptRate.concurrency} (step ${d.chatgptRate.step})` },
              { label: 'Last success', value: d.chatgptRate.lastSuccessAt ? formatRelative(d.chatgptRate.lastSuccessAt) : '—' },
            ]}
          />
        </Card>
        <DiagnosticChecks sessions={d.sessions.map((x) => ({ ...x, lastCheckedAt: x.lastCheckedAt ? new Date(x.lastCheckedAt).toISOString() : null }))} failedStages={d.failedStages} />
        <Card title="Failing page snapshots" description="What the extension saw on the ChatGPT page when a step failed (page variant, composer, send/stop buttons…). No cookies or page text.">
          {d.failureSnapshots.length === 0 ? (
            <p className="text-muted text-sm">None recorded.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {d.failureSnapshots.map((f) => (
                <li key={f.id}>
                  <details>
                    <summary className="cursor-pointer">
                      {formatDateTime(f.updatedAt)} · {f.kind} · <Chip tone={f.status === 'FAILED' ? 'danger' : 'neutral'}>{f.status.toLowerCase()}</Chip> {f.errorCode ?? ''} <span className="text-muted">{(f.error ?? '').slice(0, 120)}</span>
                    </summary>
                    <pre className="surface-2 mt-1 max-h-64 overflow-auto rounded p-2 text-xs">{JSON.stringify(f.snapshot, null, 2)}</pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card
          title="Page structure copies"
          description="When the extension takes fewer gallery photos than ChatGPT shows, or Search Console's answer may be missing from the screenshot, it saves the page's structure here: elements, button names and sizes, never the chat or page text. Download the newest one and send it to the developer."
        >
          {copies.length === 0 ? (
            <p className="text-muted text-sm">None yet — nothing went wrong that needed one.</p>
          ) : (
            <ul className="divide-y divide-[var(--border)] text-sm">
              {copies.slice(0, 8).map((c) => (
                <li key={c.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <Chip tone={c.kind === 'chatgpt-gallery' ? 'brand' : 'neutral'}>{c.kind === 'chatgpt-gallery' ? 'ChatGPT gallery' : 'Search Console'}</Chip>
                  <span className="text-muted text-xs">
                    {formatDateTime(c.savedAt)} · {Math.max(1, Math.round(c.bytes / 1024))} KB
                  </span>
                  <a className="ml-auto text-xs font-medium hover:underline" href={`/api/diagnostics/page-copies/${c.name}`} download>
                    Download
                  </a>
                </li>
              ))}
            </ul>
          )}
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
              {
                label: 'Migrations',
                value: d.database.migrations.length ? (
                  <details>
                    <summary className="cursor-pointer">
                      {d.database.migrations.length} applied · latest <span className="font-mono text-xs">{d.database.migrations[d.database.migrations.length - 1].migration_name}</span>
                    </summary>
                    <ul className="text-muted mt-1 space-y-0.5 font-mono text-xs">
                      {d.database.migrations.map((m) => (
                        <li key={m.migration_name}>{m.migration_name}</li>
                      ))}
                    </ul>
                  </details>
                ) : (
                  '—'
                ),
              },
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
