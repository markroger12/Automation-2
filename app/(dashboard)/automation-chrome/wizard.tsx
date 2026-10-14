'use client';

import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, CircleDashed, Pause, Play, Rocket, Send } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, CopyButton, RelativeTime, useToast } from '@/components/client';
import { ExtensionPairing } from '@/components/extension-pairing';
import { Alert, Card, Chip, cx } from '@/components/ui';
import { Textarea } from '@/components/form';

interface Step {
  ok: boolean;
  detail: string;
}
interface Status {
  steps: Record<'chromeInstalled' | 'chromeRunning' | 'extensionLoaded' | 'paired' | 'chatgptSignedIn', Step>;
  extension: { state: string; version: string | null; expectedVersion: string; versionOk: boolean; lastSeenAt: string | null; tabs: number };
  key: { configured: boolean; prefix: string | null; createdAt: string | null };
  claimsPaused: boolean;
  queue: { active: number; waiting: number };
  backoffUntil: string | null;
  concurrency: number;
  tabsSetting: number;
  extensionFolder: string;
  profileFolder: string;
  lastLaunch: { status: string; error: string | null } | null;
}

function StepRow({ n, title, step, children }: { n: number; title: string; step: Step; children?: React.ReactNode }) {
  return (
    <li className="border-app flex gap-4 border-b py-4 last:border-b-0">
      <div className={cx('grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-semibold', step.ok ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300' : 'surface-2 text-muted')}>
        {step.ok ? <CircleCheck className="h-5 w-5" /> : n}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-semibold">{title}</h3>
          {step.ok ? <Chip tone="success">verified</Chip> : <Chip tone="warning">not yet</Chip>}
        </div>
        <p className="text-muted mt-0.5 text-xs">{step.detail}</p>
        {children ? <div className="mt-3 text-sm">{children}</div> : null}
      </div>
    </li>
  );
}

export function AutomationChromeWizard() {
  const toast = useToast();
  const [s, setS] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [prompt, setPrompt] = useState('Reply with exactly: Blog Automation Studio connection OK');
  const [test, setTest] = useState<{ jobId: string; status: string; text?: string; error?: string | null; step?: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setS(await api<Status>('/api/automation-chrome'));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    if (!test || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(test.status)) return;
    const id = setInterval(async () => {
      const res = await api<{ job: { status: string; result: string | null; error: string | null; progress: string | null } | null }>(`/api/extension/test-prompt?jobId=${test.jobId}`);
      if (!res.job) return;
      const result = res.job.result ? (JSON.parse(res.job.result) as { text?: string }) : null;
      const progress = res.job.progress ? (JSON.parse(res.job.progress) as { step?: string }) : null;
      setTest({ jobId: test.jobId, status: res.job.status, text: result?.text, error: res.job.error, step: progress?.step });
    }, 1500);
    return () => clearInterval(id);
  }, [test]);

  async function launch() {
    setLaunching(true);
    try {
      await api('/api/automation-chrome/launch', { method: 'POST' });
      toast('success', 'Launch requested. The worker opens the Automation Chrome window.');
      setTimeout(() => void load(), 2500);
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setLaunching(false);
    }
  }

  async function toggleClaims() {
    if (!s) return;
    try {
      await api('/api/extension/claims', { method: 'PUT', body: { paused: !s.claimsPaused } });
      await load();
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  async function sendTest() {
    try {
      const res = await api<{ jobId: string }>('/api/extension/test-prompt', { body: { prompt } });
      setTest({ jobId: res.jobId, status: 'WAITING' });
    } catch (e) {
      toast('error', (e as Error).message);
    }
  }

  if (error) return <Alert tone="danger" title="Could not load status">{error}</Alert>;
  if (!s) return <div className="surface-2 h-40 animate-pulse rounded-xl" aria-busy="true" />;
  const allOk = Object.values(s.steps).every((x) => x.ok);

  return (
    <div className="grid gap-6 xl:grid-cols-3">
      <Card title="Setup — five checked steps" className="xl:col-span-2" description="Status refreshes every 3 seconds from real signals (installed browser, profile lock, extension heartbeats).">
        <ol>
          <StepRow n={1} title="Google Chrome installed" step={s.steps.chromeInstalled}>
            {!s.steps.chromeInstalled.ok ? 'Install Google Chrome, then reload this page.' : null}
          </StepRow>
          <StepRow n={2} title="Automation Chrome profile running" step={s.steps.chromeRunning}>
            <p className="text-muted mb-2 text-xs">A separate, visible Chrome window with its own profile ({s.profileFolder}). Keep it open while articles run; minimizing is fine.</p>
            <Button variant="primary" onClick={() => void launch()} loading={launching} disabled={s.steps.chromeRunning.ok}>
              <Rocket className="h-4 w-4" /> Launch Automation Chrome
            </Button>
            {s.lastLaunch?.status === 'FAILED' ? <p className="mt-2 text-xs text-rose-700">Last launch failed: {s.lastLaunch.error}</p> : null}
          </StepRow>
          <StepRow n={3} title="Load the extension (once)" step={s.steps.extensionLoaded}>
            <ol className="list-decimal space-y-1 pl-5 text-xs">
              <li>
                In the Automation Chrome window open <code>chrome://extensions</code> and switch on <strong>Developer mode</strong>.
              </li>
              <li>
                Click <strong>Load unpacked</strong> and choose this folder:
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <code className="surface-2 rounded px-2 py-0.5 break-all">{s.extensionFolder}</code>
                  <CopyButton text={s.extensionFolder} label="Copy path" />
                </div>
              </li>
            </ol>
          </StepRow>
          <StepRow n={4} title="Pair the extension with this dashboard" step={s.steps.paired}>
            <ExtensionPairing configured={s.key.configured} prefix={s.key.prefix} createdAt={s.key.createdAt} onChanged={() => void load()} />
            {!s.extension.versionOk ? (
              <Alert tone="danger" title="Extension version mismatch">
                Loaded v{s.extension.version}, the app expects v{s.extension.expectedVersion}. Click reload on the extension card once in chrome://extensions.
              </Alert>
            ) : null}
          </StepRow>
          <StepRow n={5} title="Sign in to ChatGPT in that window" step={s.steps.chatgptSignedIn}>
            Sign in yourself. If ChatGPT ever shows a login or verification check, tasks pause and you get a desktop notification; nothing is automated around it.
          </StepRow>
        </ol>
      </Card>

      <div className="space-y-6">
        <Card title="Live status">
          <ul className="space-y-2 text-sm">
            <li className="flex justify-between">
              <span>Extension</span>
              <Chip tone={s.extension.state === 'connected' ? 'success' : 'warning'}>{s.extension.state}</Chip>
            </li>
            <li className="text-muted text-xs">Last heartbeat <RelativeTime value={s.extension.lastSeenAt} /> · {s.extension.tabs} ChatGPT tab(s)</li>
            <li className="flex justify-between">
              <span>ChatGPT jobs</span>
              <span className="tabular-nums">
                {s.queue.active} running · {s.queue.waiting} waiting
              </span>
            </li>
            <li className="flex justify-between">
              <span>Adaptive slots</span>
              <span className="tabular-nums">
                {s.concurrency} (tabs setting {s.tabsSetting})
              </span>
            </li>
            {s.backoffUntil && new Date(s.backoffUntil) > new Date() ? (
              <li className="text-xs text-amber-700">Rate-limit backoff until {new Date(s.backoffUntil).toLocaleTimeString()}</li>
            ) : null}
          </ul>
          {s.tabsSetting > 3 ? (
            <div className="mt-3">
              <Alert tone="warning">More than 3 ChatGPT tabs can trigger account-wide rate limiting.</Alert>
            </div>
          ) : null}
          <div className="mt-4">
            <Button onClick={() => void toggleClaims()}>
              {s.claimsPaused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              {s.claimsPaused ? 'Resume new ChatGPT claims' : 'Pause new claims (graceful drain)'}
            </Button>
            <p className="text-muted mt-2 text-xs">Before restarting Chrome: pause, wait until 0 are running, then restart. Never kill Chrome while it owns jobs.</p>
          </div>
        </Card>

        <Card title="Test extension connection" description="Sends one real prompt through your ChatGPT session and stores the answer.">
          <Textarea rows={2} value={prompt} onChange={(e) => setPrompt(e.target.value)} aria-label="Test prompt" />
          <div className="mt-2 flex items-center gap-2">
            <Button variant="primary" onClick={() => void sendTest()} disabled={!allOk && !s.steps.paired.ok} loading={Boolean(test && !['COMPLETED', 'FAILED', 'CANCELLED'].includes(test.status))}>
              <Send className="h-4 w-4" /> Send test prompt
            </Button>
            {test ? <Chip tone={test.status === 'COMPLETED' ? 'success' : test.status === 'FAILED' ? 'danger' : 'info'}>{test.status.toLowerCase()}</Chip> : null}
          </div>
          {test?.step && test.status !== 'COMPLETED' ? <p className="text-muted mt-2 text-xs">{test.step}</p> : null}
          {test?.text ? <pre className="surface-2 mt-3 max-h-40 overflow-auto rounded p-2 text-xs whitespace-pre-wrap">{test.text}</pre> : null}
          {test?.error ? <p className="mt-2 text-xs text-rose-700">{test.error}</p> : null}
          {!s.steps.paired.ok ? (
            <p className="text-muted mt-2 flex items-center gap-1 text-xs">
              <CircleDashed className="h-3 w-3" /> Pair the extension first.
            </p>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
