'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  AppWindow,
  Bell,
  BookCheck,
  Bot,
  CalendarClock,
  CalendarDays,
  ChevronDown,
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
  PanelLeft,
  PenLine,
  RefreshCcw,
  ScanSearch,
  ScrollText,
  Search,
  Settings,
  Sparkles,
  User,
  Wand2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { NAV_ITEMS, SOON_ROUTES, navGroups, searchPages, type NavItem } from './nav-config';
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

/** A health warning shown under the bell (the same ones as the banner at the top of the page). */
export interface Notice {
  tone: 'warning' | 'danger' | 'info';
  title: string;
  detail: string;
  href?: string;
  action?: string;
}

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
      title={item.label}
      className={cx(
        'group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition lg:collapsed:justify-center lg:collapsed:px-0',
        depth > 0 && 'text-[13px]',
        active ? 'bg-[var(--nav-active)] font-medium text-[var(--text)]' : 'text-[color-mix(in_oklab,var(--text)_78%,transparent)] hover:bg-[var(--nav-active)] hover:text-[var(--text)]',
      )}
    >
      <Icon className={cx('shrink-0', depth > 0 ? 'h-3.5 w-3.5 lg:collapsed:h-4 lg:collapsed:w-4' : 'h-4 w-4')} aria-hidden />
      <span className="truncate lg:collapsed:sr-only">{item.label}</span>
      {soon ? (
        <span className="ml-auto rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-slate-600 lg:collapsed:hidden dark:bg-slate-800 dark:text-slate-300" title="Not built yet in this milestone">
          soon
        </span>
      ) : null}
    </Link>
  );
}

const CLOSED_KEY = 'bas-nav-closed';

