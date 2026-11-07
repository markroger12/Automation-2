'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cx } from './ui';

/**
 * Date field with the app's own calendar (owner report: the browser's date popup ignores the dark theme and cannot
 * be styled). Same value as `<input type="date">`: '' or 'YYYY-MM-DD', in local days, no time zone shifts.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const toIso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`;
function parseIso(v: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  return match ? { y: Number(match[1]), m: Number(match[2]) - 1, d: Number(match[3]) } : null;
}
function todayIso(): string {
  const t = new Date();
  return toIso(t.getFullYear(), t.getMonth(), t.getDate());
}
function shiftDay(iso: string, days: number): string {
  const p = parseIso(iso)!;
  const d = new Date(p.y, p.m, p.d + days);
  return toIso(d.getFullYear(), d.getMonth(), d.getDate());
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const MONTH = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
const LONG = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function DatePicker({
  value,
  onChange,
  ariaLabel,
  placeholder = 'Choose a date',
  className,
  min,
  max,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  className?: string;
  min?: string;
  max?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = parseIso(value);
  const [view, setView] = useState(() => {
    const base = selected ?? parseIso(todayIso())!;
    return { y: base.y, m: base.m };
  });
  const [focus, setFocus] = useState(value || todayIso());
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const dialogId = useId();

  useEffect(() => {
    if (!open) return;
    const base = parseIso(value) ?? parseIso(todayIso())!;
    setView({ y: base.y, m: base.m });
    setFocus(value || todayIso());
    const outside = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
    // Only when it opens: later value changes come from this picker itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Keep keyboard focus on the focused day while the calendar is open.
  useEffect(() => {
    if (open) grid.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus();
  }, [open, focus, view]);

  const days = useMemo(() => {
    const first = new Date(view.y, view.m, 1);
    const start = new Date(view.y, view.m, 1 - first.getDay());
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      return { iso: toIso(d.getFullYear(), d.getMonth(), d.getDate()), day: d.getDate(), inMonth: d.getMonth() === view.m, date: d };
    });
  }, [view]);

  const allowed = (iso: string) => (!min || iso >= min) && (!max || iso <= max);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const choose = (iso: string) => {
    if (!allowed(iso)) return;
    onChange(iso);
    close();
  };
  const moveMonth = (delta: number) => setView((v) => ({ y: new Date(v.y, v.m + delta, 1).getFullYear(), m: new Date(v.y, v.m + delta, 1).getMonth() }));
  const moveFocus = (days: number) => {
    const next = shiftDay(focus, days);
    const p = parseIso(next)!;
    if (p.y !== view.y || p.m !== view.m) setView({ y: p.y, m: p.m });
    setFocus(next);
  };
  const onKey = (e: KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowLeft: () => moveFocus(-1),
      ArrowRight: () => moveFocus(1),
      ArrowUp: () => moveFocus(-7),
      ArrowDown: () => moveFocus(7),
      PageUp: () => moveMonth(-1),
      PageDown: () => moveMonth(1),
      Escape: close,
    };
    if (keys[e.key]) {
      e.preventDefault();
      keys[e.key]();
    }
  };
  const today = todayIso();

  return (
    <div ref={root} className={cx('relative inline-block', className)}>
      <button
        ref={trigger}
        type="button"
        aria-label={`${ariaLabel}: ${selected ? LONG.format(new Date(selected.y, selected.m, selected.d)) : 'no date'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={cx('surface flex w-full items-center gap-2 rounded-lg border py-1.5 pl-2.5 text-left text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-200 dark:focus:ring-indigo-900', value ? 'pr-7' : 'pr-2.5')}
      >
        <CalendarDays className="text-muted h-4 w-4 shrink-0" aria-hidden />
        <span className={cx('min-w-[6.5rem] flex-1 whitespace-nowrap', !selected && 'text-muted')}>{selected ? SHORT.format(new Date(selected.y, selected.m, selected.d)) : placeholder}</span>
      </button>
      {value ? (
        <button type="button" aria-label={`Clear ${ariaLabel}`} onClick={() => onChange('')} className="text-muted absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 hover:text-[var(--text)]">
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
      {open ? (
        <div id={dialogId} role="dialog" aria-label={ariaLabel} onKeyDown={onKey} className="surface absolute left-0 top-full z-50 mt-1 w-64 rounded-xl border p-3 shadow-[0_12px_32px_rgba(0,0,0,0.28)]">
          <div className="mb-2 flex items-center justify-between">
            <button type="button" aria-label="Previous month" onClick={() => moveMonth(-1)} className="text-muted rounded-md p-1 hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <span className="text-sm font-semibold" aria-live="polite">
              {MONTH.format(new Date(view.y, view.m, 1))}
            </span>
            <button type="button" aria-label="Next month" onClick={() => moveMonth(1)} className="text-muted rounded-md p-1 hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <div className="text-muted mb-1 grid grid-cols-7 text-center text-[11px] font-medium" aria-hidden>
            {WEEKDAYS.map((w) => (
              <span key={w}>{w}</span>
            ))}
          </div>
          <div ref={grid} role="grid" aria-label={MONTH.format(new Date(view.y, view.m, 1))} className="grid grid-cols-7 gap-0.5">
            {days.map((d) => {
              const isSelected = d.iso === value;
              const ok = allowed(d.iso);
              return (
                <button
                  key={d.iso}
                  type="button"
                  data-day={d.iso}
                  tabIndex={d.iso === focus ? 0 : -1}
                  disabled={!ok}
                  aria-label={LONG.format(d.date)}
                  aria-pressed={isSelected}
                  onClick={() => choose(d.iso)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      choose(d.iso);
                    }
                  }}
                  className={cx(
                    'h-8 rounded-md text-sm tabular-nums transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:cursor-not-allowed disabled:opacity-30',
                    isSelected ? 'bg-[var(--primary)] font-semibold text-[var(--primary-fg)]' : d.inMonth ? 'hover:bg-black/5 dark:hover:bg-white/10' : 'text-muted opacity-60 hover:bg-black/5 dark:hover:bg-white/10',
                    !isSelected && d.iso === today && 'ring-1 ring-inset ring-indigo-400',
                  )}
                >
                  {d.day}
                </button>
              );
            })}
          </div>
          <div className="border-app mt-2 flex items-center justify-between border-t pt-2 text-sm">
            <button
              type="button"
              onClick={() => {
                onChange('');
                close();
              }}
              className="rounded-md px-2 py-1 font-medium hover:bg-black/5 dark:hover:bg-white/10"
            >
              Clear
            </button>
            <button type="button" disabled={!allowed(today)} onClick={() => choose(today)} className="rounded-md px-2 py-1 font-medium hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10">
              Today
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
