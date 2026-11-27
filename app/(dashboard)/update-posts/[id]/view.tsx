'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Check, CircleAlert, ExternalLink, FileClock, Loader2, RotateCcw, X } from 'lucide-react';
import { api } from '@/lib/client/api';
import { sanitizeForDisplay } from '@/lib/html/sanitize-client';
import { Button, ConfirmDialog, RelativeTime, useToast } from '@/components/client';
import { BackLink } from '@/components/nav-trail';
import { Alert, Card, Chip, EmptyState, KeyValue, PageHeader, formatDateTime } from '@/components/ui';
import { UPDATE_STATUS } from '../posts';

interface Check {
  id: string;
  label: string;
  passed: boolean;
  blocking: boolean;
  detail: string;
}
interface Detail {
  id: string;
  status: string;
  message: string | null;
  wpPostId: number;
  post: { id: string; title: string; url: string; status: string; taskId: string | null; publishedAt: string | null; modifiedAt: string | null; live: boolean; editUrl: string };
  website: { id: string; name: string; allowLiveUpdates: boolean };
  baseTitle: string | null;
  proposedTitle: string | null;
  baseMeta: string | null;
  proposedMeta: string | null;
  baseHtml: string | null;
  proposedHtml: string | null;
  comparison: { onlyInWordPress: string[]; onlyInApp: string[]; unchanged: number } | null;
  changes: { text: string }[];
  sources: { url: string; note: string }[];
  checks: Check[];
  result: { indexing?: string; verified?: boolean; keptParts?: number; editableWords?: number; totalWords?: number };
  createdAt: string;
  approvedAt: string | null;
  appliedAt: string | null;
  undoneAt: string | null;
  history: { id: string; status: string; createdAt: string; appliedAt: string | null }[];
  liveAckPhrase: string;
}

const WORKING = ['QUEUED', 'WRITING', 'APPROVED', 'APPLYING'];
const STEPS = [
  { key: 'read', label: 'Read from WordPress', done: (s: string) => s !== 'QUEUED' },
  { key: 'chatgpt', label: 'ChatGPT updates it', done: (s: string) => !['QUEUED', 'WRITING'].includes(s) },
  { key: 'checks', label: 'The app checks it', done: (s: string) => !['QUEUED', 'WRITING'].includes(s) },
  { key: 'you', label: 'You approve', done: (s: string) => ['APPROVED', 'APPLYING', 'APPLIED', 'UNDONE'].includes(s) },
  { key: 'wp', label: 'Written to WordPress', done: (s: string) => ['APPLIED', 'UNDONE'].includes(s) },
];

