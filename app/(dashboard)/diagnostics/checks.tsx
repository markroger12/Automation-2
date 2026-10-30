'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, MonitorCheck, Plug, RotateCcw, Search } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, useToast } from '@/components/client';
import { Card, Chip } from '@/components/ui';

interface Session {
  websiteId: string;
  website: string;
  active: boolean;
  state: string;
  lastCheckedAt: string | null;
}
interface FailedStage {
  taskId: string;
  key: string;
  label: string;
  keyword: string;
  error: string | null;
  message: string | null;
  hasArticle: boolean;
}
interface SetupStatus {
  steps: Record<string, { ok: boolean; detail: string }>;
}

const STEP_LABEL: Record<string, string> = { chromeInstalled: 'Chrome installed', chromeRunning: 'Automation Chrome running', extensionLoaded: 'Extension loaded', paired: 'Extension paired', chatgptSignedIn: 'ChatGPT signed in' };

/** Diagnostic controls (spec §15): each one runs the real check or queues the real job; nothing is simulated. */
export function DiagnosticChecks({ sessions, failedStages }: { sessions: Session[]; failedStages: FailedStage[] }) {
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [test, setTest] = useState<{ jobId: string; status: string; text?: string; error?: string | null } | null>(null);

  useEffect(() => {
    if (!test || ['COMPLETED', 'FAILED', 'CANCELLED'].includes(test.status)) return;
    const id = setInterval(async () => {
      const res = await api<{ job: { status: string; result: string | null; error: string | null } | null }>(`/api/extension/test-prompt?jobId=${test.jobId}`).catch(() => null);
      if (!res?.job) return;
      const result = res.job.result ? (JSON.parse(res.job.result) as { text?: string }) : null;
      setTest({ jobId: test.jobId, status: res.job.status, text: result?.text, error: res.job.error });
    }, 1500);
    return () => clearInterval(id);
  }, [test]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Checks" description="Run a real check. Results come from the worker, the extension or WordPress; nothing here is simulated.">
      <div className="space-y-5 text-sm">
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" loading={busy === 'setup'} onClick={() => void run('setup', async () => setSetup(await api<SetupStatus>('/api/automation-chrome')))}>
              <MonitorCheck className="h-4 w-4" /> Check Chrome setup
            </Button>
            <Button
              size="sm"
              loading={busy === 'ext'}
              onClick={() =>
                void run('ext', async () => {
                  const res = await api<{ jobId: string }>('/api/extension/test-prompt', { body: {} });
                  setTest({ jobId: res.jobId, status: 'WAITING' });
                })
              }
            >
              <Plug className="h-4 w-4" /> Test extension connection
            </Button>
          </div>
          {setup ? (
            <ul className="space-y-1">
              {Object.entries(setup.steps).map(([k, v]) => (
                <li key={k} className="flex flex-wrap items-center gap-2">
                  <Chip tone={v.ok ? 'success' : 'warning'}>{v.ok ? 'ok' : 'not yet'}</Chip>
                  <span className="font-medium">{STEP_LABEL[k] ?? k}</span>
                  <span className="text-muted text-xs">{v.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {test ? (
            <p role="status">
              Test prompt: <Chip tone={test.status === 'COMPLETED' ? 'success' : test.status === 'FAILED' ? 'danger' : 'info'}>{test.status.toLowerCase()}</Chip>{' '}
              {test.text ? <span className="text-muted">ChatGPT answered: “{test.text.slice(0, 120)}”</span> : test.error ? <span className="text-rose-700 dark:text-rose-300">{test.error}</span> : <span className="text-muted">waiting for the extension to claim it…</span>}
            </p>
          ) : null}
        </section>

        <section>
          <h3 className="mb-1.5 font-medium">WordPress sessions</h3>
          {sessions.length === 0 ? <p className="text-muted">No websites yet.</p> : null}
          <ul className="space-y-1">
            {sessions.map((s) => (
              <li key={s.websiteId} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate">{s.website}</span>
                <Chip tone={s.state === 'ACTIVE' ? 'success' : s.state === 'LOGIN_REQUIRED' ? 'warning' : 'neutral'}>{s.state.toLowerCase().replace(/_/g, ' ')}</Chip>
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busy === `wp:${s.websiteId}`}
                  onClick={() =>
                    void run(`wp:${s.websiteId}`, async () => {
                      await api(`/api/websites/${s.websiteId}/actions`, { body: { action: 'test' } });
                      toast('success', `Session test queued for ${s.website}; the worker runs it.`);
                      setTimeout(() => router.refresh(), 4000);
                    })
                  }
                >
                  <Activity className="h-4 w-4" /> Test session
                </Button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="mb-1.5 font-medium">Failed stages</h3>
          {failedStages.length === 0 ? <p className="text-muted">None.</p> : null}
          <ul className="space-y-2">
            {failedStages.map((f) => (
              <li key={`${f.taskId}:${f.key}`} className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{f.keyword}</span> · {f.label}
                  <span className="text-muted block truncate text-xs">{f.error ?? f.message ?? ''}</span>
                </span>
                <Link className="text-xs link" href={`/articles/${f.taskId}?tab=stages`}>
                  <Search className="mr-1 inline h-3 w-3" />
                  Inspect stage
                </Link>
                {f.hasArticle ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === `seo:${f.taskId}`}
                    onClick={() =>
                      void run(`seo:${f.taskId}`, async () => {
                        await api(`/api/tasks/${f.taskId}/seo-rerun`, { method: 'POST' });
                        toast('success', 'SEO analysis re-run.');
                        router.refresh();
                      })
                    }
                  >
                    <RotateCcw className="h-4 w-4" /> Re-run SEO analysis
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      </div>
    </Card>
  );
}
