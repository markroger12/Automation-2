'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
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
            <span className="mb-1 block text-xs text-zinc-500">Website</span>
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
            <div className="ml-auto text-xs text-zinc-500">
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
              <Link className="text-sm font-medium text-indigo-600" href="/workflow">
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

      {groups.map(([key, entries]) => (
        <Card key={key} title={dayLabel(entries[0].at)} padded={false}>
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {entries.map((e) => (
              <li key={`${e.websiteId}:${e.at}:${e.keywordId ?? 'free'}`} className={cx('flex flex-wrap items-center gap-3 px-4 py-2 text-sm', e.status === 'FREE' && 'text-zinc-400')}>
                <span className="w-20 shrink-0 font-mono text-xs">{timeLabel(e.at)}</span>
                <span className="w-40 shrink-0 truncate text-xs text-zinc-500" title={e.website}>
                  {e.website}
                </span>
                <span className="min-w-0 flex-1 truncate">{e.keyword ?? <em>free</em>}</span>
                <Chip tone={TONE[e.status] ?? 'neutral'}>{LABEL[e.status] ?? e.status.toLowerCase()}</Chip>
                <span className="flex gap-3 text-xs">
                  {e.taskId ? (
                    <Link className="text-indigo-600" href={`/articles/${e.taskId}`}>
                      Article
                    </Link>
                  ) : null}
                  {e.publishedUrl ? (
                    <a className="text-indigo-600" href={e.publishedUrl} target="_blank" rel="noreferrer">
                      Live post
                    </a>
                  ) : null}
                  <Link className="text-indigo-600" href={`/workflow?site=${e.websiteId}`}>
                    Queue
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </div>
  );
}