export function PostUpdateView({ id }: { id: string }) {
  const toast = useToast();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'approve' | 'reject' | 'undo' | null>(null);
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState(false);

  const load = useCallback(async () => {
    try {
      setD(await api<Detail>(`/api/post-updates/${id}`));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  const working = d ? WORKING.includes(d.status) : false;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void load(), 4000);
    return () => {
      clearInterval(t);
    };
  }, [working, load]);

  async function act(kind: 'approve' | 'reject' | 'undo' | 'again') {
    if (!d) return;
    setBusy(true);
    try {
      if (kind === 'again') {
        const r = await api<{ started: string[]; already: string[] }>('/api/site-posts/update', { body: { sitePostIds: [d.post.id] } });
        const next = r.started[0] ?? r.already[0];
        toast('success', 'A new update started.');
        if (next) window.location.assign(`/update-posts/${next}`);
        return;
      }
      await api(`/api/post-updates/${id}/${kind}`, { body: kind === 'approve' ? { acknowledgement: d.post.live ? d.liveAckPhrase : undefined } : {} });
      toast('success', kind === 'approve' ? 'Approved — the worker writes it to WordPress now.' : kind === 'reject' ? 'Rejected — nothing changed in WordPress.' : 'Undo requested — the worker restores the post as it was.');
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
      setDialog(null);
    }
  }

  if (error) return <Alert tone="danger" title="This update could not be opened">{error}</Alert>;
  if (!d) return <EmptyState title="Loading…" />;
  const st = UPDATE_STATUS[d.status] ?? { label: d.status.toLowerCase(), tone: 'neutral' as const };
  const canApprove = d.status === 'READY' || (d.status === 'APPROVED' && Boolean(d.message?.startsWith('Not written yet')));
  const canAgain = ['FAILED', 'NO_CHANGE', 'REJECTED', 'CONFLICT', 'BLOCKED', 'UNDONE', 'APPLIED'].includes(d.status);
  const titleChanged = d.proposedTitle && d.baseTitle && d.proposedTitle !== d.baseTitle;
  const metaChanged = d.proposedMeta && d.proposedMeta !== d.baseMeta;

  return (
    <>
      <div className="mb-1 text-xs font-medium tracking-wide uppercase">
        <BackLink fallbackHref={`/update-posts?website=${d.website.id}`} fallbackLabel="Update to Latest" className="text-muted hover:underline" />
      </div>
      <PageHeader
        title={d.proposedTitle ?? d.baseTitle ?? d.post.title}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Chip tone={st.tone}>{st.label}</Chip>
            <span>{d.website.name}</span>
            <span>·</span>
            <a className="link inline-flex items-center gap-1" href={d.post.url} target="_blank" rel="noreferrer">
              View post <ExternalLink className="h-3 w-3" />
            </a>
            <span>·</span>
            <a className="link" href={d.post.editUrl} target="_blank" rel="noreferrer">
              Open in WordPress
            </a>
            {d.post.taskId ? (
              <>
                <span>·</span>
                <Link className="link" href={`/articles/${d.post.taskId}`}>
                  the app's article
                </Link>
              </>
            ) : null}
          </span>
        }
        actions={
          <div className="flex flex-wrap gap-2">
            {canApprove ? (
              <Button onClick={() => setDialog('approve')} disabled={busy || (d.post.live && !d.website.allowLiveUpdates)} title={d.post.live && !d.website.allowLiveUpdates ? 'Turn on “Allow approved updates to live posts” on the website page first' : undefined}>
                <Check className="h-4 w-4" /> {d.status === 'APPROVED' ? 'Write it again' : 'Approve and update'}
              </Button>
            ) : null}
            {['READY', 'NO_CHANGE', 'FAILED', 'CONFLICT', 'BLOCKED'].includes(d.status) ? (
              <Button variant="ghost" onClick={() => setDialog('reject')} disabled={busy}>
                <X className="h-4 w-4" /> Reject
              </Button>
            ) : null}
            {d.status === 'APPLIED' ? (
              <Button variant="ghost" onClick={() => setDialog('undo')} disabled={busy}>
                <RotateCcw className="h-4 w-4" /> Undo
              </Button>
            ) : null}
            {canAgain ? (
              <Button variant={d.status === 'APPLIED' ? 'ghost' : 'secondary'} onClick={() => void act('again')} disabled={busy}>
                <FileClock className="h-4 w-4" /> {d.status === 'APPLIED' ? 'Update again' : 'Try again'}
              </Button>
            ) : null}
          </div>
        }
      />

      <ol className="mb-5 flex flex-wrap gap-2 text-sm" aria-label="Steps">
        {STEPS.map((s, i) => {
          const done = s.done(d.status);
          const stopped = !done && ['FAILED', 'REJECTED', 'CONFLICT', 'BLOCKED', 'NO_CHANGE'].includes(d.status) && (i === STEPS.findIndex((x) => !x.done(d.status)));
          const current = !done && !stopped && i === STEPS.findIndex((x) => !x.done(d.status));
          return (
            <li key={s.key} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 ${done ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' : stopped ? 'border-amber-500/40 text-amber-700 dark:text-amber-300' : current ? 'border-[var(--text)]' : 'text-muted'}`}>
              {done ? <Check className="h-3.5 w-3.5" /> : current && working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : stopped ? <CircleAlert className="h-3.5 w-3.5" /> : <span className="h-3.5 w-3.5 text-center text-xs">{i + 1}</span>}
              {s.label}
            </li>
          );
        })}
      </ol>

      {d.message ? (
        <Alert tone={d.status === 'FAILED' || d.status === 'CONFLICT' || d.status === 'BLOCKED' ? 'warning' : d.status === 'APPLIED' || d.status === 'NO_CHANGE' ? 'success' : 'info'}>{d.message}</Alert>
      ) : null}
      {d.status === 'READY' && d.post.live && !d.website.allowLiveUpdates ? (
        <div className="mt-3">
          <Alert tone="warning" title="This post is live">
            To write it, turn on <strong>Allow approved updates to live posts</strong> on <Link className="underline" href={`/websites/${d.website.id}`}>the website's page</Link> (Publishing permission) first.
          </Alert>
        </div>
      ) : null}

      {d.proposedHtml ? (
        <div className="mt-5 grid gap-6 xl:grid-cols-3">
          <div className="space-y-6 xl:col-span-2">
            <Card
              title="What changed"
              description="The text that is new or different (right) and the text it replaces (left). Text that stays the same is not shown."
              actions={
                <Button size="sm" variant="ghost" onClick={() => setFull((f) => !f)}>
                  {full ? 'Show only the changes' : 'Show the whole text'}
                </Button>
              }
            >
              {full ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <h4 className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">Now in WordPress</h4>
                    <div className="article-preview max-h-[640px] overflow-auto rounded-lg border p-3" dangerouslySetInnerHTML={{ __html: sanitizeForDisplay(d.baseHtml ?? '') }} />
                  </div>
                  <div>
                    <h4 className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">Updated</h4>
                    <div className="article-preview max-h-[640px] overflow-auto rounded-lg border p-3" dangerouslySetInnerHTML={{ __html: sanitizeForDisplay(d.proposedHtml) }} />
                  </div>
                </div>
              ) : d.comparison && (d.comparison.onlyInApp.length || d.comparison.onlyInWordPress.length) ? (
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <h4 className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">Replaced or removed ({d.comparison.onlyInWordPress.length})</h4>
                    <ul className="space-y-2 text-sm">
                      {d.comparison.onlyInWordPress.map((t, i) => (
                        <li key={i} className="rounded-md border border-rose-500/25 bg-rose-500/5 px-3 py-2">
                          {t}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <h4 className="text-muted mb-2 text-xs font-semibold tracking-wide uppercase">New or changed ({d.comparison.onlyInApp.length})</h4>
                    <ul className="space-y-2 text-sm">
                      {d.comparison.onlyInApp.map((t, i) => (
                        <li key={i} className="rounded-md border border-emerald-500/25 bg-emerald-500/5 px-3 py-2">
                          {t}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : (
                <p className="text-muted text-sm">The text is the same as in WordPress.</p>
              )}
              {d.comparison ? <p className="text-muted mt-3 text-xs">{d.comparison.unchanged} paragraph(s) and rows stay as they are. Images, embeds and other parts of the page are not shown here and stay exactly as they are.</p> : null}
            </Card>

            <Card title="Title and meta description">
              <KeyValue
                items={[
                  { label: 'Title', value: titleChanged ? <span><s className="text-muted">{d.baseTitle}</s> → <strong>{d.proposedTitle}</strong></span> : <span>{d.baseTitle} <span className="text-muted">(unchanged)</span></span> },
                  {
                    label: 'Meta description',
                    value: metaChanged ? (
                      <span>
                        {d.baseMeta ? <s className="text-muted block">{d.baseMeta}</s> : null}
                        <strong>{d.proposedMeta}</strong>
                        <span className="text-muted block text-xs">Written to Rank Math's description when Rank Math is active on the website.</span>
                      </span>
                    ) : (
                      <span className="text-muted">unchanged</span>
                    ),
                  },
                  { label: 'Address (URL)', value: <span className="break-all">{d.post.url} <span className="text-muted">(never changed)</span></span> },
                ]}
              />
            </Card>
          </div>

          <div className="space-y-6">
            <Card title="ChatGPT's changes">
              {d.changes.length ? (
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {d.changes.map((c, i) => (
                    <li key={i}>{c.text}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted text-sm">ChatGPT listed none.</p>
              )}
              <h4 className="mt-4 mb-1 text-sm font-semibold">Sources</h4>
              {d.sources.length ? (
                <ul className="space-y-1.5 text-sm">
                  {d.sources.map((s, i) => (
                    <li key={i}>
                      <a className="link break-all" href={s.url} target="_blank" rel="noreferrer">
                        {s.url.replace(/^https?:\/\//, '')}
                      </a>
                      {s.note ? <span className="text-muted"> — {s.note}</span> : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted text-sm">None listed — check the new facts before approving.</p>
              )}
            </Card>

            <Card title="The app's checks" description="A failed check marked “stops” keeps the update from being written.">
              <ul className="space-y-2 text-sm">
                {d.checks.map((c) => (
                  <li key={c.id} className="flex gap-2">
                    {c.passed ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <CircleAlert className={`mt-0.5 h-4 w-4 shrink-0 ${c.blocking ? 'text-rose-600' : 'text-amber-600'}`} />}
                    <div>
                      <div className="font-medium">
                        {c.label} {!c.passed && c.blocking ? <Chip tone="danger">stops</Chip> : null}
                      </div>
                      <div className="text-muted text-xs">{c.detail}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>

            <Card title="Details">
              <KeyValue
                items={[
                  { label: 'Started', value: formatDateTime(d.createdAt) },
                  ...(d.appliedAt ? [{ label: 'Written to WordPress', value: formatDateTime(d.appliedAt) }] : []),
                  ...(d.undoneAt ? [{ label: 'Undone', value: formatDateTime(d.undoneAt) }] : []),
                  ...(d.result.indexing ? [{ label: 'Google', value: d.result.indexing }] : []),
                  ...(d.result.editableWords != null ? [{ label: 'Text ChatGPT could update', value: `${d.result.editableWords} of ${d.result.totalWords} words${d.result.keptParts ? ` · ${d.result.keptParts} part(s) kept as they are` : ''}` }] : []),
                  { label: 'Post last changed', value: <RelativeTime value={d.post.modifiedAt} /> },
                ]}
              />
              {d.history.length > 1 ? (
                <>
                  <h4 className="mt-4 mb-1 text-sm font-semibold">Updates of this post</h4>
                  <ul className="space-y-1 text-sm">
                    {d.history.map((h) => (
                      <li key={h.id}>
                        {h.id === d.id ? <strong>this one</strong> : <Link className="underline" href={`/update-posts/${h.id}`}>{formatDateTime(h.createdAt)}</Link>} · {UPDATE_STATUS[h.status]?.label ?? h.status.toLowerCase()}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </Card>
          </div>
        </div>
      ) : working ? (
        <div className="mt-5">
          <EmptyState title={d.status === 'QUEUED' ? 'Reading the post from WordPress…' : 'ChatGPT is checking the post against current sources…'} description="This page follows by itself. ChatGPT works in its own tab; a long post can take a few minutes." icon={<Loader2 className="h-6 w-6 animate-spin" />} />
        </div>
      ) : null}

      <ConfirmDialog
        open={dialog === 'approve'}
        title={d.post.live ? 'Update this live post?' : 'Update this post?'}
        confirmLabel="Approve and update"
        busy={busy}
        requireText={d.post.live ? d.liveAckPhrase : undefined}
        onCancel={() => setDialog(null)}
        onConfirm={() => void act('approve')}
      >
        The worker writes the updated text{titleChanged ? ', the new title' : ''}{metaChanged ? ' and the meta description' : ''} to the same post. Its address, status, date, images and everything the app kept stay as they are. If the post was edited in WordPress since, nothing is written. You can undo it afterwards.
      </ConfirmDialog>
      <ConfirmDialog open={dialog === 'reject'} title="Reject this update?" confirmLabel="Reject" busy={busy} onCancel={() => setDialog(null)} onConfirm={() => void act('reject')}>
        Nothing changes in WordPress. You can start a new update any time.
      </ConfirmDialog>
      <ConfirmDialog open={dialog === 'undo'} title="Undo this update?" confirmLabel="Undo" tone="danger" busy={busy} onCancel={() => setDialog(null)} onConfirm={() => void act('undo')}>
        The post gets its text and title from before the update again. If it was edited in WordPress after the update, nothing is changed.
      </ConfirmDialog>
    </>
  );
}
