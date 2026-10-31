'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Ban, Download, ExternalLink, Play, RotateCcw, Trash2 } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { SerializedTaskDetail } from '@/lib/tasks/detail';
import { Button, ConfirmDialog, CopyButton, RelativeTime, Tabs, useToast } from '@/components/client';
import { Alert, Card, Chip, EmptyState, KeyValue, PageHeader, ProgressBar, StatusChip, buttonClasses, cx, formatDateTime, formatDuration } from '@/components/ui';
import { LANGUAGE_LABELS, type Language } from '@/lib/domain';
import { ArticleExtraTabs, EXTRA_TABS } from './extra-tabs';
import { ReviewNotes } from './review-notes';
import { WordPressTab } from './wordpress-tab';
import { LinksTab } from './links-tab';
import { HumanizerTab } from './humanizer-tab';
import { OriginalityTab } from './originality-tab';
import { OverviewTab } from './overview-tab';
import { ACTIVE_MODULES } from '@/modules/registry';

const REGENERABLE: Record<string, string[]> = Object.fromEntries(ACTIVE_MODULES.map((m) => [m.key, m.stages.filter((s) => s.regenerable).map((s) => s.key)]));

const BASE_TABS = ['overview', 'titles', 'research', 'editor', 'seo', 'links', 'images', 'humanizer', 'originality', 'wordpress', 'stages', 'prompts', 'logs', 'conversation'] as const;
type TabId = (typeof BASE_TABS)[number];

