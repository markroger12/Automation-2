/** Pure measurement helpers for the productivity analytics (no database access). */

export const TARGET_PER_HOUR = 6;
const MIN = 60_000;

/** Nearest-rank percentile (p in 0–100) of a list; null when empty. */
export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * s.length);
  return s[Math.min(s.length, Math.max(1, rank)) - 1];
}

/** Verified drafts in the last N minutes (end inclusive), and the rate per hour. */
export function rollingWindows(times: Date[], now: Date, windows = [15, 60, 120]) {
  return windows.map((minutes) => {
    const from = now.getTime() - minutes * MIN;
    const count = times.filter((t) => t.getTime() > from && t.getTime() <= now.getTime()).length;
    return { minutes, count, perHour: Math.round((count / (minutes / 60)) * 10) / 10 };
  });
}

/** Calendar day of a timestamp in a time zone (YYYY-MM-DD). */
export function dayIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

export type BenchmarkClaim = 'PASS' | 'FAIL' | 'SUSPENDED' | 'NO_WORK';

export interface Benchmark {
  windows: { from: string; to: string; count: number }[];
  claim: BenchmarkClaim;
  /** Conditions that make a missed target “temporarily unattainable” rather than a failure. */
  conditions: string[];
  explanation: string;
}

/**
 * The owner's acceptance target: at least 6 verified drafts in EACH of the
 * two consecutive 60-minute windows before `now`. A miss is only called a
 * failure when nothing outside the tool's control (ChatGPT limits, logins,
 * human checks, a stopped worker) interfered; otherwise the claim is
 * suspended with the reasons. No work at all is not a failure either.
 */
export function evaluateBenchmark(verified: Date[], now: Date, conditions: string[], hadWork: boolean): Benchmark {
  const w2 = { from: new Date(now.getTime() - 60 * MIN), to: now };
  const w1 = { from: new Date(now.getTime() - 120 * MIN), to: w2.from };
  const count = (w: { from: Date; to: Date }) => verified.filter((t) => t > w.from && t <= w.to).length;
  const windows = [w1, w2].map((w) => ({ from: w.from.toISOString(), to: w.to.toISOString(), count: count(w) }));
  const met = windows.every((w) => w.count >= TARGET_PER_HOUR);
  let claim: BenchmarkClaim;
  let explanation: string;
  if (met) {
    claim = 'PASS';
    explanation = `${windows[0].count} and ${windows[1].count} verified drafts in the two consecutive hours (target ${TARGET_PER_HOUR} each).`;
  } else if (conditions.length) {
    claim = 'SUSPENDED';
    explanation = `Target temporarily unattainable: ${conditions.join('; ')}.`;
  } else if (!hadWork) {
    claim = 'NO_WORK';
    explanation = 'No articles were queued or running in these two hours, so there is nothing to measure.';
  } else {
    claim = 'FAIL';
    explanation = `${windows[0].count} and ${windows[1].count} verified drafts in the two consecutive hours; the target is ${TARGET_PER_HOUR} in each.`;
  }
  return { windows, claim, conditions, explanation };
}
