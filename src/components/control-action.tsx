'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client/api';
import { Button, useToast } from './client';

interface JobState {
  status: 'WAITING' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  result: Record<string, unknown> | null;
  error: string | null;
}

type Result = Record<string, unknown> | null;
const DESCRIBERS: Record<string, (r: Result) => string> = {
  login: (r) => (r?.state === 'ACTIVE' ? `Signed in. Editor: ${r.editor ?? '?'} · ${r.categories ?? 0} categories synced.` : String(r?.detail ?? 'Login not completed.')),
  test: (r) => `Session: ${r?.state} — ${r?.detail}`,
  refresh: (r) => `Session: ${r?.state}${r?.editor ? ` · editor ${r.editor}` : ''}`,
  'sync-categories': (r) => `Synced ${r?.count ?? 0} categories via ${r?.via ?? '?'}.`,
  'detect-editor': (r) => `Editor: ${r?.editor ?? 'unknown'}`,
  'open-browser': () => 'Browser window closed.',
  'reset-session': (r) => `Session reset — now ${r?.state ?? 'unknown'}.`,
  'delete-profile': () => 'Browser profile deleted.',
};

/**
 * Button that queues a worker control action and follows it to completion
 * with real status (queued → running → result). Never spins forever: shows
 * a clear message if the worker is not running.
 */
export function ControlActionButton({
  websiteId,
  action,
  children,
  variant = 'secondary',
  confirm,
  disabled,
}: {
  websiteId: string;
  action: string;
  children: ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  confirm?: string;
  disabled?: boolean;
}) {
  const describe = DESCRIBERS[action];
  const toast = useToast();
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'queued' | 'running'>('idle');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const started = useRef(0);
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  async function run() {
    setState('queued');
    started.current = Date.now();
    try {
      const { jobId } = await api<{ jobId: string }>(`/api/websites/${websiteId}/actions`, { body: { action, confirm } });
      timer.current = setInterval(async () => {
        try {
          const { job } = await api<{ job: JobState }>(`/api/control/${jobId}`);
          if (job.status === 'ACTIVE') setState('running');
          if (job.status === 'WAITING' && Date.now() - started.current > 20_000) {
            toast('error', 'The worker has not picked this up. Is `npm run dev:all` running? The action stays queued.');
            started.current = Date.now() + 10 * 60_000;
          }
          if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED') {
            if (timer.current) clearInterval(timer.current);
            setState('idle');
            if (job.status === 'COMPLETED') toast('success', describe ? describe(job.result) : 'Done.');
            else toast('error', job.error ?? 'Action failed.');
            router.refresh();
          }
        } catch (e) {
          if (timer.current) clearInterval(timer.current);
          setState('idle');
          toast('error', (e as Error).message);
        }
      }, 1500);
    } catch (e) {
      setState('idle');
      toast('error', (e as Error).message);
    }
  }

  return (
    <Button variant={variant} onClick={() => void run()} loading={state !== 'idle'} disabled={disabled}>
      {state === 'queued' ? 'Queued…' : state === 'running' ? 'Working…' : children}
    </Button>
  );
}
