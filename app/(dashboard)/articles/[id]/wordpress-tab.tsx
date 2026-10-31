'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { SerializedTaskDetail } from '@/lib/tasks/detail';
import { Button, ConfirmDialog, useToast } from '@/components/client';
import { Alert, Card, Chip, EmptyState, KeyValue, formatDateTime } from '@/components/ui';

type Mode = 'resave' | 'overwrite-remote' | 'recreate' | 'adopt';

interface Candidate {
  id: number;
  status: string;
  slug: string;
  modified: string;
  editUrl: string;
}

const MODE_TEXT: Record<Mode, { title: string; body: string; confirm: string }> = {
  resave: { title: 'Save to WordPress again?', body: 'The same draft is reopened, updated and verified again. No second post is created.', confirm: 'Save again' },
  'overwrite-remote': {
    title: 'Overwrite the WordPress draft?',
    body: 'Edits made in WordPress after the app saved this draft will be replaced by the version shown in the Editor tab. WordPress keeps a revision of the replaced text.',
    confirm: 'Overwrite draft',
  },
  recreate: { title: 'Create a new draft?', body: 'A NEW WordPress draft is created for this article. Use this only when the old draft is gone or none of the found posts is the right one.', confirm: 'Create new draft' },
  adopt: { title: 'Use this post?', body: 'The app links this article to the chosen post and updates that draft. No new post is created.', confirm: 'Use this post' },
};

