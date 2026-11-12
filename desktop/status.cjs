'use strict';
/**
 * The work at a glance on the tray icon and the taskbar button (owner request 2026-11-12: “tray aur taskbar par
 * status”). From the dashboard's /api/work: whether new work is paused, and how many articles run, wait and need the
 * owner. Pure functions (tests/unit/desktop-status.test.ts); main.cjs applies them.
 */

const TITLE = 'Blog Automation Studio';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * @param {null | { paused: boolean, reason: 'manual'|'quiet'|null, until: string|null, running: number, queued: number,
 *   needsYou: number, progress: number|null }} w  /api/work (null: the dashboard did not answer)
 */
function workSummary(w) {
  if (!w) return { state: 'idle', tooltip: TITLE, line: 'Starting…', progress: -1, mode: 'none', overlay: null, paused: false, quiet: false };
  const parts = [];
  if (w.running) parts.push(`${plural(w.running, 'article')} running`);
  if (w.queued) parts.push(`${w.queued} waiting`);
  if (w.needsYou) parts.push(`${w.needsYou} need${w.needsYou === 1 ? 's' : ''} you`);
  const pause = w.paused ? (w.reason === 'quiet' ? `Quiet hours${w.until ? ` until ${clock(w.until)}` : ''}` : 'Paused') : null;
  const line = [pause, parts.length ? parts.join(' · ') : 'Nothing running'].filter(Boolean).join(' · ');
  const state = w.needsYou > 0 ? 'attention' : w.paused ? 'paused' : w.running > 0 ? 'busy' : 'idle';
  // The taskbar button: the running articles' progress (yellow while paused); nothing when none runs.
  const progress = w.running > 0 ? (typeof w.progress === 'number' ? Math.max(0.02, Math.min(1, w.progress / 100)) : 2) : -1;
  const mode = w.running > 0 ? (w.paused ? 'paused' : typeof w.progress === 'number' ? 'normal' : 'indeterminate') : 'none';
  return {
    state,
    tooltip: `${TITLE}\n${line}`.slice(0, 127),
    line,
    progress,
    mode,
    overlay: state === 'attention' ? 'attention' : state === 'paused' ? 'paused' : null,
    paused: Boolean(w.paused),
    quiet: w.reason === 'quiet',
  };
}

/** Whether the owner should be pointed at the app: more articles need them than before. */
const needsMore = (before, now) => Boolean(now && now.needsYou > ((before && before.needsYou) || 0));

module.exports = { workSummary, needsMore };
