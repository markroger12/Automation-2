'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { Button } from './client';
import { buttonClasses, cx } from './ui';
import { PAGE_SIZES, clampPage, pageCount, pageSlice } from '@/lib/pagination';

/**
 * Pieces for long lists (owner request: “I have to scroll so much”, with a reference dashboard's table): pages with
 * “Results per page” and “Page 1 of N”, and small Filter / View menus.
 */
export { PAGE_SIZES, clampPage, pageCount, pageSlice };

/** The page size of one list, remembered in this browser. */
export function usePageSize(key: string, initial: number = 20): [number, (n: number) => void] {
  const [size, setSize] = useState(initial);
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(`bas:page-size:${key}`));
      if ((PAGE_SIZES as readonly number[]).includes(saved)) setSize(saved);
    } catch {
      /* storage unavailable */
    }
  }, [key]);
  return [
    size,
    (n: number) => {
      setSize(n);
      try {
        localStorage.setItem(`bas:page-size:${key}`, String(n));
      } catch {
        /* storage unavailable */
      }
    },
  ];
}

export function Pagination({ total, page, pageSize, onPage, onPageSize, label = 'results' }: { total: number; page: number; pageSize: number; onPage: (p: number) => void; onPageSize: (n: number) => void; label?: string }) {
  const pages = pageCount(total, pageSize);
  const current = clampPage(page, total, pageSize);
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 text-sm">
      <span className="text-muted tabular-nums">
        {total} {total === 1 ? label.replace(/s$/, '') : label}
      </span>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <label className="flex items-center gap-2">
          <span className="font-medium">Results per page</span>
          <select
            value={pageSize}
            onChange={(e) => {
              onPageSize(Number(e.target.value));
              onPage(1);
            }}
            className="surface h-9 rounded-md border px-2.5 text-sm"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <span className="font-medium tabular-nums">
          Page {current} of {pages}
        </span>
        <div className="flex items-center gap-1">
          <Button size="icon" tip="First page" disabled={current <= 1} onClick={() => onPage(1)}>
            <ChevronsLeft className="h-4 w-4" aria-hidden />
          </Button>
          <Button size="icon" tip="Previous page" disabled={current <= 1} onClick={() => onPage(current - 1)}>
            <ChevronLeft className="h-4 w-4" aria-hidden />
          </Button>
          <Button size="icon" tip="Next page" disabled={current >= pages} onClick={() => onPage(current + 1)}>
            <ChevronRight className="h-4 w-4" aria-hidden />
          </Button>
          <Button size="icon" tip="Last page" disabled={current >= pages} onClick={() => onPage(pages)}>
            <ChevronsRight className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** A button with a small panel under it (Filter, View, More): closes on a click outside or Escape. */
export function Menu({ label, icon, children, align = 'start', badge, variant = 'secondary', tip }: { label: ReactNode; icon?: ReactNode; children: (close: () => void) => ReactNode; align?: 'start' | 'end'; badge?: ReactNode; variant?: 'secondary' | 'ghost'; tip?: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={box} className="relative">
      <button type="button" aria-expanded={open} aria-haspopup="true" data-tip={tip} onClick={() => setOpen((o) => !o)} className={buttonClasses(variant, 'sm')}>
        {icon}
        {label}
        {badge}
      </button>
      {open ? (
        <div className={cx('surface border-app absolute top-full z-40 mt-1 min-w-52 rounded-lg border p-1 shadow-xl', align === 'end' ? 'right-0' : 'left-0')}>{children(() => setOpen(false))}</div>
      ) : null}
    </div>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="text-muted px-2 pt-1.5 pb-1 text-[11px] font-semibold uppercase tracking-wider">{children}</div>;
}

export function MenuCheck({ checked, onChange, children, count }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; count?: number }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--surface-2)] has-[:focus-visible]:bg-[var(--surface-2)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[color-mix(in_oklab,var(--text)_40%,transparent)]">
      <input type="checkbox" className="sr-only" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className={cx('grid h-4 w-4 shrink-0 place-items-center rounded border', checked ? 'border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-fg)]' : 'border-app')} aria-hidden>
        {checked ? <Check className="h-3 w-3" /> : null}
      </span>
      <span className="flex-1">{children}</span>
      {count !== undefined ? <span className="text-muted text-xs tabular-nums">{count}</span> : null}
    </label>
  );
}

export function MenuItem({ onClick, children, icon, tone, title, disabled }: { onClick: () => void; children: ReactNode; icon?: ReactNode; tone?: 'danger'; title?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--surface-2)] disabled:opacity-50', tone === 'danger' && 'text-rose-600 dark:text-rose-400')}
    >
      {icon}
      {children}
    </button>
  );
}
