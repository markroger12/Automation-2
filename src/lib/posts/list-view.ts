/**
 * The “Update to latest” list (owner request 2026-11-27: “yaha per filters toh add kr or sorting bhi add kr”): which of
 * the website's posts are shown, in which order, and how many posts each filter choice has. Pure, so it is tested
 * without a database; a website has at most 5,000 posts read (IMPORT_MAX_POSTS), so the list is filtered in memory.
 */

/** Where a post stands, from its latest update. */
export const UPDATE_STATES = ['none', 'working', 'ready', 'updated', 'no-change', 'attention', 'closed'] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

export const UPDATE_STATE_LABEL: Record<UpdateState, string> = {
  none: 'Not updated yet',
  working: 'In progress',
  ready: 'Ready for your approval',
  updated: 'Updated',
  'no-change': 'Nothing outdated',
  attention: 'Needs attention',
  closed: 'Rejected or undone',
};

const STATE_OF_STATUS: Record<string, UpdateState> = {
  QUEUED: 'working',
  WRITING: 'working',
  APPROVED: 'working',
  APPLYING: 'working',
  READY: 'ready',
  APPLIED: 'updated',
  NO_CHANGE: 'no-change',
  FAILED: 'attention',
  CONFLICT: 'attention',
  BLOCKED: 'attention',
  REJECTED: 'closed',
  UNDONE: 'closed',
};

export function updateState(lastStatus: string | null | undefined): UpdateState {
  return lastStatus ? (STATE_OF_STATUS[lastStatus] ?? 'none') : 'none';
}

export const POST_SORTS = ['changed-asc', 'changed-desc', 'published-desc', 'published-asc', 'title-asc', 'title-desc', 'words-desc', 'words-asc', 'update-desc', 'update-asc'] as const;
export type PostSort = (typeof POST_SORTS)[number];

export const POST_SORT_LABEL: Record<PostSort, string> = {
  'changed-asc': 'Last changed: oldest first',
  'changed-desc': 'Last changed: newest first',
  'published-desc': 'Published: newest first',
  'published-asc': 'Published: oldest first',
  'title-asc': 'Title: A to Z',
  'title-desc': 'Title: Z to A',
  'words-desc': 'Words: most first',
  'words-asc': 'Words: fewest first',
  'update-desc': 'Last update: newest first',
  'update-asc': 'Last update: oldest first',
};

export const POST_LENGTHS = ['short', 'medium', 'long'] as const;
export type PostLength = (typeof POST_LENGTHS)[number];
export const POST_LENGTH_LABEL: Record<PostLength, string> = { short: 'Under 600 words', medium: '600 to 1,500 words', long: 'Over 1,500 words' };

export const POST_SOURCES = ['app', 'other'] as const;
export type PostSource = (typeof POST_SOURCES)[number];
export const POST_SOURCE_LABEL: Record<PostSource, string> = { app: 'Written by the app', other: 'Not written by the app' };

/** “Not changed for” choices, in months. */
export const POST_AGES = [3, 6, 12, 24] as const;

/** “3 weeks ago”, “8 months ago”, “2 years 9 months ago”: readable for posts that are years old (not “1002d ago”). */
export function ageAgo(value: string | Date | null, now = Date.now()): string {
  if (!value) return '—';
  const days = Math.floor((now - new Date(value).getTime()) / 86_400_000);
  if (Number.isNaN(days)) return '—';
  if (days < 1) return 'today';
  if (days < 14) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  const months = Math.floor(days / 30.44);
  if (months < 24) return `${months} months ago`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return `${years} years${rest ? ` ${rest} ${rest === 1 ? 'month' : 'months'}` : ''} ago`;
}

export interface ListedPost {
  id: string;
  title: string;
  url: string;
  taskId: string | null;
  categoryIds: number[];
  words: number;
  publishedAt: Date | null;
  modifiedAt: Date | null;
  lastUpdate: { status: string; createdAt: Date } | null;
}

export interface PostView {
  q?: string | null;
  state?: UpdateState | null;
  olderThanMonths?: number | null;
  categoryId?: number | null;
  year?: number | null;
  length?: PostLength | null;
  source?: PostSource | null;
  sort?: PostSort | null;
}

const MONTH_MS = 30.44 * 86_400_000;

/** Lower case, without accents, so “dorthe” finds “Dörthe”. */
export function foldText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase();
}

