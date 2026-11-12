import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { workSummary, needsMore } = require('../../desktop/status.cjs');

const work = (over: Record<string, unknown> = {}) => ({ paused: false, reason: null, until: null, running: 0, queued: 0, needsYou: 0, progress: null, ...over });

/** Owner request (2026-11-12): the work at a glance on the tray icon and the taskbar button. */
describe('tray and taskbar status', () => {
  it('nothing to do: the plain icon, no taskbar progress', () => {
    expect(workSummary(work())).toMatchObject({ state: 'idle', line: 'Nothing running', progress: -1, mode: 'none', overlay: null });
  });

  it('articles running: a green dot and their progress on the taskbar button', () => {
    const s = workSummary(work({ running: 2, queued: 3, progress: 40 }));
    expect(s).toMatchObject({ state: 'busy', line: '2 articles running · 3 waiting', progress: 0.4, mode: 'normal', overlay: null });
    expect(s.tooltip).toBe('Blog Automation Studio\n2 articles running · 3 waiting');
    expect(workSummary(work({ running: 1 }))).toMatchObject({ mode: 'indeterminate', line: '1 article running' });
  });

  it('something needs the owner: amber, and it wins over working and paused', () => {
    expect(workSummary(work({ running: 1, needsYou: 1, progress: 10 }))).toMatchObject({ state: 'attention', overlay: 'attention', line: '1 article running · 1 needs you' });
    expect(workSummary(work({ paused: true, reason: 'manual', needsYou: 2 }))).toMatchObject({ state: 'attention', line: 'Paused · 2 need you' });
  });

  it('paused by the owner or in the quiet hours: grey, a yellow taskbar bar while articles still finish', () => {
    expect(workSummary(work({ paused: true, reason: 'manual', running: 1, progress: 80 }))).toMatchObject({ state: 'paused', mode: 'paused', overlay: 'paused', paused: true, quiet: false });
    const quiet = workSummary(work({ paused: true, reason: 'quiet', until: new Date(2026, 10, 13, 7, 0).toISOString() }));
    expect(quiet).toMatchObject({ state: 'paused', quiet: true });
    expect(quiet.line).toMatch(/^Quiet hours until 0?7:00/);
  });

  it('the dashboard does not answer yet: no claims about the work', () => {
    expect(workSummary(null)).toMatchObject({ state: 'idle', line: 'Starting…', mode: 'none' });
  });

  it('the taskbar button flashes only when more articles need the owner than before', () => {
    expect(needsMore(work({ needsYou: 0 }), work({ needsYou: 1 }))).toBe(true);
    expect(needsMore(work({ needsYou: 2 }), work({ needsYou: 1 }))).toBe(false);
    expect(needsMore(null, work({ needsYou: 1 }))).toBe(true);
    expect(needsMore(work({ needsYou: 1 }), null)).toBe(false);
  });
});
