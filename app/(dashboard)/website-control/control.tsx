'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Copy, HeartPulse, Pause, Play } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, useToast } from '@/components/client';
import { Input, Select } from '@/components/form';
import { Card, Chip, EmptyState } from '@/components/ui';
import type { websiteGrid } from '@/lib/website-control';

type Row = Awaited<ReturnType<typeof websiteGrid>>[number];

const HEALTH_TONE = { OK: 'success', WARN: 'warning', FAIL: 'danger', UNKNOWN: 'neutral' } as const;
const HEALTH_TEXT = { OK: 'healthy', WARN: 'needs attention', FAIL: 'failing', UNKNOWN: 'no data' } as const;

function Controls({ row }: { row: Row }) {
  const router = useRouter();
  const toast = useToast();
  const [priority, setPriority] = useState(String(row.priority));
  const [quota, setQuota] = useState(String(row.queueQuota));
  const [busy, setBusy] = useState<string | null>(null);
  async function save(kind: string, body: Record<string, unknown>, ok: string) {
    setBusy(kind);
    try {
      await api(`/api/website-control/${row.id}`, { method: 'PATCH', body });
      toast('success', ok);
      router.refresh();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const dirty = priority !== String(row.priority) || quota !== String(row.queueQuota);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Button size="sm" variant={row.paused ? 'primary' : 'ghost'} loading={busy === 'pause'} onClick={() => void save('pause', { paused: !row.paused }, row.paused ? `${row.name} resumed.` : `${row.name} paused: no new articles start.`)}>
        {row.paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />} {row.paused ? 'Resume' : 'Pause'}
      </Button>
      <label className="flex flex-col text-xs">
        <span className="text-muted">Priority</span>
        <Input className="w-16" type="number" min={-10} max={10} aria-label={`Priority of ${row.name}`} value={priority} onChange={(e) => setPriority(e.target.value)} />
      </label>
      <label className="flex flex-col text-xs">
        <span className="text-muted">Max in progress</span>
        <Input className="w-16" type="number" min={0} max={20} aria-label={`Articles in progress at once for ${row.name} (0 = no limit)`} value={quota} onChange={(e) => setQuota(e.target.value)} />
      </label>
      <Button size="sm" disabled={!dirty} loading={busy === 'limits'} onClick={() => void save('limits', { priority: Number(priority), queueQuota: Number(quota) }, 'Saved.')}>
        Save
      </Button>
    </div>
  );
}

function CloneCard({ websites, cloneFields }: { websites: Row[]; cloneFields: Record<string, string> }) {
  const router = useRouter();
  const toast = useToast();
  const [source, setSource] = useState(websites[0]?.id ?? '');
  const [targets, setTargets] = useState<Set<string>>(new Set());
  const [fields, setFields] = useState<Set<string>>(new Set(['settingsOverrides']));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string[] | null>(null);
  async function run() {
    setBusy(true);
    try {
      const res = await api<{ results: { name: string; copied: string[]; skipped: { field: string; reason: string }[] }[] }>('/api/website-control/clone', { method: 'POST', body: { sourceId: source, targetIds: [...targets], fields: [...fields] } });
      setResult(res.results.map((r) => `${r.name}: ${r.copied.length ? `copied ${r.copied.map((f) => cloneFields[f]).join(', ')}` : 'nothing copied'}${r.skipped.length ? `; skipped ${r.skipped.map((s) => `${cloneFields[s.field]} (${s.reason})`).join(', ')}` : ''}`));
      toast('success', 'Settings copied.');
      router.refresh();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Copy safe settings" description="Never copied: URLs, the WordPress profile and session, categories, publishing permission, the Search Console property, pause/priority — and text in another language. The image design is copied without the source's logo and fixed photos.">
      <div className="space-y-3 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted">From</span>
          <Select aria-label="Copy from website" className="w-56" value={source} onChange={(e) => { setSource(e.target.value); setTargets(new Set()); }}>
            {websites.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.language})
              </option>
            ))}
          </Select>
        </label>
        <fieldset>
          <legend className="text-muted text-xs">Settings</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {Object.entries(cloneFields).map(([k, label]) => (
              <label key={k} className="flex items-center gap-1">
                <input type="checkbox" checked={fields.has(k)} onChange={(e) => { const n = new Set(fields); if (e.target.checked) n.add(k); else n.delete(k); setFields(n); }} /> {label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-muted text-xs">To</legend>
          <div className="mt-1 flex flex-wrap gap-3">
            {websites.filter((w) => w.id !== source).map((w) => (
              <label key={w.id} className="flex items-center gap-1">
                <input type="checkbox" checked={targets.has(w.id)} onChange={(e) => { const n = new Set(targets); if (e.target.checked) n.add(w.id); else n.delete(w.id); setTargets(n); }} /> {w.name} ({w.language})
              </label>
            ))}
          </div>
        </fieldset>
        <Button size="sm" variant="primary" loading={busy} disabled={!source || !targets.size || !fields.size} onClick={() => void run()}>
          <Copy className="h-4 w-4" /> Copy to {targets.size} website(s)
        </Button>
        {result ? (
          <ul className="list-disc space-y-1 pl-5" aria-label="Copy results">
            {result.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </Card>
  );
}

export function WebsiteControl({ websites, cloneFields }: { websites: Row[]; cloneFields: Record<string, string> }) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  if (!websites.length) return <EmptyState title="No websites yet" description="Add a website first." action={<Link className="text-indigo-600 underline" href="/websites">Websites</Link>} />;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          loading={checking}
          onClick={async () => {
            setChecking(true);
            try {
              const r = await api<{ queued: number; sites: number }>('/api/website-control/health-check', { method: 'POST' });
              toast('success', `Session tests queued for ${r.queued} of ${r.sites} website(s). Results appear in each site's health within a minute or two.`);
            } catch (e) {
              toast('error', (e as Error).message);
            } finally {
              setChecking(false);
            }
          }}
        >
          <HeartPulse className="h-4 w-4" /> Check all sessions
        </Button>
        <span className="text-muted text-sm">
          {websites.length} website(s) · {websites.filter((w) => w.paused).length} paused · {websites.filter((w) => w.canPublish).length} may publish
        </span>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {websites.map((w) => (
          <Card
            key={w.id}
            title={
              <span className="flex flex-wrap items-center gap-2">
                <Link className="text-indigo-600 underline" href={`/websites/${w.id}`}>
                  {w.name}
                </Link>
                <Chip>{w.language === 'de' ? 'German' : 'English'}</Chip>
                <Chip tone={HEALTH_TONE[w.health.overall]}>{HEALTH_TEXT[w.health.overall]}</Chip>
                {w.paused ? <Chip tone="warning">paused</Chip> : null}
                {!w.active ? <Chip>inactive</Chip> : null}
                {w.canPublish ? <Chip tone="danger">may publish{w.allowLiveUpdates ? ' + live updates' : ''}</Chip> : <Chip tone="success">drafts only</Chip>}
              </span>
            }
            description={`${w.publicUrl} · ${w.timezone}`}
          >
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted">WordPress session</dt>
              <dd>{w.session.replace('_', ' ').toLowerCase()}</dd>
              <dt className="text-muted">Health</dt>
              <dd className="break-words">{w.health.reason ?? (w.health.overall === 'UNKNOWN' ? 'not measured yet' : 'no problems')}</dd>
              <dt className="text-muted">Categories</dt>
              <dd>
                {w.categories} {w.defaultCategory ? `· default “${w.defaultCategory}”` : '· no default'}
              </dd>
              <dt className="text-muted">Editor</dt>
              <dd>{w.editor}</dd>
              <dt className="text-muted">Internal links</dt>
              <dd>
                “{w.internalLinkLine}” · {w.linkIndex} indexed post(s)
              </dd>
              <dt className="text-muted">Image template</dt>
              <dd>
                {w.imageTemplate.name}
                {w.imageTemplate.bodyTemplate ? ' + body design' : ''}
                {w.imageTemplate.logo ? '' : ' · no logo'}
              </dd>
              <dt className="text-muted">Prompts / writer rules</dt>
              <dd>
                {w.promptOverrides} override(s) · {w.routingRules} rule(s)
              </dd>
              <dt className="text-muted">Rank Math</dt>
              <dd>
                {w.rankMath.mode}
                {w.rankMath.target ? ` · target ${w.rankMath.target}` : ''}
              </dd>
              <dt className="text-muted">Workflow</dt>
              <dd>{w.workflow ? `${w.workflow.active ? 'on' : 'off'} · ${w.workflow.slots} slot(s) a day` : 'none'}</dd>
              <dt className="text-muted">Search Console</dt>
              <dd className="break-all">{w.searchConsoleProperty ?? 'not set'}</dd>
              <dt className="text-muted">Articles</dt>
              <dd>
                {w.counts.queued} queued · {w.counts.running} running · {w.counts.review} review · {w.counts.paused} paused · {w.counts.failed} failed · {w.verified7d} verified in 7 days
              </dd>
            </dl>
            <div className="mt-3">
              <Controls row={w} />
            </div>
          </Card>
        ))}
      </div>
      {websites.length > 1 ? <CloneCard websites={websites} cloneFields={cloneFields} /> : null}
    </div>
  );
}
