'use client';

import { useEffect, useState } from 'react';
import { Check, Download, ExternalLink, Loader2, RefreshCw, RotateCcw } from 'lucide-react';
import { Alert, Card } from './ui';
import { Button } from './client';

/** The desktop app's updater as its dashboard tab sees it (desktop/dashboard-preload.cjs, desktop/updates.cjs). */
interface DesktopUpdateState {
  state: 'idle' | 'unavailable' | 'checking' | 'current' | 'downloading' | 'ready' | 'error';
  current: string;
  version: string | null;
  percent: number | null;
  message: string | null;
  checkedAt: string | null;
}
interface BasAppBridge {
  updates: {
    state: () => Promise<DesktopUpdateState | null>;
    check: () => Promise<DesktopUpdateState | null>;
    install: () => void;
    onState: (callback: (state: DesktopUpdateState) => void) => () => void;
  };
}

const RELEASES = 'https://github.com/markroger12/Automation-2/releases';
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');

/**
 * Settings → App updates inside the desktop app (owner report 2026-11-12: the git card said “git did not answer” and
 * “not a git copy” there). The app updates itself from GitHub Releases: this card shows its version and what the
 * updater is doing, looks for a new version on request, and offers Restart to update once one is downloaded.
 */
export function DesktopAppUpdates({ version }: { version: string | null }) {
  const [bridge, setBridge] = useState<BasAppBridge | null>(null);
  const [s, setState] = useState<DesktopUpdateState | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const b = (window as unknown as { basApp?: BasAppBridge }).basApp ?? null;
    setBridge(b);
    if (!b) return;
    void b.updates.state().then((state) => state && setState(state));
    return b.updates.onState((state) => setState(state));
  }, []);

  const check = async () => {
    if (!bridge) return;
    setChecking(true);
    try {
      const state = await bridge.updates.check();
      if (state) setState(state);
    } finally {
      setChecking(false);
    }
  };

  const installed = s?.current || version;
  const busy = s?.state === 'checking' || s?.state === 'downloading' || checking;
  return (
    <Card
      id="app-updates"
      title="App updates"
      className="mb-6 scroll-mt-20"
      description="The app looks for a new version by itself when it starts and every 6 hours, downloads it in the background and asks you to restart. Articles, settings, websites and sign-ins stay as they are."
      actions={
        bridge && s?.state !== 'unavailable' ? (
          <Button size="sm" variant="secondary" loading={busy} disabled={busy || s?.state === 'ready'} onClick={() => void check()}>
            <RefreshCw className="h-3.5 w-3.5" /> Check for updates
          </Button>
        ) : null
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          <span className="text-muted">Installed version</span>
          <code className="surface-2 rounded px-1.5 py-0.5 font-mono text-xs">{installed ? `v${installed}` : 'unknown'}</code>
          <a className="text-muted inline-flex items-center gap-1 text-xs hover:underline" href={RELEASES} target="_blank" rel="noreferrer">
            What&apos;s new <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </div>

        {!bridge ? (
          <p className="text-muted text-sm">Open the app and use Help → Check for updates (press Alt to show the menu).</p>
        ) : !s ? null : s.state === 'unavailable' ? (
          <Alert tone="info">This copy of the app does not update itself (it was not installed with the installer). Install it from the Releases page to get updates.</Alert>
        ) : s.state === 'checking' || (checking && s.state !== 'downloading') ? (
          <p className="text-muted flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Looking for a new version…
          </p>
        ) : s.state === 'downloading' ? (
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-sm">
              <Download className="h-4 w-4" aria-hidden /> Downloading version {s.version} · {s.percent ?? 0}%
            </p>
            <div className="surface-2 h-1.5 overflow-hidden rounded-full" role="progressbar" aria-valuenow={s.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full rounded-full bg-[var(--primary)] transition-[width]" style={{ width: `${s.percent ?? 0}%` }} />
            </div>
          </div>
        ) : s.state === 'ready' ? (
          <div className="border-app flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3">
            <div className="min-w-0 flex-1 text-sm">
              <div className="font-semibold">Version {s.version} is ready</div>
              <div className="text-muted text-xs">Restarting stops the work safely first: prompts go back to the queue and continue after the restart.</div>
            </div>
            <Button size="sm" onClick={() => bridge.updates.install()}>
              <RotateCcw className="h-3.5 w-3.5" /> Restart to update
            </Button>
          </div>
        ) : s.state === 'error' ? (
          <Alert tone="warning" title="Could not look for updates">
            {s.message || 'No answer from GitHub.'} The app tries again by itself in a few hours.
          </Alert>
        ) : s.state === 'current' ? (
          <p className="flex items-center gap-2 text-sm">
            <Check className="h-4 w-4 text-emerald-500" aria-hidden /> This is the newest version.
            {s.checkedAt ? (
              <span className="text-muted text-xs" suppressHydrationWarning>
                Checked at {time(s.checkedAt)}
              </span>
            ) : null}
          </p>
        ) : (
          <p className="text-muted text-sm">The first look for a new version happens 30 seconds after the app starts.</p>
        )}
      </div>
    </Card>
  );
}
