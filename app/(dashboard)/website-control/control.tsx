'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { BookOpen, CalendarClock, Copy, ExternalLink, FileText, FolderTree, HeartPulse, ImageIcon, Link2, Pause, Play, Save, Search, ShieldCheck, Sparkles, TriangleAlert } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, Modal, useToast } from '@/components/client';
import { Input, Select } from '@/components/form';
import { Chip, EmptyState, PageHeader, Stat, cx } from '@/components/ui';
import type { websiteGrid } from '@/lib/website-control';

type Row = Awaited<ReturnType<typeof websiteGrid>>[number];

const HEALTH_TONE = { OK: 'success', WARN: 'warning', FAIL: 'danger', UNKNOWN: 'neutral' } as const;
const HEALTH_TEXT = { OK: 'healthy', WARN: 'needs attention', FAIL: 'failing', UNKNOWN: 'no data' } as const;
const SESSION_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = { ACTIVE: 'success', LOGIN_REQUIRED: 'danger', EXPIRED: 'danger', UNKNOWN: 'neutral' };

/** One fact about the site: an icon, a label and its value (cut to one line, whole on hover). */
function Fact({ icon, label, children, title }: { icon: ReactNode; label: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span className="text-muted mt-0.5 shrink-0" aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-muted text-[11px] font-medium uppercase tracking-wide">{label}</div>
        <div className="truncate text-sm" title={title}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** The site's articles by state; the ones that need you stand out. */
function Counts({ w }: { w: Row }) {
  const items: { label: string; value: number; tone?: 'warning' | 'danger' | 'success'; href?: string }[] = [
    { label: 'Queued', value: w.counts.queued },
    { label: 'Running', value: w.counts.running },
    { label: 'Review', value: w.counts.review, tone: 'warning', href: '/queue?group=review' },
    { label: 'Paused', value: w.counts.paused },
    { label: 'Failed', value: w.counts.failed, tone: 'danger', href: '/queue?group=failed' },
    { label: 'Verified (7 d)', value: w.verified7d, tone: 'success' },
  ];
  return (
    <div className="border-app grid grid-cols-3 divide-x divide-y divide-[var(--border)] overflow-hidden rounded-lg border sm:grid-cols-6 sm:divide-y-0">
      {items.map((i) => {
        const inner = (
          <div className="h-full px-3 py-2">
            <div className={cx('text-lg font-semibold tabular-nums', i.value > 0 && i.tone === 'warning' && 'text-amber-600', i.value > 0 && i.tone === 'danger' && 'text-rose-600', i.value > 0 && i.tone === 'success' && 'text-emerald-600', i.value === 0 && 'text-muted')}>{i.value}</div>
            <div className="text-muted truncate text-[11px]">{i.label}</div>
          </div>
        );
        return i.href && i.value > 0 ? (
          <Link key={i.label} href={i.href} className="hover:opacity-80">
            {inner}
          </Link>
        ) : (
          <div key={i.label}>{inner}</div>
        );
      })}
    </div>
  );
}

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
    <div className="border-app flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-5 py-3">
      <Button size="sm" variant={row.paused ? 'primary' : 'secondary'} loading={busy === 'pause'} onClick={() => void save('pause', { paused: !row.paused }, row.paused ? `${row.name} resumed.` : `${row.name} paused: no new articles start.`)}>
        {row.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />} {row.paused ? 'Resume' : 'Pause'}
      </Button>
      <label className="flex items-center gap-2 text-xs" title="Higher goes first when several websites have articles waiting (−10 to 10).">
        <span className="text-muted">Priority</span>
        <Input className="h-8 w-20!" type="number" min={-10} max={10} aria-label={`Priority of ${row.name}`} value={priority} onChange={(e) => setPriority(e.target.value)} />
      </label>
      <label className="flex items-center gap-2 whitespace-nowrap text-xs" title="How many of its articles may be in progress at once (0 = no limit).">
        <span className="text-muted">Max in progress</span>
        <Input className="h-8 w-20!" type="number" min={0} max={20} aria-label={`Articles in progress at once for ${row.name} (0 = no limit)`} value={quota} onChange={(e) => setQuota(e.target.value)} />
      </label>
      <Button size="sm" variant={dirty ? 'primary' : 'ghost'} disabled={!dirty} loading={busy === 'limits'} onClick={() => void save('limits', { priority: Number(priority), queueQuota: Number(quota) }, 'Saved.')}>
        <Save className="h-3.5 w-3.5" /> Save
      </Button>
      <Link className="text-muted ml-auto text-xs font-medium hover:text-[var(--text)] hover:underline" href={`/websites/${row.id}?tab=settings`}>
        All settings →
      </Link>
    </div>
  );
}

