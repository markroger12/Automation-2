import { formatInZone } from './time';

/**
 * The workflow keyword queue as the page shows it (owner request: “I have to scroll so much”): a search, a status
 * filter, and Google's long answers made short enough for one line.
 */
export const KEYWORD_STATUSES = ['WAITING', 'WRITING', 'READY', 'SCHEDULED', 'PUBLISHED', 'INDEXING_REQUESTED', 'INDEXED', 'FAILED', 'SKIPPED', 'DONE'] as const;

export const KEYWORD_LABEL: Record<string, string> = {
  WAITING: 'waiting',
  WRITING: 'writing',
  READY: 'draft ready',
  SCHEDULED: 'scheduled',
  PUBLISHED: 'published',
  INDEXING_REQUESTED: 'indexing requested',
  INDEXED: 'indexed (verified)',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  DONE: 'draft kept (publish yourself)',
};

export interface QueueFilter {
  q: string;
  /** Empty: every status. */
  statuses: string[];
}

export function filterKeywords<T extends { keyword: string; status: string; secondaryKeywords?: string[] }>(rows: T[], filter: QueueFilter): T[] {
  const words = filter.q.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((k) => {
    if (filter.statuses.length && !filter.statuses.includes(k.status)) return false;
    const text = `${k.keyword} ${(k.secondaryKeywords ?? []).join(' ')}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export function statusCounts(rows: { status: string }[]): Record<string, number> {
  const c: Record<string, number> = {};
  for (const k of rows) c[k.status] = (c[k.status] ?? 0) + 1;
  return c;
}

const ISO = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/g;

/** Google's answers carry UTC times such as 2026-10-24T13:02:36Z; they are shown as Pakistan time, as the slots are. */
export function readableTimes(text: string, tz: string): string {
  return text.replace(ISO, (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : `${formatInZone(d, tz)} PK`;
  });
}