export function WordPressTab({ task, onChanged }: { task: SerializedTaskDetail; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [pending, setPending] = useState<{ mode: Mode; postId?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const wpStage = task.stages.find((s) => s.key === 'WORDPRESS_DRAFT');
  const wpData = wpStage?.outputJson ? (JSON.parse(wpStage.outputJson) as { action?: string; warnings?: string[]; editor?: string }) : null;
  const rm = task.rankMathReportValue;
  const incident = task.incidents.find((i) => i.kind === 'UNCERTAIN_WP_CREATE' && i.status === 'OPEN');
  const candidates: Candidate[] = incident ? ((JSON.parse(incident.evidence) as { candidates?: Candidate[] }).candidates ?? []) : [];
  const remoteEdited = /edited in WordPress/i.test(`${task.message ?? ''} ${task.reviewReasonList.join(' ')}`);
  const gone = /no longer exists|in the trash/i.test(`${task.message ?? ''} ${task.reviewReasonList.join(' ')}`);
  const running = ['CREATING_DRAFT', 'RUNNING_RANKMATH', 'QUEUED'].includes(task.status);
  const ready = Boolean(task.assembledHtml || task.editedHtml);

  async function run() {
    if (!pending) return;
    setBusy(true);
    try {
      await api(`/api/tasks/${task.id}/wordpress`, { body: { mode: pending.mode, ...(pending.postId ? { adoptPostId: pending.postId } : {}) } });
      toast('success', pending.mode === 'adopt' ? `Using post #${pending.postId}.` : 'WordPress step queued.');
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card
        title="WordPress draft"
        actions={
          !task.legacy && ready ? (
            <Button size="sm" onClick={() => setPending({ mode: 'resave' })} disabled={running}>
              <RefreshCw className="h-4 w-4" /> Save again
            </Button>
          ) : null
        }
      >
        {task.wpPostId ? (
          <KeyValue
            items={[
              {
                label: 'Post',
                value: (
                  <a className="inline-flex items-center gap-1 link" href={task.wpEditUrl ?? '#'} target="_blank" rel="noreferrer">
                    #{task.wpPostId} <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ),
              },
              { label: 'Status in WordPress', value: <Chip tone={task.wpPostStatus === 'draft' ? 'neutral' : 'warning'}>{task.wpPostStatus ?? 'unknown'}</Chip> },
              { label: 'Slug', value: task.wpSlug ?? task.slug ?? '—' },
              { label: 'Editor', value: rm?.editor ?? wpData?.editor ?? '—' },
              { label: 'Last save', value: wpData?.action ? `${wpData.action} · ${formatDateTime(task.wpDraftAt)}` : formatDateTime(task.wpDraftAt) },
              { label: 'Final verification', value: task.wpVerifiedAt ? formatDateTime(task.wpVerifiedAt) : <span className="text-muted">not yet</span> },
              { label: 'Verified complete', value: task.verifiedCompleteAt ? formatDateTime(task.verifiedCompleteAt) : <span className="text-muted">no</span> },
            ]}
          />
        ) : (
          <EmptyState title="No WordPress draft yet" description={ready ? 'The draft is created after the quality gate and approvals.' : 'The article is not assembled yet.'} />
        )}
        {wpData?.warnings?.length ? (
          <ul className="text-muted mt-4 list-disc space-y-1 pl-5 text-sm">
            {wpData.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        ) : null}
        {!task.legacy && (remoteEdited || gone) ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {remoteEdited ? (
              <Button size="sm" variant="danger" onClick={() => setPending({ mode: 'overwrite-remote' })}>
                Overwrite WordPress draft…
              </Button>
            ) : null}
            {gone ? (
              <Button size="sm" onClick={() => setPending({ mode: 'recreate' })}>
                Create a new draft…
              </Button>
            ) : null}
          </div>
        ) : null}
        <p className="text-muted mt-4 flex items-start gap-2 text-xs">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          {task.website.canPublish
            ? 'This site allows publishing, but only the approved scheduler may change a post’s status. Every other publish attempt is blocked.'
            : 'Drafts only: publishing, scheduling, private/pending status and deletion are blocked for this site — in the editor UI, the REST API and every retry.'}
        </p>
      </Card>

      {remoteEdited ? <RemoteChanges taskId={task.id} /> : null}

      {candidates.length ? (
        <Card title="Which post is this article?">
          <Alert tone="warning">An earlier save may have created a draft, but its confirmation was lost and several matching posts exist. Nothing new was created. Choose the right one, or create a new draft.</Alert>
          <ul className="mt-3 space-y-2 text-sm">
            {candidates.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                <a className="inline-flex items-center gap-1 link" href={c.editUrl} target="_blank" rel="noreferrer">
                  #{c.id} · {c.status} · {c.slug} <ExternalLink className="h-3.5 w-3.5" />
                </a>
                <Button size="sm" onClick={() => setPending({ mode: 'adopt', postId: c.id })}>
                  Use #{c.id}
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-3">
            <Button size="sm" variant="secondary" onClick={() => setPending({ mode: 'recreate' })}>
              None of these — create a new draft…
            </Button>
          </div>
        </Card>
      ) : null}

      <Card title="Rank Math" description="Values are read back from the WordPress editor. The score is never computed or estimated by the app.">
        {!rm ? (
          <EmptyState title="Not checked yet" description="Rank Math is checked after the draft is saved." />
        ) : (
          <>
            <KeyValue
              items={[
                { label: 'Mode', value: rm.mode === 'required' ? 'Required' : rm.mode === 'if-installed' ? 'Use when installed' : 'Off' },
                { label: 'Active on site', value: rm.active ? 'yes' : 'no' },
                {
                  label: 'Score',
                  value:
                    rm.score === null ? (
                      <span className="text-muted">not verified</span>
                    ) : (
                      <Chip tone={rm.score >= rm.target ? 'success' : 'warning'}>
                        {rm.score} / 100 (target {rm.target})
                      </Chip>
                    ),
                },
                { label: 'Fields verified', value: rm.active ? (rm.fieldsVerified ? 'yes' : <span className="text-amber-600">no — {rm.fieldProblems.join('; ')}</span>) : '—' },
                { label: 'Focus keyword (read back)', value: rm.fields?.focusKeyword ?? '—' },
                { label: 'SEO title (read back)', value: rm.fields?.title ?? '—' },
                { label: 'Description (read back)', value: rm.fields?.description ?? '—' },
                { label: 'Checked', value: formatDateTime(rm.checkedAt) },
              ]}
            />
            {rm.notes.length ? (
              <ul className="text-muted mt-3 list-disc space-y-1 pl-5 text-sm">
                {rm.notes.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
              </ul>
            ) : null}
            {rm.recommendations.length ? (
              <>
                <h4 className="mt-4 mb-2 text-sm font-semibold">Recommendations shown by Rank Math</h4>
                <ul className="space-y-1 text-sm">
                  {rm.recommendations.map((r, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <Chip tone={r.state === 'ok' ? 'success' : r.state === 'fail' ? 'danger' : 'warning'}>{r.state}</Chip>
                      <span>{r.text}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        )}
      </Card>

      {rm?.rounds.length ? (
        <Card title="Correction rounds" description="At most the configured number of rounds. Content rewrites are kept only if they preserve facts, headings, links and length limits.">
          <ol className="space-y-4 text-sm">
            {rm.rounds.map((r) => (
              <li key={r.round}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Round {r.round}</span>
                  <Chip>{r.kind === 'local' ? 'metadata (local)' : 'content (ChatGPT)'}</Chip>
                  <Chip tone={r.accepted ? 'success' : 'danger'}>{r.accepted ? 'applied' : 'rejected'}</Chip>
                  <span className="text-muted">
                    score {r.scoreBefore ?? '?'}
                    {r.scoreAfter !== undefined ? ` → ${r.scoreAfter ?? '?'}` : ''}
                  </span>
                </div>
                {r.changes.length ? <ul className="mt-1 list-disc pl-5">{r.changes.map((c, i) => <li key={i}>{c}</li>)}</ul> : null}
                {r.reasons?.length ? <p className="mt-1 text-amber-700 dark:text-amber-300">Why: {r.reasons.join('; ')}</p> : null}
                {r.before && r.after ? (
                  <details className="mt-2">
                    <summary className="cursor-pointer link-plain">Before / after</summary>
                    <div className="mt-2 grid gap-3 md:grid-cols-2">
                      <pre className="surface-2 max-h-64 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">{r.before}</pre>
                      <pre className="surface-2 max-h-64 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">{r.after}</pre>
                    </div>
                  </details>
                ) : null}
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      <ConfirmDialog
        open={Boolean(pending)}
        title={pending ? MODE_TEXT[pending.mode].title : ''}
        confirmLabel={pending ? MODE_TEXT[pending.mode].confirm : ''}
        tone={pending?.mode === 'overwrite-remote' || pending?.mode === 'recreate' ? 'danger' : undefined}
        busy={busy}
        onCancel={() => setPending(null)}
        onConfirm={() => void run()}
      >
        {pending ? MODE_TEXT[pending.mode].body : null}
      </ConfirmDialog>
    </div>
  );
}

interface RemoteComparison {
  remote: { postId: number; modifiedGmt: string; capturedAt: string } | null;
  onlyInWordPress?: string[];
  onlyInApp?: string[];
  unchanged?: number;
}

/** What an overwrite would replace: the WordPress version captured when the conflict was found, compared with the app's article. */
function RemoteChanges({ taskId }: { taskId: string }) {
  const [data, setData] = useState<RemoteComparison | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<RemoteComparison>(`/api/tasks/${taskId}/wordpress/remote`)
      .then((d) => live && setData(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [taskId]);
  return (
    <Card title="Changes made in WordPress" description="Text blocks compared after removing markup. The WordPress version was read when the conflict was found.">
      {error ? <Alert tone="danger">{error}</Alert> : null}
      {!data && !error ? <p className="text-muted text-sm">Loading the comparison…</p> : null}
      {data && !data.remote ? <p className="text-muted text-sm">No WordPress version was captured for this conflict. Use “Save again” to read it again.</p> : null}
      {data?.remote ? (
        <div className="space-y-3 text-sm">
          <p className="text-muted">
            Draft #{data.remote.postId}, modified in WordPress {data.remote.modifiedGmt} UTC · read {formatDateTime(data.remote.capturedAt)} · {data.unchanged} block(s) unchanged
          </p>
          <div>
            <h3 className="font-medium">Only in WordPress ({data.onlyInWordPress?.length ?? 0}) — an overwrite replaces these</h3>
            {data.onlyInWordPress?.length ? (
              <ul className="mt-1 space-y-1">
                {data.onlyInWordPress.map((b, i) => (
                  <li key={i} className="rounded border-l-4 border-amber-500 bg-amber-50 px-2 py-1 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100">
                    {b}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">None (only markup or spacing changed).</p>
            )}
          </div>
          <div>
            <h3 className="font-medium">Only in the app version ({data.onlyInApp?.length ?? 0})</h3>
            {data.onlyInApp?.length ? (
              <ul className="mt-1 space-y-1">
                {data.onlyInApp.map((b, i) => (
                  <li key={i} className="rounded border-l-4 border-indigo-500 bg-indigo-50 px-2 py-1 text-indigo-950 dark:bg-indigo-950/40 dark:text-indigo-100">
                    {b}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">None.</p>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}