export function ArticleDetailView({ initial, initialTab }: { initial: SerializedTaskDetail; initialTab?: string }) {
  const toast = useToast();
  const router = useRouter();
  const [task, setTask] = useState(initial);
  const [tab, setTab] = useState<TabId>((BASE_TABS as readonly string[]).includes(initialTab ?? '') ? (initialTab as TabId) : 'overview');
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const live = !['COMPLETED', 'CANCELLED', 'FAILED'].includes(task.status);

  const reload = useCallback(async () => {
    try {
      const res = await api<{ task: SerializedTaskDetail }>(`/api/tasks/${task.id}`);
      setTask(res.task);
    } catch {
      /* keep last state; banner below shows staleness via timestamps */
    }
  }, [task.id]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void reload();
    }, 4000);
    return () => clearInterval(id);
  }, [live, reload]);

  async function remove() {
    setBusy('delete');
    try {
      const res = await api<{ status: 'deleted' | 'deleting' }>(`/api/tasks/${task.id}`, { method: 'DELETE' });
      toast('success', res.status === 'deleted' ? 'Article deleted from the app. WordPress was not changed.' : 'The running step stops first; the article is deleted then.');
      router.push('/queue');
      router.refresh();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  }

  async function action(name: 'cancel' | 'retry' | 'resume') {
    setBusy(name);
    try {
      await api(`/api/tasks/${task.id}/${name}`, { method: 'POST' });
      toast('success', name === 'cancel' ? 'Cancellation requested.' : name === 'retry' ? 'Retry queued from the first unfinished stage.' : 'Resume queued.');
      await reload();
      router.refresh();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
      setConfirmCancel(false);
    }
  }

  async function reviewAction(kind: 'allow-duplicate' | 'override-quality') {
    let body: unknown = undefined;
    if (kind === 'override-quality') {
      const reason = window.prompt('Why is this acceptable? (saved in the audit log)');
      if (!reason) return;
      body = { reason };
    }
    try {
      await api(`/api/tasks/${task.id}/${kind}`, body ? { body } : { method: 'POST' });
      toast('success', kind === 'allow-duplicate' ? 'Duplicate allowed — continuing.' : 'Override recorded — continuing.');
      await reload();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  const activeImages = task.mediaAssets.filter((m) => m.status !== 'REJECTED').length;
  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'titles', label: 'Titles' },
    { id: 'research', label: 'Research' },
    { id: 'editor', label: 'Editor' },
    { id: 'seo', label: 'SEO' },
    { id: 'images', label: 'Images', badge: activeImages ? <Chip>{activeImages}</Chip> : undefined },
    { id: 'links', label: 'Links' },
    { id: 'humanizer', label: 'Humanizer' },
    { id: 'originality', label: 'Originality' },
    { id: 'wordpress', label: 'WordPress', badge: task.wpPostId ? <Chip>#{task.wpPostId}</Chip> : undefined },
  ];
  // The technical tabs open from “More”, so the row stays on one line (owner: the tabs wrapped onto two lines).
  const moreTabs = [
    { id: 'stages', label: 'Stages' },
    { id: 'prompts', label: 'Prompt / Response', badge: task.responses.length ? <Chip>{task.responses.length}</Chip> : undefined },
    { id: 'logs', label: 'Logs', badge: task.logs.length ? <Chip>{task.logs.length}</Chip> : undefined },
    { id: 'conversation', label: 'Conversation' },
  ];

  return (
    <>
      <PageHeader
        eyebrow={
          <Link href="/queue" className="hover:underline">
            ← Article Queue
          </Link>
        }
        title={task.selectedTitle || task.keyword}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusChip status={task.status} />
            <span>{task.writerName}</span>·<span>{task.website.name}</span>·<span>{LANGUAGE_LABELS[task.language as Language] ?? task.language}</span>·<span>{task.targetCountry}</span>
            {task.legacy ? <Chip>read-only legacy record</Chip> : null}
          </span>
        }
        actions={
          <>
            <a className={buttonClasses('secondary')} href={`/api/tasks/${task.id}/report`} download title="Everything about this article (stages, prompts, answers, checks, logs) in one file, to keep or share for support">
              <Download className="h-4 w-4" /> Report
            </a>
            {task.legacy ? null : (
            <>
              {task.status === 'LOGIN_REQUIRED' || task.status === 'PAUSED' ? (
                <Button onClick={() => void action('resume')} loading={busy === 'resume'}>
                  <Play className="h-4 w-4" /> Resume
                </Button>
              ) : null}
              {['FAILED', 'CANCELLED', 'NEEDS_REVIEW'].includes(task.status) ? (
                <Button onClick={() => void action('retry')} loading={busy === 'retry'}>
                  <RotateCcw className="h-4 w-4" /> Retry
                </Button>
              ) : null}
              {!['COMPLETED', 'CANCELLED', 'FAILED', 'DRAFT_CREATED'].includes(task.status) ? (
                <Button variant="danger" onClick={() => setConfirmCancel(true)} loading={busy === 'cancel'}>
                  <Ban className="h-4 w-4" /> Cancel
                </Button>
              ) : null}
              <Button variant="secondary" className="text-rose-600 dark:text-rose-400" onClick={() => setConfirmDelete(true)} loading={busy === 'delete'}>
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
              {task.wpEditUrl ? (
                <a className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--primary)] px-3.5 text-sm font-medium text-[var(--primary-fg)] hover:opacity-90" href={task.wpEditUrl} target="_blank" rel="noreferrer">
                  WordPress draft #{task.wpPostId} <ExternalLink className="h-4 w-4" />
                </a>
              ) : null}
            </>
            )}
          </>
        }
      />

      <div className="mb-4">
        <ProgressBar label="Article progress" value={task.percent} tone={task.group === 'failed' ? 'danger' : task.group === 'review' || task.group === 'paused' ? 'warning' : task.status === 'COMPLETED' ? 'success' : 'brand'} />
        <div className="text-muted mt-1.5 flex flex-wrap justify-between gap-2 text-xs">
          <span>
            {task.stage ? <span className="font-mono">{task.stage}</span> : null} {task.message}
          </span>
          <span>
            {task.percent}% · updated <RelativeTime value={task.updatedAt} />
            {live ? ' · live' : ''}
          </span>
        </div>
      </div>

      {task.nextAction && ['review', 'paused', 'failed'].includes(task.group) ? (
        <div className="mb-4">
          <Alert tone={task.group === 'failed' ? 'danger' : 'warning'} title="Next action">
            {task.nextAction}
          </Alert>
        </div>
      ) : null}
      {task.reviewReasonList.length > 0 ? (
        <div className="mb-4">
          <ReviewNotes
            reasons={task.reviewReasonList}
            taskId={task.id}
            held={task.group === 'review'}
            onTab={(t) => setTab(t as TabId)}
            actions={
              task.group === 'review' && !task.legacy ? (
                <>
                  {task.reviewReasonList.some((r) => /^(Possible duplicate|Duplicate keyword)/.test(r)) ? (
                    <Button size="sm" onClick={() => void reviewAction('allow-duplicate')}>
                      Allow duplicate and continue
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => void reviewAction('override-quality')}>
                    Approve despite review reasons…
                  </Button>
                </>
              ) : undefined
            }
          />
        </div>
      ) : null}

      <Tabs tabs={tabs} more={moreTabs} value={tab} onChange={(id) => setTab(id as TabId)} />
      <div className="mt-4">
        {tab === 'overview' ? <OverviewTab task={task} /> : null}
        {tab === 'links' ? <LinksTab task={task} onChanged={reload} /> : null}
        {tab === 'humanizer' ? <HumanizerTab task={task} /> : null}
        {tab === 'originality' ? <OriginalityTab task={task} /> : null}
        {tab === 'wordpress' ? <WordPressTab task={task} onChanged={reload} /> : null}
        {tab === 'stages' ? <StagesTab task={task} onChanged={reload} /> : null}
        {tab === 'prompts' ? <PromptsTab task={task} /> : null}
        {tab === 'logs' ? <LogsTab task={task} /> : null}
        {tab === 'conversation' ? <ConversationTab task={task} /> : null}
        {(EXTRA_TABS as readonly string[]).includes(tab) ? <ArticleExtraTabs tab={tab as (typeof EXTRA_TABS)[number]} task={task} onChanged={reload} /> : null}
      </div>

      <ConfirmDialog open={confirmDelete} title="Delete this article?" confirmLabel="Delete" tone="danger" busy={busy === 'delete'} onCancel={() => setConfirmDelete(false)} onConfirm={() => void remove()}>
        The article is removed from this app with its stages, prompts and answers. The WordPress draft or post stays as it is. A report of the article is saved in data\backups\deleted-articles first.
      </ConfirmDialog>
      <ConfirmDialog open={confirmCancel} title="Cancel this article?" confirmLabel="Cancel article" tone="danger" busy={busy === 'cancel'} onCancel={() => setConfirmCancel(false)} onConfirm={() => void action('cancel')}>
        Work stops at the next safe point. Completed outputs, prompts and responses are kept.
      </ConfirmDialog>
    </>
  );
}

