'use client';

import { useEffect, useState } from 'react';
import { Check, Database, Download, GitBranch, Loader2, Minus, Package, Puzzle, RefreshCw, X } from 'lucide-react';
import { api } from '@/lib/client/api';
import type { UpdateCheck, UpdateInfo, UpdateStatus, UpdateStep } from '@/lib/update/service';
import { Alert, Card, Chip, cx } from './ui';
import { Button, Modal, useToast } from './client';

const short = (sha: string | undefined | null) => (sha ? sha.slice(0, 7) : '—');
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const FIRST = 6;

/**
 * Settings → App updates (owner request: one click instead of `git pull`, `npm run start:all` and reloading the
 * extension by hand). Check shows what GitHub has; Update asks npm run start:all to stop, update and restart the app,
 * and this card follows each step — also while the dashboard itself is stopped — then reloads the page.
 */
export function AppUpdates({ initial }: { initial: UpdateInfo }) {
  const toast = useToast();
  const [info, setInfo] = useState(initial);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [starting, setStarting] = useState(false);
  /** Set while this page follows an update: statuses older than this belong to an earlier update. */
  const [since, setSince] = useState<number | null>(initial.status?.state === 'running' ? Date.parse(initial.status.startedAt) : null);
  const [offline, setOffline] = useState(false);
  const [allCommits, setAllCommits] = useState(false);
  const [showLog, setShowLog] = useState(false);

  useEffect(() => {
    if (since === null) return;
    let stop = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/update', { cache: 'no-store', headers: { Accept: 'application/json' } });
        const data = (await res.json()) as { status?: UpdateStatus | null };
        if (stop) return;
        setOffline(false);
        const s = data.status;
        if (!s || Date.parse(s.startedAt) < since - 5000) return;
        setInfo((i) => ({ ...i, status: s }));
        // Finished and answered by the new dashboard: load the page again, with the new version's screens.
        if (s.state !== 'running' && !res.headers.get('x-bas-updater')) {
          setSince(null);
          if (s.state === 'done') setTimeout(() => window.location.reload(), 1200);
        }
      } catch {
        if (!stop) setOffline(true);
      }
    };
    void tick();
    const timer = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [since]);

  async function runCheck() {
    setChecking(true);
    setCheckError(null);
    try {
      setCheck(await api<UpdateCheck>('/api/update/check', { method: 'POST' }));
      setAllCommits(false);
    } catch (error) {
      setCheck(null);
      setCheckError((error as Error).message);
    } finally {
      setChecking(false);
    }
  }

  async function startUpdate() {
    if (!check) return;
    setStarting(true);
    try {
      await api('/api/update/start', { body: { target: check.latest.sha } });
      setSince(Date.now());
      setConfirm(false);
      setCheck(null);
    } catch (error) {
      toast('error', (error as Error).message);
    } finally {
      setStarting(false);
    }
  }

  const status = info.status;
  const following = since !== null;
  const current = info.current;
  const commits = check ? (allCommits ? check.commits : check.commits.slice(0, FIRST)) : [];

  return (
    <Card
      title="App updates"
      className="mb-6"
      description="Get the newest version from GitHub with one click. The app stops for a few minutes, installs it and starts again; articles, settings, websites and sign-ins stay as they are."
      actions={
        <Button size="sm" variant="secondary" loading={checking} disabled={following} onClick={runCheck}>
          <RefreshCw className="h-3.5 w-3.5" /> Check for updates
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-muted">Installed</span>
          {current ? (
            <>
              <code className="surface-2 rounded px-1.5 py-0.5 font-mono text-xs">{short(current.sha)}</code>
              <span className="min-w-0 truncate">{current.subject}</span>
              <span className="text-muted text-xs" suppressHydrationWarning>
                {when(current.date)}
              </span>
              {current.branch ? (
                <span className="text-muted inline-flex items-center gap-1 text-xs">
                  <GitBranch className="h-3 w-3" aria-hidden /> {current.branch}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-muted">unknown (git did not answer)</span>
          )}
        </div>

        {info.desktop ? <Alert tone="info">The desktop app is updated with its own installer.</Alert> : !info.supervised ? <Alert tone="info">The Update button works when the app is started with <code>npm run start:all</code> (it can then restart itself). You can still check what is new.</Alert> : null}

        {following && status ? <Progress status={status} offline={offline} /> : null}

        {checkError ? <Alert tone="danger" title="Could not check">{checkError}</Alert> : null}

        {check && !following ? (
          check.behind === 0 ? (
            <p className="flex items-center gap-2 text-sm">
              <Check className="h-4 w-4 text-emerald-500" aria-hidden /> This is the newest version of <code className="text-xs">{check.upstream}</code>.
            </p>
          ) : (
            <div className="border-app rounded-lg border">
              <div className="border-app flex flex-wrap items-center gap-2 border-b px-4 py-3">
                <h3 className="text-sm font-semibold">
                  {check.behind} new change{check.behind === 1 ? '' : 's'} on GitHub
                </h3>
                <span className="text-muted text-xs">
                  {short(check.current.sha)} → {short(check.latest.sha)}
                </span>
                <span className="ml-auto flex flex-wrap gap-1.5">
                  {check.changes.packages ? (
                    <Chip tone="warning" title="npm install runs; the update takes longer">
                      <Package className="mr-1 h-3 w-3" aria-hidden /> new packages
                    </Chip>
                  ) : null}
                  {check.changes.database ? (
                    <Chip tone="warning" title="A backup of the database is made first">
                      <Database className="mr-1 h-3 w-3" aria-hidden /> database changes
                    </Chip>
                  ) : null}
                  {check.changes.extension && check.extension.next ? (
                    <Chip tone="brand" title="The extension reloads itself when it is idle">
                      <Puzzle className="mr-1 h-3 w-3" aria-hidden /> extension {check.extension.next}
                    </Chip>
                  ) : null}
                </span>
              </div>
              <ul className="divide-y divide-[var(--border)]">
                {commits.map((c) => (
                  <li key={c.sha} className="flex items-baseline gap-3 px-4 py-2 text-sm">
                    <span className="min-w-0 flex-1">{c.subject}</span>
                    <span className="text-muted shrink-0 text-xs" suppressHydrationWarning>
                      {when(c.date)}
                    </span>
                  </li>
                ))}
              </ul>
              {check.behind > FIRST ? (
                <div className="border-app border-t px-4 py-2">
                  <button type="button" className="text-xs font-medium hover:underline" onClick={() => setAllCommits((a) => !a)}>
                    {allCommits ? 'Show fewer' : check.behind > check.commits.length ? `Show the newest ${check.commits.length} of ${check.behind}` : `Show all ${check.behind}`}
                  </button>
                </div>
              ) : null}
              <div className="border-app flex flex-wrap items-center gap-3 border-t px-4 py-3">
                {check.reason ? <p className="flex-1 text-sm text-amber-700">{check.reason}</p> : <p className="text-muted flex-1 text-xs">Usually 2–5 minutes. This page shows each step and opens the new version by itself.</p>}
                <Button variant="primary" disabled={!check.canUpdate} onClick={() => setConfirm(true)}>
                  <Download className="h-4 w-4" /> Update now
                </Button>
              </div>
            </div>
          )
        ) : null}

        {status && !following ? <LastUpdate status={status} showLog={showLog} onLog={() => setShowLog((v) => !v)} /> : null}
      </div>

      <Modal
        open={confirm && Boolean(check)}
        onClose={() => setConfirm(false)}
        title={`Update to ${short(check?.latest.sha)}?`}
        description={check?.latest.subject}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Cancel
            </Button>
            <Button variant="primary" loading={starting} onClick={startUpdate}>
              <Download className="h-4 w-4" /> Update now
            </Button>
          </>
        }
      >
        <ul className="list-disc space-y-2 pl-5 text-sm">
          <li>The dashboard and the worker stop, the new version is installed{check?.changes.packages ? ' (with new packages)' : ''} and built, and both start again. This page shows each step and reloads by itself.</li>
          <li>Articles, settings, websites and sign-ins are not touched.{check?.changes.database ? ' The database gets new tables or columns; a backup is made first.' : ''}</li>
          {check && check.running > 0 ? (
            <li className="text-amber-700">
              {check.running} article step{check.running === 1 ? ' is' : 's are'} running now. {check.running === 1 ? 'It stops' : 'They stop'} and continue{check.running === 1 ? 's' : ''} after the restart, as when you close the window yourself.
            </li>
          ) : null}
          {check?.changes.extension ? <li>The Chrome extension{check.extension.next ? ` (${check.extension.next})` : ''} reloads itself when it is idle. Only an extension older than 3.5.0 needs one reload by hand in chrome://extensions.</li> : null}
          <li>If something fails while installing or building, the app goes back to the version you have now.</li>
        </ul>
      </Modal>
    </Card>
  );
}

function StepIcon({ state }: { state: UpdateStep['state'] }) {
  if (state === 'running') return <Loader2 className="h-4 w-4 animate-spin text-sky-500" aria-label="running" />;
  if (state === 'done') return <Check className="h-4 w-4 text-emerald-500" aria-label="done" />;
  if (state === 'failed') return <X className="h-4 w-4 text-rose-500" aria-label="failed" />;
  if (state === 'skipped') return <Minus className="text-muted h-4 w-4" aria-label="not needed" />;
  return <span className="border-app mx-1 block h-2 w-2 rounded-full border-2" aria-label="waiting" />;
}

function Steps({ status }: { status: UpdateStatus }) {
  return (
    <ol className="space-y-1.5">
      {status.steps.map((s) => (
        <li key={s.key} className={cx('flex items-center gap-2.5 text-sm', s.state === 'waiting' && 'text-muted')}>
          <span className="flex w-4 justify-center">
            <StepIcon state={s.state} />
          </span>
          <span className={cx('shrink-0', s.state === 'running' && 'font-medium')}>{s.label}</span>
          {s.state === 'skipped' ? <span className="text-muted text-xs">not needed</span> : s.note ? <span className="text-muted truncate text-xs">{s.note}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function Progress({ status, offline }: { status: UpdateStatus; offline: boolean }) {
  const now = status.steps.find((s) => s.state === 'running');
  return (
    <div className="border-app space-y-3 rounded-lg border p-4" role="status" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{status.state === 'running' ? 'Updating…' : status.state === 'done' ? 'Updated — opening the new version…' : 'The update did not finish'}</h3>
        <span className="text-muted text-xs">
          {short(status.from?.sha)} → {short(status.to.sha)}
        </span>
      </div>
      <Steps status={status} />
      {offline || now?.key === 'start' ? <p className="text-muted text-xs">The dashboard is starting again; this page keeps waiting for it.</p> : null}
      {status.log.length ? <pre className="surface-2 overflow-hidden rounded-md p-2 font-mono text-[11px] leading-relaxed">{status.log.slice(-8).join('\n')}</pre> : null}
    </div>
  );
}

function LastUpdate({ status, showLog, onLog }: { status: UpdateStatus; showLog: boolean; onLog: () => void }) {
  const failed = status.state === 'failed';
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Last update</span>
        <Chip tone={failed ? 'danger' : status.state === 'done' ? 'success' : 'warning'}>{failed ? 'did not finish' : status.state === 'done' ? 'done' : 'running'}</Chip>
        <span className="text-muted text-xs" suppressHydrationWarning>
          {short(status.from?.sha)} → {short(status.to.sha)} · {when(status.finishedAt ?? status.startedAt)}
        </span>
        {status.log.length ? (
          <button type="button" className="text-xs font-medium hover:underline" onClick={onLog}>
            {showLog ? 'Hide steps' : 'Show steps'}
          </button>
        ) : null}
      </div>
      {failed ? (
        <Alert tone="danger" title={status.rolledBack ? 'Went back to the previous version' : 'Update stopped'}>
          {status.error}
          {status.rolledBack ? ' The app runs the version you had; nothing else changed. “Show steps” has the details to send to the developer.' : ' “Show steps” has the details to send to the developer.'}
        </Alert>
      ) : null}
      {showLog ? (
        <div className="border-app space-y-3 rounded-lg border p-4">
          <Steps status={status} />
          <pre className="surface-2 max-h-72 overflow-auto rounded-md p-2 font-mono text-[11px] leading-relaxed">{status.log.join('\n')}</pre>
        </div>
      ) : null}
    </div>
  );
}
