'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArrowRight, Check, Loader2, PenLine, X } from 'lucide-react';
import type { SetupState, SetupStep } from '@/lib/setup';
import { api } from '@/lib/client/api';
import { Button, useToast } from './client';
import { Card, Chip, ProgressBar, buttonClasses, cx } from './ui';

interface TabsBridge {
  tabs?: { show: (tab: 'chatgpt' | 'search-console') => void };
}

/** The checklist, read again every few seconds so a step ticks itself off as soon as it is done. */
function useSetup(initial: SetupState) {
  const [s, setS] = useState(initial);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void api<SetupState>('/api/setup')
        .then(setS)
        .catch(() => {});
    }, 8000);
    return () => clearInterval(timer);
  }, []);
  return [s, setS] as const;
}

function StepAction({ action, primary }: { action: NonNullable<SetupStep['action']>; primary?: boolean }) {
  const toast = useToast();
  const variant = primary ? 'primary' : 'secondary';
  if (action.tab) {
    const shortcut = action.tab === 'chatgpt' ? 'Ctrl+2' : 'Ctrl+3';
    return (
      <Button
        size="sm"
        variant={variant}
        onClick={() => {
          const bridge = (window as unknown as { basApp?: TabsBridge }).basApp;
          if (bridge?.tabs) bridge.tabs.show(action.tab!);
          else toast('info', `Use the tab at the top of the app (${shortcut}).`);
        }}
      >
        {action.label} <ArrowRight className="h-3.5 w-3.5" />
      </Button>
    );
  }
  return (
    <Link href={action.href ?? '/'} className={buttonClasses(variant, 'sm')}>
      {action.label} <ArrowRight className="h-3.5 w-3.5" />
    </Link>
  );
}

function StepMark({ step, index }: { step: SetupStep; index: number }) {
  return (
    <span
      className={cx(
        'grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-semibold',
        step.state === 'done' && 'bg-emerald-500 text-white',
        step.state === 'attention' && 'bg-amber-500 text-white',
        step.state === 'running' && 'bg-[var(--primary)] text-[var(--primary-fg)]',
        step.state === 'todo' && 'surface-2 text-muted',
      )}
      aria-hidden
    >
      {step.state === 'done' ? <Check className="h-4 w-4" /> : step.state === 'attention' ? <AlertTriangle className="h-4 w-4" /> : step.state === 'running' ? <Loader2 className="h-4 w-4 animate-spin" /> : index + 1}
    </span>
  );
}

const STATE_WORD: Record<SetupStep['state'], string> = { done: 'Done', todo: 'To do', attention: 'Needs you', running: 'In progress' };

/**
 * Logs / Diagnostics → Setup checklist (owner request 2026-11-12): the steps before the first article, ticked off from
 * the app's real state (ChatGPT connected, a website added, the first article finished), and the optional extras.
 */
export function SetupChecklist({ initial }: { initial: SetupState }) {
  const [s, setS] = useSetup(initial);
  const toast = useToast();
  const next = s.steps.find((x) => !x.optional && x.state !== 'done');
  const toggleBanner = async () => {
    try {
      setS(await api<SetupState>('/api/setup', { method: 'PUT', body: { dismissed: !s.dismissed } }));
      toast('success', s.dismissed ? 'The checklist shows on the Overview again.' : 'Hidden from the Overview.');
    } catch {
      toast('error', 'Could not save. Try again.');
    }
  };
  return (
    <div className="space-y-6">
      <Card padded>
        <div className="flex flex-wrap items-center gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">{s.complete ? 'You are all set' : `${s.done} of ${s.total} steps done`}</div>
            <p className="text-muted mt-0.5 text-sm">
              {s.complete ? 'Everything needed for articles works. The optional steps below add more.' : next ? `Next: ${next.title}.` : ''}
            </p>
          </div>
          {s.complete ? (
            <Link href="/single-article" className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[var(--primary)] px-3 text-sm font-medium text-[var(--primary-fg)] hover:opacity-90">
              <PenLine className="h-4 w-4" /> New article
            </Link>
          ) : null}
          {!s.complete ? (
            <Button size="sm" variant="ghost" onClick={() => void toggleBanner()}>
              {s.dismissed ? 'Show on the Overview' : 'Hide from the Overview'}
            </Button>
          ) : null}
        </div>
        <div className="mt-4">
          <ProgressBar value={Math.round((s.done / Math.max(1, s.total)) * 100)} tone={s.complete ? 'success' : 'brand'} label="Setup progress" />
        </div>
      </Card>

      {(['Needed for articles', 'Optional'] as const).map((group) => (
        <section key={group} aria-label={group}>
          <h2 className="text-muted mb-3 text-xs font-semibold tracking-wider uppercase">{group}</h2>
          <ol className="space-y-3">
            {s.steps
              .filter((x) => x.optional === (group === 'Optional'))
              .map((step) => (
                <li key={step.key} className={cx('surface border-app flex flex-wrap items-start gap-4 rounded-xl border p-4', step === next && 'ring-2 ring-[var(--primary)]/40')}>
                  <StepMark step={step} index={s.steps.indexOf(step)} />
                  <div className="min-w-[min(100%,240px)] flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={cx('font-medium', step.state === 'done' && 'text-muted')}>{step.title}</span>
                      <Chip tone={step.state === 'done' ? 'success' : step.state === 'attention' ? 'warning' : step.state === 'running' ? 'info' : 'neutral'}>{STATE_WORD[step.state]}</Chip>
                    </div>
                    <p className="text-muted mt-1 text-sm">{step.detail}</p>
                  </div>
                  {step.action && step.state !== 'done' ? <StepAction action={step.action} primary={step === next} /> : step.action ? <StepAction action={step.action} /> : null}
                </li>
              ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

/** Overview: the next setup step until the required ones are done (or the owner hides it). */
export function SetupBanner({ initial }: { initial: SetupState }) {
  const [s, setS] = useSetup(initial);
  const toast = useToast();
  if (s.complete || s.dismissed) return null;
  const next = s.steps.find((x) => !x.optional && x.state !== 'done');
  const hide = async () => {
    try {
      setS(await api<SetupState>('/api/setup', { method: 'PUT', body: { dismissed: true } }));
      toast('info', 'Hidden. The checklist stays under Logs / Diagnostics → Setup checklist.');
    } catch {
      toast('error', 'Could not save. Try again.');
    }
  };
  return (
    <div className="surface border-app mb-6 rounded-xl border p-4 sm:p-5">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 className="text-base font-semibold">Finish setting up</h2>
            <span className="text-muted text-sm">
              {s.done} of {s.total} done
            </span>
          </div>
          <div className="mt-2 max-w-md">
            <ProgressBar value={Math.round((s.done / Math.max(1, s.total)) * 100)} label="Setup progress" />
          </div>
          {next ? (
            <p className="mt-3 text-sm">
              <span className="font-medium">Next: {next.title}.</span> <span className="text-muted">{next.detail}</span>
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {next?.action ? <StepAction action={next.action} primary /> : null}
            <Link href="/setup" className={buttonClasses('secondary', 'sm')}>
              See all steps
            </Link>
          </div>
        </div>
        <button type="button" aria-label="Hide the setup checklist" data-tip="Hide" onClick={() => void hide()} className="text-muted -mt-1 -mr-1 rounded-md p-1.5 hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