export function lengthOf(words: number): PostLength {
  return words < 600 ? 'short' : words <= 1500 ? 'medium' : 'long';
}

type Test = (p: ListedPost) => boolean;

/** Every filter of the view except the ones named in `skip` (for the counts next to each choice). */
function tests(v: PostView, now: Date, skip: (keyof PostView)[] = []): Test[] {
  const out: Test[] = [];
  const on = (k: keyof PostView) => !skip.includes(k) && v[k] !== null && v[k] !== undefined && v[k] !== '';
  if (on('q')) {
    const words = foldText(String(v.q)).split(/\s+/).filter(Boolean);
    if (words.length) out.push((p) => {
      const hay = foldText(`${p.title} ${p.url}`);
      return words.every((w) => hay.includes(w));
    });
  }
  if (on('state')) out.push((p) => updateState(p.lastUpdate?.status) === v.state);
  if (on('olderThanMonths')) {
    const before = now.getTime() - Number(v.olderThanMonths) * MONTH_MS;
    out.push((p) => Boolean(p.modifiedAt && p.modifiedAt.getTime() < before));
  }
  if (on('categoryId')) out.push((p) => p.categoryIds.includes(Number(v.categoryId)));
  if (on('year')) out.push((p) => p.publishedAt?.getUTCFullYear() === Number(v.year));
  if (on('length')) out.push((p) => lengthOf(p.words) === v.length);
  if (on('source')) out.push((p) => (v.source === 'app' ? Boolean(p.taskId) : !p.taskId));
  return out;
}

const time = (d: Date | null | undefined) => (d ? d.getTime() : null);
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

/** Missing values (no date, no update) always go last, whichever the direction. */
function compare(a: ListedPost, b: ListedPost, sort: PostSort): number {
  const [key, dir] = sort.split('-') as [string, 'asc' | 'desc'];
  const sign = dir === 'asc' ? 1 : -1;
  if (key === 'title') return sign * collator.compare(a.title, b.title);
  if (key === 'words') return sign * (a.words - b.words);
  const pick = (p: ListedPost) => (key === 'changed' ? time(p.modifiedAt) : key === 'published' ? time(p.publishedAt) : time(p.lastUpdate?.createdAt));
  const x = pick(a);
  const y = pick(b);
  if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
  return sign * (x - y);
}

export function sortPosts<T extends ListedPost>(rows: T[], sort: PostSort = 'changed-asc'): T[] {
  return [...rows].sort((a, b) => compare(a, b, sort) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface PostFacets {
  /** Posts in each state, with every other filter applied. */
  states: Record<UpdateState | 'all', number>;
  /** Published years (newest first) and categories that have posts, with every other filter applied. */
  years: { year: number; count: number }[];
  categories: { id: number; count: number }[];
}

export function viewPosts<T extends ListedPost>(rows: T[], v: PostView, now = new Date()): { rows: T[]; facets: PostFacets } {
  const all = tests(v, now);
  const shown = sortPosts(
    rows.filter((p) => all.every((t) => t(p))),
    v.sort && (POST_SORTS as readonly string[]).includes(v.sort) ? v.sort : 'changed-asc',
  );

  const forStates = tests(v, now, ['state']);
  const states = Object.fromEntries([['all', 0], ...UPDATE_STATES.map((s) => [s, 0])]) as PostFacets['states'];
  for (const p of rows) {
    if (!forStates.every((t) => t(p))) continue;
    states.all++;
    states[updateState(p.lastUpdate?.status)]++;
  }

  const forYears = tests(v, now, ['year']);
  const years = new Map<number, number>();
  for (const p of rows) if (p.publishedAt && forYears.every((t) => t(p))) years.set(p.publishedAt.getUTCFullYear(), (years.get(p.publishedAt.getUTCFullYear()) ?? 0) + 1);

  const forCategories = tests(v, now, ['categoryId']);
  const categories = new Map<number, number>();
  for (const p of rows) if (forCategories.every((t) => t(p))) for (const c of new Set(p.categoryIds)) categories.set(c, (categories.get(c) ?? 0) + 1);

  return {
    rows: shown,
    facets: {
      states,
      years: [...years].sort((a, b) => b[0] - a[0]).map(([year, count]) => ({ year, count })),
      categories: [...categories].map(([id, count]) => ({ id, count })),
    },
  };
}
