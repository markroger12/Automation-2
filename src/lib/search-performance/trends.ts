/**
 * 7/28/90-day windows over Search Console's daily totals (upgrade 10).
 * Search Console days are calendar days in Pacific Time; they are kept as
 * the exported YYYY-MM-DD strings and counted with UTC date arithmetic, so a
 * window never shifts with the computer's own time zone. A window reports how
 * many of its days have data; a change is only computed when both windows
 * are complete.
 */

export interface DailyPoint {
  date: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

export interface WindowStats {
  days: number;
  start: string;
  end: string;
  /** Days of the window that have data. */
  covered: number;
  clicks: number;
  impressions: number;
  /** Percent (clicks / impressions × 100). */
  ctr: number | null;
  /** Impression-weighted average position. */
  position: number | null;
}

export interface Trend {
  days: number;
  current: WindowStats;
  previous: WindowStats | null;
  clicksChangePct: number | null;
  impressionsChangePct: number | null;
}

export function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function windowStats(byDate: Map<string, DailyPoint>, end: string, days: number): WindowStats {
  const start = addDays(end, -(days - 1));
  let covered = 0;
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  let weight = 0;
  for (let i = 0; i < days; i++) {
    const p = byDate.get(addDays(start, i));
    if (!p) continue;
    covered++;
    clicks += p.clicks;
    impressions += p.impressions;
    if (p.position != null && p.impressions > 0) {
      weighted += p.position * p.impressions;
      weight += p.impressions;
    }
  }
  return { days, start, end, covered, clicks, impressions, ctr: impressions ? Math.round((clicks / impressions) * 10_000) / 100 : null, position: weight ? Math.round((weighted / weight) * 10) / 10 : null };
}

const pct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

export function trends(points: DailyPoint[], windows: number[] = [7, 28, 90]): { latest: string | null; trends: Trend[] } {
  if (!points.length) return { latest: null, trends: [] };
  const byDate = new Map(points.map((p) => [p.date, p]));
  const latest = [...byDate.keys()].sort().at(-1)!;
  return {
    latest,
    trends: windows.map((days) => {
      const current = windowStats(byDate, latest, days);
      const prevStats = windowStats(byDate, addDays(latest, -days), days);
      const previous = prevStats.covered ? prevStats : null;
      const complete = previous && current.covered === days && previous.covered === days;
      return {
        days,
        current,
        previous,
        clicksChangePct: complete ? pct(current.clicks, previous.clicks) : null,
        impressionsChangePct: complete ? pct(current.impressions, previous.impressions) : null,
      };
    }),
  };
}
