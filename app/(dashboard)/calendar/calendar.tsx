'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button } from '@/components/client';
import { Select } from '@/components/form';
import { Alert, Card, Chip, EmptyState, cx, type ChipTone } from '@/components/ui';
import { DEFAULT_SLOT_TIMEZONE, zonedParts, zonedTimeToUtc } from '@/lib/workflow/time';

interface Entry {
  at: string;
  websiteId: string;
  website: string;
  keywordId: string | null;
  keyword: string | null;
  status: string;
  taskId: string | null;
  publishedUrl: string | null;
}
interface CalendarData {
  from: string;
  to: string;
  timezone: string;
  entries: Entry[];
  sites: { id: string; name: string; active: boolean; publishing: boolean }[];
}

const DAYS = 14;
const TZ = DEFAULT_SLOT_TIMEZONE;
const TONE: Record<string, ChipTone> = { FREE: 'neutral', WAITING: 'neutral', WRITING: 'info', READY: 'brand', SCHEDULED: 'brand', PUBLISHED: 'success', INDEXING_REQUESTED: 'success', INDEXED: 'success', DONE: 'neutral', FAILED: 'danger', SKIPPED: 'neutral' };
/** Slot colours: the left edge of each slot, and the legend. */
const BORDER: Record<string, string> = { FREE: 'border-l-zinc-300 dark:border-l-zinc-600', WAITING: 'border-l-zinc-400', WRITING: 'border-l-sky-500', READY: 'border-l-indigo-500', SCHEDULED: 'border-l-violet-500', PUBLISHED: 'border-l-emerald-500', INDEXING_REQUESTED: 'border-l-emerald-500', INDEXED: 'border-l-emerald-600', DONE: 'border-l-zinc-500', FAILED: 'border-l-rose-500', SKIPPED: 'border-l-zinc-300' };
const DOT: Record<string, string> = { FREE: 'border border-dashed border-zinc-400', WAITING: 'bg-zinc-400', WRITING: 'bg-sky-500', READY: 'bg-indigo-500', SCHEDULED: 'bg-violet-500', PUBLISHED: 'bg-emerald-500', FAILED: 'bg-rose-500' };
const LEGEND: [string, string][] = [['FREE', 'free'], ['WAITING', 'waiting'], ['WRITING', 'writing'], ['READY', 'draft ready'], ['SCHEDULED', 'scheduled'], ['PUBLISHED', 'published / indexed (verified)'], ['FAILED', 'failed']];
const LABEL: Record<string, string> = { FREE: 'free slot', WAITING: 'waiting', WRITING: 'writing', READY: 'draft ready', SCHEDULED: 'scheduled in WordPress', PUBLISHED: 'published (verified)', INDEXING_REQUESTED: 'indexing requested', INDEXED: 'indexed (verified)', DONE: 'draft kept (publish yourself)', FAILED: 'failed', SKIPPED: 'skipped' };

/** Midnight (Pakistan time) of the day `offset` days from today, as an instant. */
function dayStart(offset: number): Date {
  const p = zonedParts(new Date(), TZ);
  const anchor = new Date(Date.UTC(p.year, p.month - 1, p.day + offset, 12));
  return zonedTimeToUtc(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, anchor.getUTCDate(), 0, 0, TZ);
}
const dayKey = (iso: string) => {
  const p = zonedParts(new Date(iso), TZ);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};
const dayLabel = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(iso));
const timeLabel = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));

