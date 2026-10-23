'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
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
  Search,
  Wand2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { NAV_ITEMS, NAV_SECTIONS, SOON_ROUTES, filterNav, type NavItem } from './nav-config';
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
        depth > 0 && 'py-1 text-[13px]',
        active ? 'bg-indigo-50 font-semibold text-indigo-700 dark:bg-indigo-950 dark:text-indigo-200' : 'text-muted hover:bg-[var(--surface-2)] hover:text-[var(--text)]',
      )}
    >
      <Icon className={cx('shrink-0', depth > 0 ? 'h-3.5 w-3.5' : 'h-4 w-4')} aria-hidden />
      <span className="truncate">{item.label}</span>
      {soon ? (
        <span className="ml-auto rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-slate-600 dark:bg-slate-800 dark:text-slate-300" title="Not built yet in this milestone">
          soon
        </span>
      ) : null}
    </Link>
  );
}

export function Sidebar() {
  const pathname = usePathname() ?? '/';
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const close = () => {
    setOpen(false);
    setQuery('');
  };
  // Owner request: a search box above Overview — it filters the menu, and finds articles by keyword.
  const items = filterNav(NAV_ITEMS, query);
  const firstPage = items[0] ? (items[0].children?.length && items[0].children.length < (NAV_ITEMS.find((n) => n.href === items[0].href)?.children?.length ?? 0) ? items[0].children[0] : items[0]) : null;
  const articlesHref = `/history?q=${encodeURIComponent(query.trim())}`;
  // Ctrl+K (or “/” outside a text field) jumps to the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable);
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setOpen(true);
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
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
        <div className="px-3 pt-1">
          <label className="surface-2 flex items-center gap-2 rounded-lg px-2.5 py-1.5">
            <Search className="text-muted h-4 w-4 shrink-0" aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
                if (e.key === 'Enter' && query.trim()) {
                  e.preventDefault();
                  router.push(firstPage ? firstPage.href : articlesHref);
                  close();
                }
              }}
              placeholder="Search pages and articles"
              aria-label="Search pages and articles (Ctrl+K)"
              title="Ctrl+K"
              className="w-full bg-transparent text-sm outline-none placeholder:text-[var(--text-muted)]"
            />
          </label>
        </div>
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 py-2">
          {query.trim() && !items.length ? <p className="text-muted px-2.5 py-1 text-xs">No page matches.</p> : null}
          {query.trim().length >= 2 ? (
            <Link href={articlesHref} onClick={close} className="text-muted flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-[var(--surface-2)] hover:text-[var(--text)]">
              <Search className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">Articles: “{query.trim()}”</span>
            </Link>
          ) : null}
          {items.map((item, i) => {
            // A heading where a new part of the menu starts (Articles, Websites, Content tools, …).
            const section = NAV_SECTIONS[item.href] ?? null;
            const heading = section && (i === 0 || NAV_SECTIONS[items[i - 1].href] !== section) ? section : null;
            return (
              <div key={item.href}>
                {heading ? <p className="text-muted px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider">{heading}</p> : null}
                <NavLink item={item} pathname={pathname} depth={0} onNavigate={close} />
                {item.children?.length ? (
                  <div className="border-app mb-1 ml-[18px] space-y-0.5 border-l pl-2">
                    {item.children.map((child) => (
                      <NavLink key={child.href} item={child} pathname={pathname} depth={1} onNavigate={close} />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </nav>
        <div className="border-app flex items-center justify-between border-t px-4 py-2.5">
          <span className="text-muted text-[11px]">Private · runs on this PC only</span>
          <ThemeToggle />
        </div>
      </aside>
    </>
  );
}
