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
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/', label: 'Overview', icon: 'LayoutDashboard' },
  { href: '/single-article', label: 'Single Article', icon: 'PenLine' },
  { href: '/queue', label: 'Article Queue', icon: 'ListOrdered', match: ['/articles'] },
  { href: '/campaigns', label: 'Bulk Campaigns', icon: 'Layers' },
  { href: '/history', label: 'Article History', icon: 'History' },
  { href: '/writers', label: 'Writers', icon: 'Bot' },
  {
    href: '/websites',
    label: 'Websites',
    icon: 'Globe',
    children: [{ href: '/website-control', label: 'Website Control', icon: 'LayoutGrid' }],
  },
  { href: '/prompts', label: 'Prompt Manager', icon: 'MessageSquareText' },
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
    children: [{ href: '/search-performance', label: 'Search Performance', icon: 'LineChart' }],
  },
  {
    href: '/workflow',
    label: 'Workflow / Calendar',
    icon: 'CalendarClock',
    children: [{ href: '/calendar', label: 'Publishing Calendar', icon: 'CalendarDays' }],
  },
  { href: '/image-templates', label: 'Image Template', icon: 'Image' },
  { href: '/settings', label: 'Settings', icon: 'Settings' },
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
export const SOON_ROUTES = new Set<string>([
  '/website-control',
  '/research-evidence',
  '/duplicates',
  '/content-refresh',
  '/productivity',
  '/search-performance',
]);