export function PublishingCalendar() {
  const [offset, setOffset] = useState(0);
  const [siteId, setSiteId] = useState('');
  const [showFree, setShowFree] = useState(true);
  const [data, setData] = useState<CalendarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<CalendarData>(`/api/calendar?from=${encodeURIComponent(dayStart(offset).toISOString())}&days=${DAYS}`));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const e of data?.entries ?? []) {
      if (siteId && e.websiteId !== siteId) continue;
      if (!showFree && e.status === 'FREE') continue;
      const k = dayKey(e.at);
      map.set(k, [...(map.get(k) ?? []), e]);
    }
    return [...map.entries()];
  }, [data, siteId, showFree]);

  // The two weeks as days (Pakistan time), each with its slots.
  const days = useMemo(() => {
    if (!data) return [];
    const first = new Date(data.from).getTime();
    const today = dayKey(new Date().toISOString());
    return Array.from({ length: DAYS }, (_, i) => {
      const iso = new Date(first + i * 86_400_000 + 12 * 3600_000).toISOString();
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(new Date(iso));
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
      return { key: dayKey(iso), weekday: get('weekday'), date: `${get('day')} ${get('month')}`, long: dayLabel(iso), today: dayKey(iso) === today };
    });
  }, [data]);
  const byDay = useMemo(() => new Map(groups), [groups]);
  const multiSite = !siteId && (data?.sites.length ?? 0) > 1;

  const draftOnly = useMemo(() => (data?.sites ?? []).filter((s) => !s.publishing && (!siteId || s.id === siteId)), [data, siteId]);

  const counts = useMemo(() => {
    const visible = (data?.entries ?? []).filter((e) => !siteId || e.websiteId === siteId);
    return { reserved: visible.filter((e) => e.status !== 'FREE').length, free: visible.filter((e) => e.status === 'FREE').length };
  }, [data, siteId]);

  return (
    <div className="space-y-4">
      <Card padded>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex items-center gap-1">
            <Button variant="secondary" onClick={() => setOffset((o) => o - DAYS)} aria-label="Previous two weeks">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="secondary" onClick={() => setOffset(0)} disabled={offset === 0}>
              Today
            </Button>
            <Button variant="secondary" onClick={() => setOffset((o) => o + DAYS)} aria-label="Next two weeks">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          <label className="text-sm">
            <span className="text-muted mb-1 block text-xs">Website</span>
            <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="Website">
              <option value="">All websites with a workflow</option>
              {data?.sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.active ? '' : ' (paused)'}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={showFree} onChange={(e) => setShowFree(e.target.checked)} />
            Show free slots
          </label>
          <Button variant="ghost" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cx('h-4 w-4', loading && 'animate-spin')} /> Refresh
          </Button>
          {data ? (
            <div className="text-muted ml-auto text-xs">
              {dayLabel(data.from)} – {dayLabel(new Date(new Date(data.to).getTime() - 1).toISOString())} · {counts.reserved} reserved · {counts.free} free · times in Pakistan ({TZ})
            </div>
          ) : null}
        </div>
      </Card>

      {error ? <Alert tone="danger" title="Could not load the calendar">{error}</Alert> : null}

      {data && data.sites.length === 0 ? (
        <Card>
          <EmptyState
            title="No workflows yet"
            description="Slots come from a website’s workflow. Set one up first."
            action={
              <Link className="text-sm font-medium underline" href="/workflow">
                Open Workflow
              </Link>
            }
          />
        </Card>
      ) : null}

      {draftOnly.length ? (
        <Alert tone="info" title={draftOnly.length === 1 ? 'Draft-only website' : 'Draft-only websites'}>
          {draftOnly.map((s) => s.name).join(', ')} {draftOnly.length === 1 ? 'does' : 'do'} not allow publishing: {draftOnly.length === 1 ? 'its' : 'their'} slots fill with verified drafts that you publish yourself. Nothing is published there automatically.
        </Alert>
      ) : null}

      {data && data.sites.length > 0 && groups.length === 0 ? (
        <Card>
          <EmptyState title="Nothing in these two weeks" description={showFree ? 'No reserved or free slots in this range (paused workflows have no free slots).' : 'No reserved slots in this range.'} />
        </Card>
      ) : null}

      {data && data.sites.length > 0 && groups.length > 0 ? (
        <>
          <div className="text-muted flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-label="Colours">
            {LEGEND.map(([status, label]) => (
              <span key={status} className="inline-flex items-center gap-1.5">
                <span className={cx('h-2.5 w-2.5 rounded-sm', DOT[status])} aria-hidden /> {label}
              </span>
            ))}
          </div>
          {[0, 7].map((weekStart) => (
            <div key={weekStart} className="grid gap-3 sm:grid-cols-2 md:grid-cols-4 xl:grid-cols-7">
              {days.slice(weekStart, weekStart + 7).map((day) => {
                const entries = byDay.get(day.key) ?? [];
                return (
                  <section key={day.key} className={cx('surface flex min-w-0 flex-col rounded-xl border', day.today && 'ring-2 ring-[var(--primary)]/30')} aria-label={day.long}>
                    <header className="border-app flex items-baseline justify-between gap-2 border-b px-3 py-2">
                      <span className="text-sm font-semibold">
                        {day.weekday} <span className="text-muted font-normal">{day.date}</span>
                      </span>
                      {day.today ? <Chip tone="brand">today</Chip> : entries.length ? <span className="text-muted text-[11px]">{entries.filter((e) => e.status !== 'FREE').length}/{entries.length}</span> : null}
                    </header>
                    <ul className="flex flex-1 flex-col gap-1.5 p-2">
                      {entries.length === 0 ? <li className="text-muted px-1 py-2 text-xs">No slots</li> : null}
                      {entries.map((e) => (
                        <li key={`${e.websiteId}:${e.at}:${e.keywordId ?? 'free'}`}>
                          <Link
                            href={e.taskId ? `/articles/${e.taskId}` : `/workflow?site=${e.websiteId}`}
                            title={`${timeLabel(e.at)} · ${e.website} · ${e.keyword ?? 'free slot'} — ${LABEL[e.status] ?? e.status.toLowerCase()}`}
                            className={cx(
                              'block rounded-md border-l-4 px-2 text-xs transition hover:bg-[var(--surface-2)]',
                              e.status === 'FREE' ? 'py-1' : 'py-1.5',
                              e.status === 'FREE' ? 'border-app text-muted border border-l-4 border-dashed' : 'bg-[color-mix(in_oklab,var(--surface-2)_60%,transparent)]',
                              BORDER[e.status] ?? 'border-l-zinc-400',
                            )}
                          >
                            <span className="flex items-center justify-between gap-2">
                              <span className="font-mono text-[11px] font-medium">{timeLabel(e.at)}</span>
                              {e.status === 'FREE' ? <span className="text-[11px]">free</span> : null}
                              {e.publishedUrl ? <ExternalLink className="h-3 w-3 shrink-0" aria-label="published" /> : null}
                            </span>
                            {e.status === 'FREE' ? null : <span className={cx('mt-0.5 line-clamp-2 break-words font-medium text-[var(--text)]', e.status === 'SKIPPED' && 'line-through')}>{e.keyword}</span>}
                            {multiSite ? <span className="text-muted mt-0.5 block truncate text-[10px]">{e.website}</span> : null}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