/** The menu on the left: groups that fold (their state is remembered), and a narrow icon rail when collapsed. */
export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname() ?? '/';
  const [closed, setClosed] = useState<string[]>([]);
  useEffect(() => {
    try {
      setClosed(JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]') as string[]);
    } catch {
      /* storage unavailable */
    }
  }, []);
  const toggle = (section: string) =>
    setClosed((c) => {
      const next = c.includes(section) ? c.filter((s) => s !== section) : [...c, section];
      try {
        localStorage.setItem(CLOSED_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  return (
    <>
      {open ? <div className="fixed inset-0 z-40 bg-black/40 lg:hidden" onClick={onClose} aria-hidden /> : null}
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-50 flex w-64 flex-col bg-[var(--bg)] transition-[translate,width] lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 lg:collapsed:w-[60px]',
          open ? 'border-app translate-x-0 border-r' : '-translate-x-full',
        )}
        aria-label="Main navigation"
      >
        <div className="flex h-14 shrink-0 items-center gap-2 px-3">
          <Link href="/" className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md p-1 hover:bg-[var(--nav-active)]" onClick={onClose} title="Blog Automation Studio">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-[var(--primary)] text-xs font-bold text-[var(--primary-fg)]">BA</span>
            <span className="min-w-0 leading-tight lg:collapsed:sr-only">
              <span className="block truncate text-sm font-semibold">Blog Automation</span>
              <span className="text-muted block text-[11px]">Studio 3.0 · local</span>
            </span>
          </Link>
          <button type="button" aria-label="Close navigation" onClick={onClose} className="rounded-md p-1 hover:bg-[var(--surface-2)] lg:hidden">
            <X className="h-5 w-5" />
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-3">
          {navGroups(NAV_ITEMS).map((group) => {
            // The group of the page you are on stays open.
            const folded = group.section !== null && closed.includes(group.section) && !group.items.some((i) => isActive(pathname, i) || (i.children ?? []).some((c) => isActive(pathname, c)));
            return (
              <div key={group.section ?? 'top'} className={group.section ? 'mt-3 lg:collapsed:border-app lg:collapsed:mt-2 lg:collapsed:border-t lg:collapsed:pt-2' : ''}>
                {group.section ? (
                  <button
                    type="button"
                    aria-expanded={!folded}
                    onClick={() => toggle(group.section!)}
                    className="text-muted flex w-full items-center justify-between rounded-md px-2.5 py-1 text-xs font-medium hover:text-[var(--text)] lg:collapsed:hidden"
                  >
                    {group.section}
                    <ChevronDown className={cx('h-3.5 w-3.5 transition', folded && '-rotate-90')} aria-hidden />
                  </button>
                ) : null}
                <div className={cx('mt-0.5 space-y-0.5', folded && 'hidden lg:collapsed:block')}>
                  {group.items.map((item) => (
                    <div key={item.href}>
                      <NavLink item={item} pathname={pathname} depth={0} onNavigate={onClose} />
                      {item.children?.length ? (
                        <div className="border-app mb-1 ml-[18px] mt-0.5 space-y-0.5 border-l pl-2 lg:collapsed:ml-0 lg:collapsed:border-l-0 lg:collapsed:pl-0">
                          {item.children.map((child) => (
                            <NavLink key={child.href} item={child} pathname={pathname} depth={1} onNavigate={onClose} />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </nav>
        <div className="flex shrink-0 items-center gap-2.5 px-3 py-3 lg:collapsed:justify-center lg:collapsed:px-0">
          <span className="surface-2 grid h-8 w-8 shrink-0 place-items-center rounded-full lg:collapsed:hidden" aria-hidden>
            <User className="h-4 w-4" />
          </span>
          <span className="min-w-0 flex-1 leading-tight lg:collapsed:hidden">
            <span className="block truncate text-sm font-medium">Owner</span>
            <span className="text-muted block truncate text-[11px]">Runs on this PC only</span>
          </span>
          <ThemeToggle />
        </div>
      </aside>
    </>
  );
}

/** The top bar's search (Ctrl+K or “/”): pages by name, and articles by keyword in Article History. */
function SearchBox() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [openList, setOpenList] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const q = query.trim();
  const hits = searchPages(NAV_ITEMS, q).slice(0, 8);
  const options = [...hits.map((h) => ({ href: h.href, label: h.label, parent: h.parent, icon: h.icon })), ...(q.length >= 2 ? [{ href: `/history?q=${encodeURIComponent(q)}`, label: `Articles: “${q}”`, parent: 'Article History', icon: 'Search' }] : [])];
  const go = (href: string) => {
    router.push(href);
    setQuery('');
    setOpenList(false);
    ref.current?.blur();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable);
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpenList(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, []);
  return (
    <div ref={box} className="relative w-full max-w-sm">
      <label className="surface border-app flex h-9 items-center gap-2 rounded-md border px-2.5">
        <Search className="text-muted h-4 w-4 shrink-0" aria-hidden />
        <input
          ref={ref}
          type="search"
          role="combobox"
          aria-expanded={openList && Boolean(q)}
          aria-controls="top-search-list"
          aria-activedescendant={openList && options[active] ? `top-search-${active}` : undefined}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpenList(true);
          }}
          onFocus={() => setOpenList(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setQuery('');
              setOpenList(false);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, options.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter' && options[active]) {
              e.preventDefault();
              go(options[active].href);
            }
          }}
          placeholder="Search pages and articles"
          aria-label="Search pages and articles (Ctrl+K)"
          className="w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-[var(--text-muted)]"
        />
        <kbd className="hidden shrink-0 sm:inline">Ctrl K</kbd>
      </label>
      {openList && q ? (
        <ul id="top-search-list" role="listbox" aria-label="Search results" className="surface border-app absolute top-full left-0 z-50 mt-1 w-full overflow-hidden rounded-lg border p-1 shadow-xl">
          {options.length === 0 ? <li className="text-muted px-2.5 py-2 text-sm">No page matches.</li> : null}
          {options.map((o, i) => {
            const Icon = ICONS[o.icon] ?? Search;
            return (
              <li
                key={o.href}
                id={`top-search-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  go(o.href);
                }}
                className={cx('flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm', i === active && 'bg-[var(--surface-2)]')}
              >
                <Icon className="text-muted h-4 w-4 shrink-0" aria-hidden />
                <span className="truncate">{o.label}</span>
                {o.parent ? <span className="text-muted ml-auto truncate text-xs">{o.parent}</span> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** The bell: the dashboard's health warnings (worker, extension, WordPress sign-ins), with their links. */
function Notifications({ notices }: { notices: Notice[] }) {
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
  const danger = notices.some((n) => n.tone === 'danger');
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={notices.length ? `Notifications (${notices.length})` : 'Notifications'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative grid h-9 w-9 place-items-center rounded-md hover:bg-[var(--surface-2)]"
      >
        <Bell className="h-[18px] w-[18px]" aria-hidden />
        {notices.length ? (
          <span className={cx('absolute top-1 right-1 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] font-semibold text-white', danger ? 'bg-rose-600' : 'bg-amber-600')}>{notices.length}</span>
        ) : null}
      </button>
      {open ? (
        <div className="surface border-app absolute top-full right-0 z-50 mt-1 w-[min(380px,calc(100vw-2rem))] rounded-lg border shadow-xl">
          <div className="border-app border-b px-4 py-2.5 text-sm font-semibold">Notifications</div>
          {notices.length === 0 ? (
            <p className="text-muted px-4 py-4 text-sm">Nothing needs you right now.</p>
          ) : (
            <ul className="max-h-[60vh] divide-y divide-[var(--border)] overflow-y-auto">
              {notices.map((n, i) => (
                <li key={i} className="flex gap-3 px-4 py-3 text-sm">
                  <span className={cx('mt-1.5 h-2 w-2 shrink-0 rounded-full', n.tone === 'danger' ? 'bg-rose-500' : n.tone === 'warning' ? 'bg-amber-500' : 'bg-sky-500')} aria-hidden />
                  <div className="min-w-0">
                    <div className="font-medium">{n.title}</div>
                    <div className="text-muted text-xs">{n.detail}</div>
                    {n.href ? (
                      <Link href={n.href} onClick={() => setOpen(false)} className="mt-1 inline-block text-xs font-medium underline underline-offset-2">
                        {n.action ?? 'Open'}
                      </Link>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

const COLLAPSED_KEY = 'bas-sidebar';

/**
 * The dashboard's frame (owner request, after the reference dashboard): the menu on the left, a top bar with the
 * search and the notifications, and the page in a rounded panel. The menu can be folded to icons (remembered).
 */
export function Shell({ notices, children }: { notices: Notice[]; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  useEffect(() => setOpen(false), [pathname]);
  const toggleCollapsed = () => {
    const collapsed = !document.documentElement.classList.contains('sb-collapsed');
    document.documentElement.classList.toggle('sb-collapsed', collapsed);
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? 'collapsed' : 'open');
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <div className="min-h-screen bg-[var(--bg)] lg:flex">
      <Sidebar open={open} onClose={() => setOpen(false)} />
      <div className="flex min-h-screen min-w-0 flex-1 flex-col lg:pr-2 lg:pb-2">
        <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 bg-[var(--bg)] px-3 lg:px-1">
          <button type="button" aria-label="Open navigation" onClick={() => setOpen(true)} className="grid h-9 w-9 place-items-center rounded-md hover:bg-[var(--surface-2)] lg:hidden">
            <Menu className="h-5 w-5" />
          </button>
          <button type="button" aria-label="Collapse or expand the menu" data-tip="Menu" onClick={toggleCollapsed} className="hidden h-9 w-9 shrink-0 place-items-center rounded-md hover:bg-[var(--surface-2)] lg:grid">
            <PanelLeft className="h-[18px] w-[18px]" aria-hidden />
          </button>
          <SearchBox />
          <div className="ml-auto flex items-center gap-1">
            <Notifications notices={notices} />
          </div>
        </header>
        <div className="surface border-app flex-1 border-t lg:rounded-xl lg:border">{children}</div>
      </div>
    </div>
  );
}
