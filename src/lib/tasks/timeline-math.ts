/** The live timeline's arithmetic (client-safe: no database). */

/** The median duration per step key, from at most `perKey` runs, for keys with at least `minRuns`. */
export function medianByKey(rows: { key: string; durationMs: number | null }[], perKey = 40, minRuns = 3): Record<string, number> {
  const byKey = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.durationMs || r.durationMs <= 0) continue;
    const list = byKey.get(r.key) ?? [];
    if (list.length < perKey) list.push(r.durationMs);
    byKey.set(r.key, list);
  }
  const out: Record<string, number> = {};
  for (const [key, list] of byKey) {
    if (list.length < minRuns) continue;
    const sorted = [...list].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    out[key] = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }
  return out;
}

export interface TimelineStage {
  key: string;
  status: string;
  startedAt: string | Date | null;
  durationMs: number | null;
}

/**
 * What is left, in ms: the rest of the running step (its estimate minus the time it has run, at least nothing) and the
 * estimates of the steps not started. Null when a step still to come has no estimate (then nothing is claimed).
 */
export function timeLeftMs(stages: TimelineStage[], estimates: Record<string, number>, now = Date.now()): number | null {
  let left = 0;
  for (const s of stages) {
    if (s.status === 'COMPLETED' || s.status === 'SKIPPED' || s.status === 'FAILED') continue;
    const est = estimates[s.key];
    if (est === undefined) return null;
    if (s.status === 'RUNNING' && s.startedAt) left += Math.max(0, est - (now - new Date(s.startedAt).getTime()));
    else left += est;
  }
  return left;
}
