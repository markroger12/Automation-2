'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import {
  Activity,
  AppWindow,
  BookCheck,
  Bot,
  CalendarClock,
  CalendarDays,
  CircleHelp,
  Copy,
  Gauge,
  Globe,
  History,
  Image,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  LifeBuoy,
  LineChart,
  ListOrdered,
  Menu,
  MessageSquareText,
  PenLine,
  RefreshCcw,
  ScanSearch,
  ScrollText,
  Settings,
  Sparkles,
  Wand2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { NAV_ITEMS, SOON_ROUTES, type NavItem } from './nav-config';
import { cx } from './ui';
import { ThemeToggle } from './client';

const ICONS: Record<string, LucideIcon> = {
  Activity,
  AppWindow,
  BookCheck,
  Bot,
  CalendarClock,
  CalendarDays,
  CircleHelp,
  Copy,
  Gauge,
  Globe,
  History,
  Image,
  Layers,
  LayoutDashboard,
  LayoutGrid,
  LifeBuoy,
  LineChart,
  ListOrdered,
  MessageSquareText,
  PenLine,
  RefreshCcw,
  ScanSearch,
  ScrollText,
  Settings,
  Sparkles,
  Wand2,
};

function isActive(pathname: string, item: NavItem): boolean {
  if (item.href === '/') return pathname === '/';
  if (pathname === item.href || pathname.startsWith(item.href + '/')) return true;
  return (item.match ?? []).some((m) => pathname === m || pathname.startsWith(m + '/'));
}

function NavLink({ item, pathname, depth, onNavigate }: { item: NavItem; pathname: string; depth: number; onNavigate: () => void }) {
  const Icon = ICONS[item.icon] ?? LayoutDashboard;
  const active = isActive(pathname, item);
  const soon = SOON_ROUTES.has(item.href);
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'group flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition',
        depth > 0 && 'ml-4 py-1 text-[13px]',
        active ? 'bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200' : 'text-muted hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
      )}
    >
      <Icon className={cx('shrink-0', depth > 0 ? 'h-3.5 w-3.5' : 'h-4 w-4')} aria-hidden />
      <span className="truncate">{item.label}</span>
      {soon ? (
        <span className="ml-auto rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-slate-500 dark:bg-slate-800 dark:text-slate-400" title="Not built yet in this milestone">
          soon
        </span>
      ) : null}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <>
      <div className="surface border-app sticky top-0 z-30 flex items-center gap-3 border-b px-4 py-2.5 lg:hidden">
        <button type="button" aria-label="Open navigation" onClick={() => setOpen(true)} className="rounded-lg p-1.5 hover:bg-[var(--surface-2)]">
          <Menu className="h-5 w-5" />
        </button>
        <span className="text-sm font-semibold">Blog Automation Studio</span>
      </div>
      {open ? <div className="fixed inset-0 z-40 bg-black/30 lg:hidden" onClick={close} aria-hidden /> : null}
      <aside
        className={cx(
          'surface border-app fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r transition-transform lg:sticky lg:top-0 lg:h-screen lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        aria-label="Main navigation"
      >
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <Link href="/" className="flex items-center gap-2" onClick={close}>
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-indigo-600 text-sm font-bold text-white">BA</span>
            <span className="leading-tight">
              <span className="block text-sm font-semibold">Blog Automation</span>
              <span className="text-muted block text-[11px]">Studio 3.0 · local</span>
            </span>
          </Link>
          <button type="button" aria-label="Close navigation" onClick={close} className="rounded-lg p-1 lg:hidden">
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
          {NAV_ITEMS.map((item) => (
            <div key={item.href}>
              <NavLink item={item} pathname={pathname} depth={0} onNavigate={close} />
              {item.children?.map((child) => (
                <NavLink key={child.href} item={child} pathname={pathname} depth={1} onNavigate={close} />
              ))}
            </div>
          ))}
        </nav>
        <div className="border-app flex items-center justify-between border-t px-4 py-2.5">
          <span className="text-muted text-[11px]">Private · runs on this PC only</span>
          <ThemeToggle />
        </div>
      </aside>
    </>
  );
}
