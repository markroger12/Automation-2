import Link from 'next/link';
import { notFound } from 'next/navigation';
import { db } from '@/lib/db';
import { parseJson } from '@/lib/json';
import { parseSiteOverrides } from '@/lib/settings';
import { Alert, Card, Chip, EmptyState, KeyValue, PageHeader, formatDateTime, formatRelative } from '@/components/ui';
import { ControlActionButton } from '@/components/control-action';
import { WebsiteForm, type WebsiteFormValues } from '../website-form';
import { PublishingPermission } from './publishing';
import { DangerZone } from './danger';

export const metadata = { title: 'Website' };

export default async function WebsitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const site = await db.website.findUnique({
    where: { id },
    include: { wordpressProfile: true, categories: { orderBy: { name: 'asc' } }, _count: { select: { tasks: true } } },
  });
  if (!site) notFound();
  const [jobs, audits, blockedAttempts] = await Promise.all([
    db.queueJob.findMany({ where: { queue: 'control', websiteId: id }, orderBy: { createdAt: 'desc' }, take: 8 }),
    db.auditLog.findMany({ where: { entityType: 'Website', entityId: id, action: { not: 'publish.blocked' } }, orderBy: { createdAt: 'desc' }, take: 10 }),
    db.auditLog.count({ where: { entityType: 'Website', entityId: id, action: 'publish.blocked' } }),
  ]);
  const profile = site.wordpressProfile;
  const state = profile?.sessionState ?? 'UNKNOWN';
  const diag = parseJson<Record<string, unknown>>(profile?.diagnostics, {});
  const overrides = parseSiteOverrides(site.settingsOverrides);
  const initial: WebsiteFormValues = {
    id: site.id,
    name: site.name,
    publicUrl: site.publicUrl,
    adminUrl: site.adminUrl,
    language: site.language === 'de' ? 'de' : 'en',
    targetCountry: site.targetCountry,
    timezone: site.timezone,
    internalLinkLine: site.internalLinkLine,
    editorType: site.editorType as WebsiteFormValues['editorType'],
    defaultCategoryId: site.defaultCategoryId ?? '',
    searchConsoleProperty: site.searchConsoleProperty ?? '',
    queueQuota: site.queueQuota,
    priority: site.priority,
    paused: site.paused,
    active: site.active,
    notes: site.notes ?? '',
    settingsOverrides: { content: overrides.content, seo: overrides.seo, workflow: overrides.workflow },
  };
  const live = jobs.find((j) => j.status === 'WAITING' || j.status === 'ACTIVE');

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/websites" className="hover:underline">
            ← Websites
          </Link>
        }
        title={site.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <a className="text-indigo-600 hover:underline" href={site.publicUrl} target="_blank" rel="noreferrer">
              {site.publicUrl}
            </a>
            <Chip tone={state === 'ACTIVE' ? 'success' : state === 'LOGIN_REQUIRED' ? 'warning' : state === 'ERROR' ? 'danger' : 'neutral'}>{state.replace('_', ' ').toLowerCase()}</Chip>
            {site.canPublish ? <Chip tone="danger">can publish</Chip> : <Chip tone="success">drafts only</Chip>}
          </span>
        }
      />

      {state !== 'ACTIVE' ? (
        <div className="mb-6">
          <Alert tone="warning" title={state === 'UNKNOWN' ? 'Next step: log in once' : 'WordPress session needs attention'}>
            Click <strong>Log in</strong>. A visible browser window opens on your WordPress login page; sign in yourself (the app never sees your password). Keep “Remember Me” ticked (it is pre-ticked) so the login survives restarts. The window closes automatically after sign-in, then categories are synced.
          </Alert>
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card title="WordPress session" className="xl:col-span-2" description={`Profile folder data/${profile?.profileDir ?? `profiles/${site.slug}`}`}>
          <div className="flex flex-wrap gap-2">
            <ControlActionButton websiteId={site.id} action="login" variant="primary">
              Log in (visible window)
            </ControlActionButton>
            <ControlActionButton websiteId={site.id} action="test">
              Test session
            </ControlActionButton>
            <ControlActionButton websiteId={site.id} action="refresh">
              Refresh session
            </ControlActionButton>
            <ControlActionButton websiteId={site.id} action="sync-categories">
              Sync categories
            </ControlActionButton>
            <ControlActionButton websiteId={site.id} action="detect-editor">
              Detect editor
            </ControlActionButton>
            <ControlActionButton websiteId={site.id} action="open-browser">
              Open browser
            </ControlActionButton>
          </div>
          {live ? <p className="text-muted mt-3 text-xs">In progress: {live.kind} ({live.status.toLowerCase()})</p> : null}
          <div className="mt-5">
            <KeyValue
              items={[
                { label: 'State', value: state },
                { label: 'Last check', value: `${formatDateTime(profile?.lastCheckedAt)} (${formatRelative(profile?.lastCheckedAt)})` },
                { label: 'Last login seen', value: formatDateTime(profile?.lastLoginAt) },
                { label: 'Detail', value: String(diag.detail ?? '—') },
                { label: 'Admin language', value: String(diag.adminLanguage ?? '—') },
                { label: 'Editor', value: `${site.editorType === 'AUTO' ? 'auto' : site.editorType.toLowerCase()} · detected ${site.detectedEditor?.toLowerCase() ?? '—'}` },
                { label: 'REST API (drafts)', value: diag.rest === true ? 'reachable with the logged-in session' : diag.rest === false ? <span className="text-amber-600">not reachable — {String(diag.restError ?? '')}</span> : 'not tested yet (Test session)' },
                { label: 'Rank Math', value: diag.rest === true ? (diag.rankMath ? 'detected' : 'not detected') : '—' },
                { label: 'Admin URL', value: site.adminUrl },
              ]}
            />
          </div>
          {jobs.length ? (
            <div className="mt-5">
              <div className="text-muted mb-1 text-xs font-semibold uppercase">Recent session actions</div>
              <ul className="space-y-1 text-xs">
                {jobs.map((j) => (
                  <li key={j.id} className="flex flex-wrap gap-2">
                    <span className="text-muted">{formatDateTime(j.createdAt)}</span>
                    <code>{j.kind}</code>
                    <Chip tone={j.status === 'COMPLETED' ? 'success' : j.status === 'FAILED' ? 'danger' : 'info'}>{j.status.toLowerCase()}</Chip>
                    {j.error ? <span className="text-rose-700">{j.error}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>

        <Card title={`Categories (${site.categories.length})`} padded={false} description="Real WordPress categories with their IDs.">
          {site.categories.length === 0 ? (
            <EmptyState title="Not synced yet" description="Log in, then Sync categories." />
          ) : (
            <div className="max-h-96 overflow-auto">
              <table className="table-app">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>ID</th>
                    <th>Posts</th>
                  </tr>
                </thead>
                <tbody>
                  {site.categories.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.name} {site.defaultCategoryId === c.id ? <Chip tone="brand">default</Chip> : null}
                      </td>
                      <td className="text-muted tabular-nums">{c.externalId}</td>
                      <td className="text-muted tabular-nums">{c.postCount ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <Card title="Settings" className="mt-6" description="Language, timezone, internal-link line, editor and per-site overrides.">
        <WebsiteForm initial={initial} categories={site.categories.map((c) => ({ id: c.id, name: c.name }))} />
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Publishing permission (canPublish)" description="Site-specific. Off by default.">
          <p className="text-muted mb-3 text-sm">
            The publish guard blocks every request that would publish, schedule, make private/pending or delete a post — from the editor UI, the REST API, Quick Edit, XML-RPC and every retry.
            {site.canPublish ? ' With permission on, only the approved scheduler may change a post’s status (and you, by hand, in the “Open browser” window).' : ' Drafts only.'}
            {blockedAttempts ? ` Blocked attempts so far: ${blockedAttempts}.` : ''}
          </p>
          <PublishingPermission websiteId={site.id} canPublish={site.canPublish} allowLiveUpdates={site.allowLiveUpdates} />
          {audits.length ? (
            <div className="mt-4">
              <div className="text-muted mb-1 text-xs font-semibold uppercase">Audit history</div>
              <ul className="space-y-1 text-xs">
                {audits.map((a) => (
                  <li key={a.id}>
                    <span className="text-muted">{formatDateTime(a.createdAt)}</span> <code>{a.action}</code>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
        <Card title="Danger zone">
          <DangerZone websiteId={site.id} slug={site.slug} taskCount={site._count.tasks} />
        </Card>
      </div>
    </>
  );
}