function StagesTab({ task, onChanged }: { task: SerializedTaskDetail; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const [plan, setPlan] = useState<{ stage: string; plan: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  if (task.stages.length === 0) return <Card><EmptyState title="No stages yet" description="Stages are created when the worker starts this task." /></Card>;
  const regenerable = new Set(REGENERABLE[task.moduleKey] ?? []);
  async function preview(stageKey: string) {
    try {
      setPlan(await api<{ stage: string; plan: string[] }>(`/api/tasks/${task.id}/regenerate`, { body: { stageKey, preview: true } }));
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }
  async function confirm() {
    if (!plan) return;
    setBusy(true);
    try {
      await api(`/api/tasks/${task.id}/regenerate`, { body: { stageKey: plan.stage } });
      toast('success', `Regenerating ${plan.stage} and its dependents. Earlier outputs are kept in history.`);
      setPlan(null);
      await onChanged();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card padded={false}>
      <table className="table-app">
        <thead>
          <tr>
            <th>#</th>
            <th>Stage</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Duration</th>
            <th>Message / error</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {task.stages.map((s) => (
            <tr key={s.id}>
              <td className="text-muted tabular-nums">{s.position}</td>
              <td>
                <div className="font-medium">{s.label}</div>
                <code className="text-muted text-[11px]">{s.key}</code>
              </td>
              <td className="text-xs">{s.kind}</td>
              <td>
                <Chip tone={s.status === 'COMPLETED' ? 'success' : s.status === 'FAILED' ? 'danger' : s.status === 'RUNNING' ? 'info' : s.status === 'WAITING' ? 'warning' : 'neutral'}>{s.status.toLowerCase()}</Chip>
              </td>
              <td className="tabular-nums">{s.attempts}</td>
              <td className="text-xs whitespace-nowrap">{formatDuration(s.durationMs)}</td>
              <td className="max-w-[380px] text-xs">
                {s.error ? <span className="text-rose-700 dark:text-rose-300">{s.error}</span> : s.message}
                {s.promptVersion ? <div className="text-muted">prompt {s.promptVersion}</div> : null}
              </td>
              <td className="text-right">
                {regenerable.has(s.key) && !task.legacy && (s.status === 'COMPLETED' || s.status === 'FAILED' || s.status === 'SKIPPED') ? (
                  <Button size="sm" variant="ghost" onClick={() => void preview(s.key)}>
                    <RotateCcw className="h-3.5 w-3.5" /> Regenerate
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ConfirmDialog open={Boolean(plan)} title={`Regenerate ${plan?.stage ?? ''}?`} confirmLabel="Regenerate" busy={busy} onCancel={() => setPlan(null)} onConfirm={() => void confirm()}>
        These stages will run again (dependency graph): <strong>{plan?.plan.join(' → ')}</strong>. Unrelated stages, research and approvals outside this list are kept. Previous outputs are saved as revisions.
      </ConfirmDialog>
    </Card>
  );
}

function PromptsTab({ task }: { task: SerializedTaskDetail }) {
  if (task.responses.length === 0) return <Card><EmptyState title="No prompts sent yet" description="Each ChatGPT prompt is stored exactly as submitted, with its answer." /></Card>;
  return (
    <div className="space-y-4">
      {task.responses.map((r) => (
        <Card
          key={r.id}
          title={
            <span className="flex flex-wrap items-center gap-2">
              <code>{r.stageKey}</code> attempt {r.attempt}
              <Chip tone={r.status === 'COMPLETED' ? 'success' : r.status === 'PENDING' ? 'info' : r.status === 'FAILED' ? 'danger' : 'neutral'}>{r.status.toLowerCase()}</Chip>
              {r.recovered ? <Chip tone="warning">recovered</Chip> : null}
              {r.reused ? <Chip>reused</Chip> : null}
              {r.conversationSwitch ? <Chip tone="warning">new conversation</Chip> : null}
            </span>
          }
          description={`${formatDateTime(r.createdAt)}${r.elapsedMs ? ` · ${formatDuration(r.elapsedMs)}` : ''} · op ${r.operationId}`}
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-muted text-xs font-semibold uppercase">Exact prompt</span>
                <CopyButton text={r.renderedPrompt} />
              </div>
              <pre className="surface-2 max-h-80 overflow-auto rounded-lg p-3 text-xs whitespace-pre-wrap">{r.renderedPrompt}</pre>
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="text-muted text-xs font-semibold uppercase">Answer</span>
                {r.resultText ? <CopyButton text={r.resultText} /> : null}
              </div>
              {r.resultText ? (
                <pre className="surface-2 max-h-80 overflow-auto rounded-lg p-3 text-xs whitespace-pre-wrap">{r.resultText}</pre>
              ) : (
                <p className="text-muted text-sm">{r.error ?? 'Waiting for the ChatGPT extension…'}</p>
              )}
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function LogsTab({ task }: { task: SerializedTaskDetail }) {
  if (task.logs.length === 0) return <Card><EmptyState title="No log entries" /></Card>;
  return (
    <Card padded={false}>
      <div className="max-h-[70vh] overflow-auto">
        <table className="table-app">
          <thead>
            <tr>
              <th>Time</th>
              <th>Level</th>
              <th>Stage</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            {task.logs.map((l) => (
              <tr key={l.id}>
                <td className="text-muted text-xs whitespace-nowrap">{formatDateTime(l.createdAt)}</td>
                <td>
                  <Chip tone={l.level === 'error' ? 'danger' : l.level === 'warn' ? 'warning' : 'neutral'}>{l.level}</Chip>
                </td>
                <td className="text-xs">{l.stage ?? '—'}</td>
                <td className="text-sm break-words">
                  {l.message}
                  {l.screenshotPath ? (
                    <a className="ml-2 text-xs link" href={`/api/files/screenshot?path=${encodeURIComponent(l.screenshotPath)}`} target="_blank" rel="noreferrer">
                      screenshot
                    </a>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ConversationTab({ task }: { task: SerializedTaskDetail }) {
  const completed = task.responses.filter((r) => r.status === 'COMPLETED' || r.status === 'PENDING');
  return (
    <Card
      title="ChatGPT conversation"
      description="Successive prompts of one article run in one conversation whenever possible. Conversation switches are recorded."
      actions={task.conversationUrl ? <a className="text-sm link" href={task.conversationUrl} target="_blank" rel="noreferrer">Open in Automation Chrome</a> : undefined}
    >
      {completed.length === 0 ? (
        <EmptyState title="No conversation yet" />
      ) : (
        <ol className="space-y-4">
          {completed.map((r) => (
            <li key={r.id} className="space-y-2">
              {r.conversationSwitch ? <Alert tone="warning">Conversation switched here: the previous chat could not be recovered, so a new chat started with a source-faithful primer.</Alert> : null}
              <div className="ml-auto max-w-[85%] rounded-xl bg-indigo-50 px-3 py-2 text-sm whitespace-pre-wrap dark:bg-indigo-950">
                <div className="text-muted mb-1 text-[11px]">You · {r.stageKey}</div>
                {r.renderedPrompt.length > 600 ? r.renderedPrompt.slice(0, 600) + '…' : r.renderedPrompt}
              </div>
              <div className={cx('surface-2 max-w-[85%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap')}>
                <div className="text-muted mb-1 text-[11px]">ChatGPT {r.conversationUrl ? '· saved' : ''}</div>
                {r.resultText ? (r.resultText.length > 1200 ? r.resultText.slice(0, 1200) + '…' : r.resultText) : <em className="text-muted">waiting…</em>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
