/** Exponential backoff with a cap and ±10% jitter (deterministic when random=0.5). */
export function exponentialBackoffMs(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const jitter = 1 + (random() - 0.5) * 0.2;
  return Math.max(0, Math.round(Math.min(maxMs, exp * jitter)));
}

/** Step through a fixed schedule (e.g. 4s → 30s → 60s → 120s → 240s → 300s) and stay at the last step. */
export function scheduleBackoffMs(step: number, scheduleSec: number[]): number {
  if (scheduleSec.length === 0) return 0;
  const idx = Math.min(Math.max(0, step), scheduleSec.length - 1);
  return scheduleSec[idx] * 1000;
}

/** Parse an HTTP Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}
