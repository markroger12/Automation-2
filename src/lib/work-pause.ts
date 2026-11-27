import { getSettings, getValue } from './settings';
import { statusGroup } from './domain';

/** The one switch that pauses new work (owner request 2026-11-12: “pause all with one click”). */
export const CLAIMS_PAUSED_KEY = 'extension.claimsPaused';

/** Quiet hours: no new prompts and no indexing requests between `quietFrom` and `quietTo` (this computer's clock). */
export interface QuietHours {
  quietHours: boolean;
  quietFrom: string;
  quietTo: string;
}

const minutesOf = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
};

/** Whether `now` (local time) falls in the quiet hours; a range past midnight (23:00–07:00) wraps. */
export function inQuietHours(q: QuietHours, now = new Date()): boolean {
  if (!q.quietHours) return false;
  const from = minutesOf(q.quietFrom);
  const to = minutesOf(q.quietTo);
  if (from === null || to === null || from === to) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return from < to ? t >= from && t < to : t >= from || t < to;
}

/** When the quiet hours that hold at `now` end (the next `quietTo`, local time). */
export function quietHoursEnd(q: QuietHours, now = new Date()): Date | null {
  const to = minutesOf(q.quietTo);
  if (to === null) return null;
  const end = new Date(now);
  end.setHours(Math.floor(to / 60), to % 60, 0, 0);
  if (end.getTime() <= now.getTime()) end.setDate(end.getDate() + 1);
  return end;
}

export interface WorkPause {
  paused: boolean;
  /** `manual`: the owner's switch; `quiet`: the quiet hours. */
  reason: 'manual' | 'quiet' | null;
  /** When the quiet hours end (ISO), for `quiet`. */
  until: string | null;
}

/**
 * Whether new work may start now. While paused, no new ChatGPT prompt is handed out and no indexing request is made;
 * prompts already running finish, and everything waits in the queue (nothing is lost).
 */
export async function workPause(now = new Date()): Promise<WorkPause> {
  const [manual, settings] = await Promise.all([getValue<boolean>(CLAIMS_PAUSED_KEY, false), getSettings()]);
  if (manual) return { paused: true, reason: 'manual', until: null };
  if (inQuietHours(settings.workflow, now)) return { paused: true, reason: 'quiet', until: quietHoursEnd(settings.workflow, now)?.toISOString() ?? null };
  return { paused: false, reason: null, until: null };
}

/** The pause in words, for the agents and the dashboard. */
export function pauseMessage(p: WorkPause): string | null {
  if (!p.paused) return null;
  if (p.reason === 'quiet') return `Quiet hours${p.until ? ` until ${new Date(p.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}: new work starts after them.`;
  return 'Work is paused: new prompts and indexing requests wait until you resume.';
}

/**
 * The work at a glance for /api/work (the top bar's pause button, the desktop app's tray and taskbar). `paused` is the
 * pause switch; the articles that wait for a sign-in or a limit are `pausedArticles` (counted in `needsYou`).
 */
export function workView(pause: WorkPause, byStatus: { status: string; count: number }[], open: { status: string; percent: number | null }[]) {
  const count = { queued: 0, running: 0, review: 0, paused: 0 };
  for (const r of byStatus) {
    const group = statusGroup(r.status);
    if (group in count) count[group as keyof typeof count] += r.count;
  }
  const active = open.filter((t) => statusGroup(t.status) === 'running');
  return {
    ...pause,
    message: pauseMessage(pause),
    queued: count.queued,
    running: count.running,
    review: count.review,
    pausedArticles: count.paused,
    /** Articles that wait for the owner: review or approval, a sign-in or a check, a usage limit. */
    needsYou: count.review + count.paused,
    /** How far the running articles are, on average (0–100), from their own progress; null when none runs. */
    progress: active.length ? Math.round(active.reduce((sum, t) => sum + (t.percent || 0), 0) / active.length) : null,
  };
}
