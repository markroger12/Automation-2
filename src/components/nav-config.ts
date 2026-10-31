/**
 * Sidebar navigation in the owner's required order (spec 1S.4). Single Article
 * is a first-class item next to Bulk Campaigns. `soon` marks modules that are
 * genuinely not built yet; those pages say so instead of pretending to work.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: string;
  soon?: boolean;
  children?: NavItem[];
  /** Additional path prefixes that should highlight this item. */
  match?: string[];
  /** A heading shown above this item; it applies to the items after it (owner request: easier to find pages). */
  section?: string;
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Overview', icon: 'LayoutDashboard' },
  { href: '/single-article', label: 'Single Article', icon: 'PenLine', section: 'Articles' },
  { href: '/queue', label: 'Article Queue', icon: 'ListOrdered', match: ['/articles'] },
  { href: '/campaigns', label: 'Bulk Campaigns', icon: 'Layers' },
  { href: '/history', label: 'Article History', icon: 'History' },
  { href: '/writers', label: 'Writers', icon: 'Bot' },
  {
    href: '/websites',
    label: 'Websites',
    icon: 'Globe',
    section: 'Websites',
    children: [{ href: '/website-control', label: 'Website Control', icon: 'LayoutGrid' }],
  },
  { href: '/prompts', label: 'Prompt Manager', icon: 'MessageSquareText', section: 'Content tools' },
  {
    href: '/editorial',
    label: 'Editorial Tools',
    icon: 'Wand2',
    children: [
      { href: '/humanizer', label: 'Humanizer', icon: 'Sparkles' },
      { href: '/plagiarism', label: 'Plagiarism Evidence', icon: 'ScanSearch' },
      { href: '/research-evidence', label: 'Research Evidence', icon: 'BookCheck' },
      { href: '/duplicates', label: 'Duplicate Review', icon: 'Copy' },
      { href: '/content-refresh', label: 'Content Refresh', icon: 'RefreshCcw' },
    ],
  },
  {
    href: '/productivity',
    label: 'Productivity',
    icon: 'Gauge',
    section: 'Growth & publishing',
    children: [{ href: '/search-performance', label: 'Search Performance', icon: 'LineChart' }],
  },
  {
    href: '/workflow',
    label: 'Workflow / Calendar',
    icon: 'CalendarClock',
    children: [{ href: '/calendar', label: 'Publishing Calendar', icon: 'CalendarDays' }],
  },
  { href: '/image-templates', label: 'Image Template', icon: 'Image' },
  { href: '/settings', label: 'Settings', icon: 'Settings', section: 'System' },
  {
    href: '/diagnostics',
    label: 'Logs / Diagnostics',
    icon: 'Activity',
    children: [
      { href: '/logs', label: 'Logs', icon: 'ScrollText' },
      { href: '/recovery', label: 'Recovery Center', icon: 'LifeBuoy' },
      { href: '/automation-chrome', label: 'Automation Chrome', icon: 'AppWindow' },
      { href: '/help', label: 'Help / Setup', icon: 'CircleHelp' },
    ],
  },
];

/** Pages not yet built in the current milestone. Updated as milestones land. */
export const SOON_ROUTES = new Set<string>([]);

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
const queryWords = (query: string) => fold(query).split(/\s+/).filter(Boolean);
const pageHit = (item: NavItem, words: string[]) => words.every((w) => fold(`${item.label} ${item.href.replace(/[/-]/g, ' ')}`).includes(w));

/**
 * The menu filtered by a search (owner request: a search box above Overview). A section whose name matches keeps all
 * its pages; otherwise only its matching pages are kept (with the section). Case and accents are ignored.
 */
export function filterNav(items: NavItem[], query: string): NavItem[] {
  const words = queryWords(query);
  if (!words.length) return items;
  const hit = (item: NavItem) => pageHit(item, words);
  const out: NavItem[] = [];
  for (const item of items) {
    if (hit(item)) out.push(item);
    else {
      const children = (item.children ?? []).filter(hit);
      if (children.length) out.push({ ...item, children });
    }
  }
  return out;
}

/** The heading each top-level page belongs to (the last `section` before it, in menu order). */
export const NAV_SECTIONS: Record<string, string | null> = (() => {
  const out: Record<string, string | null> = {};
  let current: string | null = null;
  for (const item of NAV_ITEMS) {
    if (item.section) current = item.section;
    out[item.href] = current;
  }
  return out;
})();

export interface PageHit {
  href: string;
  label: string;
  icon: string;
  /** The page it sits under (“Editorial Tools” for Humanizer), if any. */
  parent?: string;
}

/**
 * The top bar's search (owner request: the reference dashboard's search with Ctrl+K): the pages that match, one per
 * line, in menu order. A page with sub-pages that matches brings its sub-pages too.
 */
export function searchPages(items: NavItem[], query: string): PageHit[] {
  const words = queryWords(query);
  if (!words.length) return [];
  return items.flatMap((item) => {
    const self = pageHit(item, words);
    const children = (item.children ?? []).filter((c) => self || pageHit(c, words));
    return [...(self ? [{ href: item.href, label: item.label, icon: item.icon }] : []), ...children.map((c) => ({ href: c.href, label: c.label, icon: c.icon, parent: item.label }))];
  });
}

/** The menu as groups: the items before the first heading, then one group per heading (Articles, Websites, …). */
export function navGroups(items: NavItem[]): { section: string | null; items: NavItem[] }[] {
  const groups: { section: string | null; items: NavItem[] }[] = [];
  for (const item of items) {
    const section = NAV_SECTIONS[item.href] ?? null;
    const last = groups[groups.length - 1];
    if (last && last.section === section) last.items.push(item);
    else groups.push({ section, items: [item] });
  }
  return groups;
}