function SiteCard({ w }: { w: Row }) {
  const host = w.publicUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const session = w.session.replace(/_/g, ' ').toLowerCase();
  return (
    <section className={cx('surface flex min-w-0 flex-col rounded-xl border', w.paused && 'opacity-80')} aria-label={w.name}>
      <header className="flex flex-wrap items-start gap-3 px-5 pt-4">
        <div className="surface-2 grid h-10 w-10 shrink-0 place-items-center rounded-lg text-sm font-semibold uppercase" aria-hidden>
          {w.name.slice(0, 2)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link className="text-base font-semibold hover:underline" href={`/websites/${w.id}`}>
              {w.name}
            </Link>
            <Chip tone={HEALTH_TONE[w.health.overall]}>{HEALTH_TEXT[w.health.overall]}</Chip>
            {w.paused ? <Chip tone="warning">paused</Chip> : null}
            {!w.active ? <Chip>inactive</Chip> : null}
          </div>
          <a className="text-muted inline-flex items-center gap-1 text-xs hover:underline" href={w.publicUrl} target="_blank" rel="noreferrer">
            {host} <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
          <span className="text-muted text-xs"> · {w.language === 'de' ? 'German' : 'English'} · {w.timezone}</span>
        </div>
        {w.canPublish ? <Chip tone="danger">may publish{w.allowLiveUpdates ? ' + live updates' : ''}</Chip> : <Chip tone="success">drafts only</Chip>}
      </header>
      {w.health.reason && w.health.overall !== 'OK' ? (
        <p className={cx('mx-5 mt-3 flex items-start gap-2 rounded-md px-3 py-2 text-xs', w.health.overall === 'FAIL' ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300' : 'bg-amber-500/10 text-amber-800 dark:text-amber-300')}>
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {w.health.reason}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-x-5 gap-y-3 px-5 py-4 sm:grid-cols-2 2xl:grid-cols-3">
        <Fact icon={<ShieldCheck className="h-4 w-4" />} label="WordPress session">
          <span className={cx(SESSION_TONE[w.session] === 'danger' && 'text-rose-600', SESSION_TONE[w.session] === 'success' && 'text-emerald-600')}>{session}</span>
        </Fact>
        <Fact icon={<FolderTree className="h-4 w-4" />} label="Categories" title={w.defaultCategory ? `default “${w.defaultCategory}”` : 'no default category'}>
          {w.categories} · {w.defaultCategory ? `default “${w.defaultCategory}”` : <span className="text-amber-700">no default</span>}
        </Fact>
        <Fact icon={<FileText className="h-4 w-4" />} label="Editor">
          {w.editor}
        </Fact>
        <Fact icon={<Link2 className="h-4 w-4" />} label="Internal links" title={`“${w.internalLinkLine}” · ${w.linkIndex} indexed post(s)`}>
          {w.linkIndex} posts · “{w.internalLinkLine}”
        </Fact>
        <Fact icon={<ImageIcon className="h-4 w-4" />} label="Image template" title={`${w.imageTemplate.name}${w.imageTemplate.bodyTemplate ? ' + body design' : ''}${w.imageTemplate.logo ? '' : ' · no logo'}`}>
          {w.imageTemplate.name}
          {w.imageTemplate.bodyTemplate ? ' + body' : ''}
          {w.imageTemplate.logo ? '' : ' · no logo'}
        </Fact>
        <Fact icon={<CalendarClock className="h-4 w-4" />} label="Workflow">
          {w.workflow ? (
            <>
              <span className={cx(w.workflow.active && 'text-emerald-600')}>{w.workflow.active ? 'on' : 'off'}</span> · {w.workflow.slots} slot(s) a day
            </>
          ) : (
            <span className="text-muted">none</span>
          )}
        </Fact>
        <Fact icon={<Search className="h-4 w-4" />} label="Search Console" title={w.searchConsoleProperty ?? 'not set'}>
          {w.searchConsoleProperty ?? <span className="text-muted">not set</span>}
        </Fact>
        <Fact icon={<Sparkles className="h-4 w-4" />} label="Rank Math">
          {w.rankMath.mode}
          {w.rankMath.target ? ` · target ${w.rankMath.target}` : ''}
        </Fact>
        <Fact icon={<BookOpen className="h-4 w-4" />} label="Prompts / writer rules">
          {w.promptOverrides} override(s) · {w.routingRules} rule(s)
        </Fact>
      </div>
      <div className="mt-auto px-5 pb-4">
        <Counts w={w} />
      </div>
      <Controls row={w} />
    </section>
  );
}

function CloneDialog({ open, onClose, websites, cloneFields }: { open: boolean; onClose: () => void; websites: Row[]; cloneFields: Record<string, string> }) {
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
  const flip = (set: Set<string>, k: string, on: boolean) => {
    const n = new Set(set);
    if (on) n.add(k);
    else n.delete(k);
    return n;
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={720}
      title="Copy safe settings"
      description="Never copied: URLs, the WordPress profile and session, categories, publishing permission, the Search Console property, pause/priority — and text in another language. The image design is copied without the source's logo and fixed photos."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button variant="primary" loading={busy} disabled={!source || !targets.size || !fields.size} onClick={() => void run()}>
            <Copy className="h-4 w-4" /> Copy to {targets.size} website(s)
          </Button>
        </>
      }
    >
      <div className="space-y-5 text-sm">
        <label className="flex items-center gap-3">
          <span className="text-muted w-14">From</span>
          <Select aria-label="Copy from website" className="w-64!" value={source} onChange={(e) => { setSource(e.target.value); setTargets(new Set()); setResult(null); }}>
            {websites.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name} ({w.language})
              </option>
            ))}
          </Select>
        </label>
        <fieldset>
          <legend className="text-muted mb-2 text-xs font-medium uppercase tracking-wide">What to copy</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(cloneFields).map(([k, label]) => (
              <label key={k} className="border-app flex items-center gap-2 rounded-md border px-3 py-2">
                <input type="checkbox" checked={fields.has(k)} onChange={(e) => setFields(flip(fields, k, e.target.checked))} /> {label}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-muted mb-2 text-xs font-medium uppercase tracking-wide">To</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {websites.filter((w) => w.id !== source).map((w) => (
              <label key={w.id} className="border-app flex items-center gap-2 rounded-md border px-3 py-2">
                <input type="checkbox" checked={targets.has(w.id)} onChange={(e) => setTargets(flip(targets, w.id, e.target.checked))} /> {w.name} <span className="text-muted">({w.language})</span>
              </label>
            ))}
          </div>
        </fieldset>
        {result ? (
          <ul className="surface-2 list-disc space-y-1 rounded-md py-2 pl-8 pr-3" aria-label="Copy results">
            {result.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </Modal>
  );
}

export function WebsiteControl({ websites, cloneFields, description }: { websites: Row[]; cloneFields: Record<string, string>; description: string }) {
  const toast = useToast();
  const [checking, setChecking] = useState(false);
  const [cloning, setCloning] = useState(false);
  const attention = websites.filter((w) => w.health.overall === 'WARN' || w.health.overall === 'FAIL').length;
  const inProgress = websites.reduce((n, w) => n + w.counts.queued + w.counts.running, 0);
  const review = websites.reduce((n, w) => n + w.counts.review, 0);
  return (
    <>
      <PageHeader
        title="Website Control"
        description={description}
        actions={
          websites.length ? (
            <>
              {websites.length > 1 ? (
                <Button onClick={() => setCloning(true)}>
                  <Copy className="h-4 w-4" /> Copy settings
                </Button>
              ) : null}
              <Button
                variant="primary"
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
            </>
          ) : null
        }
      />
      {!websites.length ? (
        <EmptyState title="No websites yet" description="Add a website first." action={<Link className="underline" href="/websites">Websites</Link>} />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label="Websites" value={websites.length} hint={`${websites.filter((w) => w.paused).length} paused`} />
            <Stat label="Need attention" value={attention} tone={attention ? 'warning' : 'success'} hint={attention ? 'see the cards below' : 'all healthy'} />
            <Stat label="May publish" value={websites.filter((w) => w.canPublish).length} hint="the others make drafts only" />
            <Stat label="Queued or running" value={inProgress} hint="open the Article Queue" href="/queue" />
            <Stat label="Waiting for review" value={review} tone={review ? 'warning' : undefined} hint={review ? 'open them' : 'nothing waits for you'} href="/queue?group=review" />
          </div>
          <div className="grid gap-5 xl:grid-cols-2">
            {websites.map((w) => (
              <SiteCard key={w.id} w={w} />
            ))}
          </div>
          {websites.length > 1 ? <CloneDialog open={cloning} onClose={() => setCloning(false)} websites={websites} cloneFields={cloneFields} /> : null}
        </div>
      )}
    </>
  );
}
