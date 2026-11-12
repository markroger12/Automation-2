'use client';

import { useCallback, useEffect, useState } from 'react';
import { Moon, Pause, Play } from 'lucide-react';
import { api } from '@/lib/client/api';
import { cx } from './ui';

interface WorkState {
  paused: boolean;
  reason: 'manual' | 'quiet' | null;
  until: string | null;
  message: string | null;
}

/**
 * The top bar's pause button (owner request 2026-11-12: pause all work with one click). Paused: no new ChatGPT prompt
 * starts and no indexing request is made; running prompts finish and everything else waits. In the quiet hours it
 * says so (Settings → Workflow); a click there opens the setting instead.
 */
export function WorkPauseButton() {
  const [s, setS] = useState<WorkState | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      setS(await api<WorkState>('/api/work'));
    } catch {
      /* the dashboard is restarting: try again with the next tick */
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => clearInterval(timer);
  }, [load]);
  if (!s) return null;
  const toggle = async () => {
    if (s.reason === 'quiet') {
      window.location.href = '/settings';
      return;
    }
    setBusy(true);
    try {
      setS(await api<WorkState>('/api/work', { method: 'PUT', body: { paused: !s.paused } }));
    } finally {
      setBusy(false);
    }
  };
  const Icon = s.reason === 'quiet' ? Moon : s.paused ? Play : Pause;
  const label = s.reason === 'quiet' ? 'Quiet hours' : s.paused ? 'Resume' : 'Pause';
  const title = s.paused ? (s.message ?? 'Paused') : 'Pause new work: running prompts finish, new prompts and indexing requests wait until you resume.';
  return (
    <button
      type="button"
      onClick={() => void toggle()}
      disabled={busy}
      title={title}
      aria-pressed={s.paused}
      className={cx(
        'inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium transition-colors disabled:opacity-60',
        s.paused ? 'bg-amber-100 text-amber-900 hover:bg-amber-200 dark:bg-amber-950/70 dark:text-amber-100 dark:hover:bg-amber-900/70' : 'text-muted hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
      )}
    >
      <Icon className="h-4 w-4" aria-hidden />
      <span className="hidden sm:inline">{s.paused && s.reason !== 'quiet' ? 'Paused · Resume' : label}</span>
    </button>
  );
}
