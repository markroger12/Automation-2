'use client';

import { useEffect, useState } from 'react';
import { ArrowRight, CalendarClock } from 'lucide-react';
import { api } from '@/lib/client/api';
import { Button, Modal, useToast } from '@/components/client';
import { Input } from '@/components/form';
import { cx } from '@/components/ui';
import { formatInZone, zonedParts } from '@/lib/workflow/time';

interface PlanRow {
  id: string;
  keyword: string;
  status: string;
  from: string | null;
  to: string;
}
interface MoveResult {
  changed: number;
  plan: PlanRow[];
  notes: string[];
}

/** YYYY-MM-DD of today + `plus` days in the slot time zone. */
function dayIn(tz: string, plus: number): string {
  const p = zonedParts(new Date(), tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day + plus)).toISOString().slice(0, 10);
}
const dayLabel = (d: string) => new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));

/**
 * Workflow → selected keywords → Move to day (owner request: one keyword had moved to tomorrow, “all of them on
 * tomorrow”). Shows the new slots before anything changes; a post already scheduled in WordPress gets its new time
 * there through the app's scheduling path.
 */
export function MoveKeywords({ open, onClose, siteId, keywordIds, timezone, onMoved }: { open: boolean; onClose: () => void; siteId: string; keywordIds: string[]; timezone: string; onMoved: () => void }) {
  const toast = useToast();
  // The days are worked out again each time the window opens (it may stay mounted past midnight).
  const [today, setToday] = useState(() => dayIn(timezone, 0));
  const [date, setDate] = useState(() => dayIn(timezone, 1));
  const [preview, setPreview] = useState<MoveResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const ids = keywordIds.join(',');

  useEffect(() => {
    if (!open) return;
    setToday(dayIn(timezone, 0));
    setDate(dayIn(timezone, 1));
  }, [open, timezone]);
  const plusDays = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const quick = [
    { label: 'Tomorrow', date: plusDays(1) },
    { label: 'Day after', date: plusDays(2) },
    { label: 'Today', date: today },
  ];

  useEffect(() => {
    if (!open || !date || !ids) return;
    let stale = false;
    setLoading(true);
    setError(null);
    api<MoveResult>(`/api/websites/${siteId}/workflow/keywords/action`, { body: { keywordIds: ids.split(','), action: 'move', date, dryRun: true } })
      .then((r) => !stale && setPreview(r))
      .catch((e: Error) => {
        if (stale) return;
        setPreview(null);
        setError(e.message);
      })
      .finally(() => !stale && setLoading(false));
    return () => {
      stale = true;
    };
  }, [open, date, ids, siteId]);

  async function move() {
    setBusy(true);
    try {
      const r = await api<MoveResult>(`/api/websites/${siteId}/workflow/keywords/action`, { body: { keywordIds: keywordIds, action: 'move', date } });
      const scheduled = r.plan.filter((p) => p.status === 'SCHEDULED').length;
      toast(r.notes.length ? 'info' : 'success', `${r.changed} keyword(s) moved to ${dayLabel(date)}.${scheduled ? ` ${scheduled} post(s) get the new time in WordPress in a moment.` : ''}${r.notes.length ? ` ${r.notes.slice(0, 2).join(' ')}` : ''}`);
      onMoved();
      onClose();
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const plan = preview?.plan ?? [];
  const spills = plan.filter((p) => p.to.slice(0, 10) !== plan[0]?.to.slice(0, 10)).length;
  return (
    <Modal
      open={open}
      onClose={onClose}
      width={640}
      title={`Move ${keywordIds.length} keyword(s) to another day`}
      description="They take that day's free publishing slots, in queue order (Pakistan time)."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={loading || !plan.length} onClick={() => void move()}>
            <CalendarClock className="h-4 w-4" /> Move {plan.length || ''} to {dayLabel(date)}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div role="radiogroup" aria-label="Day" className="surface-2 flex gap-1 rounded-lg p-1">
            {quick.map((q) => (
              <button
                key={q.label}
                type="button"
                role="radio"
                aria-checked={date === q.date}
                onClick={() => setDate(q.date)}
                className={cx('h-8 rounded-md px-3 text-sm font-medium transition', date === q.date ? 'surface border shadow-sm' : 'text-muted hover:text-[var(--text)]')}
              >
                {q.label} <span className="text-muted font-normal">· {dayLabel(q.date)}</span>
              </button>
            ))}
          </div>
          <label className="text-muted flex items-center gap-2 text-sm">
            or
            <Input type="date" aria-label="Day" className="h-9 w-40!" min={today} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </label>
        </div>

        {error ? <p className="rounded-lg border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">{error}</p> : null}

        <div className="border-app overflow-hidden rounded-lg border">
          <table className="w-full text-sm">
            <thead className="surface-2 text-muted text-left text-xs">
              <tr>
                <th className="px-3 py-2 font-medium">Keyword</th>
                <th className="px-3 py-2 font-medium">Now (PK)</th>
                <th className="px-3 py-2 font-medium" aria-label="becomes" />
                <th className="px-3 py-2 font-medium">New slot (PK)</th>
              </tr>
            </thead>
            <tbody className={cx('divide-y divide-[var(--border)]', loading && 'opacity-60')}>
              {plan.map((p) => (
                <tr key={p.id}>
                  <td className="max-w-56 px-3 py-2">
                    <span className="block truncate font-medium" title={p.keyword}>
                      {p.keyword}
                    </span>
                    {p.status === 'SCHEDULED' ? <span className="text-muted block text-xs">time in WordPress changes too</span> : null}
                  </td>
                  <td className="text-muted px-3 py-2 whitespace-nowrap">{p.from ? formatInZone(p.from, timezone) : 'not started'}</td>
                  <td className="text-muted px-1 py-2">
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                  </td>
                  <td className="px-3 py-2 font-medium whitespace-nowrap">{formatInZone(p.to, timezone)}</td>
                </tr>
              ))}
              {!plan.length && !loading ? (
                <tr>
                  <td colSpan={4} className="text-muted px-3 py-4 text-center">
                    {error ? 'Nothing to move.' : 'None of the selected keywords can be moved.'}
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {spills ? <p className="text-muted text-xs">That day has fewer free slots than keywords: {spills} go to the next day(s).</p> : null}
        {preview?.notes.length ? (
          <ul className="list-disc space-y-1 pl-5 text-xs text-amber-700 dark:text-amber-400">
            {preview.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : null}
        <p className="text-muted text-xs">Articles already being written go on; they wait for their new slot. Keywords not started yet begin within the write-ahead time before theirs. A move by you does not count as one of the automatic moves.</p>
      </div>
    </Modal>
  );
}
