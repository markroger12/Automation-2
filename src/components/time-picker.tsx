'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Clock } from 'lucide-react';
import { cx } from './ui';
import { formatSlot, parseSlot } from '@/lib/workflow/time';

/**
 * Time field with the app's own picker (owner request: pickers in the app's look, like the calendar). Value as the
 * workflow slots are written: 'h:mm AM' / 'h:mm PM', or ''. Hour, minute and AM/PM columns; every minute can be chosen.
 */

const HOURS = Array.from({ length: 12 }, (_, i) => i + 1);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

export function TimePicker({ value, onChange, ariaLabel, placeholder = 'Pick a time', className }: { value: string; onChange: (value: string) => void; ariaLabel: string; placeholder?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialogId = useId();
  const parsed = parseSlot(value);
  const hour24 = parsed?.hour ?? 9;
  const minute = parsed?.minute ?? 0;
  const pm = hour24 >= 12;
  const hour12 = hour24 % 12 || 12;

  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    // Show the chosen hour and minute in their columns.
    root.current?.querySelectorAll<HTMLElement>('[aria-pressed="true"]').forEach((el) => el.scrollIntoView({ block: 'center' }));
    return () => document.removeEventListener('mousedown', outside);
  }, [open]);

  const set = (h12: number, m: number, isPm: boolean) => onChange(formatSlot((h12 % 12) + (isPm ? 12 : 0), m));
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const cell = (selected: boolean) => cx('w-full rounded-md px-2 py-1 text-center text-sm tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400', selected ? 'bg-[var(--primary)] font-semibold text-[var(--primary-fg)]' : 'hover:bg-black/5 dark:hover:bg-white/10');

  return (
    <div ref={root} className={cx('relative inline-block', className)}>
      <button
        ref={trigger}
        type="button"
        aria-label={`${ariaLabel}: ${value || 'no time'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => setOpen((o) => !o)}
        className="surface flex w-full items-center gap-2 rounded-lg border py-1.5 pl-2.5 pr-2.5 text-left text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900"
      >
        <Clock className="text-muted h-4 w-4 shrink-0" aria-hidden />
        <span className={cx('min-w-[5rem] flex-1 whitespace-nowrap', !value && 'text-muted')}>{value || placeholder}</span>
      </button>
      {open ? (
        <div
          id={dialogId}
          role="dialog"
          aria-label={ariaLabel}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              close();
            }
          }}
          className="surface absolute left-0 top-full z-50 mt-1 w-60 rounded-xl border p-2 shadow-[0_12px_32px_rgba(0,0,0,0.28)]"
        >
          <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
            <div>
              <p className="text-muted px-1 pb-1 text-[11px] font-medium">Hour</p>
              <div className="max-h-48 space-y-0.5 overflow-y-auto pr-0.5">
                {HOURS.map((h) => (
                  <button key={h} type="button" aria-pressed={parsed ? h === hour12 : false} aria-label={`${h} o'clock`} onClick={() => set(h, minute, pm)} className={cell(Boolean(parsed) && h === hour12)}>
                    {h}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-muted px-1 pb-1 text-[11px] font-medium">Minute</p>
              <div className="max-h-48 space-y-0.5 overflow-y-auto pr-0.5">
                {MINUTES.map((m) => (
                  <button key={m} type="button" aria-pressed={parsed ? m === minute : false} aria-label={`${m} minutes`} onClick={() => set(hour12, m, pm)} className={cell(Boolean(parsed) && m === minute)}>
                    {String(m).padStart(2, '0')}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="text-muted px-1 pb-1 text-[11px] font-medium">&nbsp;</p>
              <div className="space-y-0.5">
                {(['AM', 'PM'] as const).map((p) => (
                  <button key={p} type="button" aria-pressed={parsed ? (p === 'PM') === pm : false} onClick={() => set(hour12, minute, p === 'PM')} className={cell(Boolean(parsed) && (p === 'PM') === pm)}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="border-app mt-2 flex items-center justify-between border-t pt-2 text-sm">
            <span className="tabular-nums">{value || '—'}</span>
            <button type="button" onClick={close} className="rounded-md px-2 py-1 font-medium hover:bg-black/5 dark:hover:bg-white/10">
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
