import { describe, expect, it } from 'vitest';
import { inQuietHours, pauseMessage, quietHoursEnd, workView } from '@/lib/work-pause';

const q = (from: string, to: string) => ({ quietHours: true, quietFrom: from, quietTo: to });
const at = (h: number, m = 0) => new Date(2026, 10, 12, h, m);

/** Owner request 2026-11-12: pause all work with one click, and quiet hours. */
describe('work pause and quiet hours', () => {
  it('quiet hours past midnight wrap; off, empty or equal times never hold', () => {
    expect(inQuietHours(q('23:00', '07:00'), at(23, 30))).toBe(true);
    expect(inQuietHours(q('23:00', '07:00'), at(3))).toBe(true);
    expect(inQuietHours(q('23:00', '07:00'), at(7))).toBe(false);
    expect(inQuietHours(q('23:00', '07:00'), at(12))).toBe(false);
    expect(inQuietHours(q('13:00', '15:00'), at(14))).toBe(true);
    expect(inQuietHours({ ...q('23:00', '07:00'), quietHours: false }, at(3))).toBe(false);
    expect(inQuietHours(q('08:00', '08:00'), at(8))).toBe(false);
    expect(quietHoursEnd(q('23:00', '07:00'), at(23, 30))!.getTime()).toBe(new Date(2026, 10, 13, 7, 0).getTime());
    expect(quietHoursEnd(q('23:00', '07:00'), at(3))!.getTime()).toBe(new Date(2026, 10, 12, 7, 0).getTime());
  });

  it('the pause switch is not overwritten by the count of articles that wait for a sign-in', () => {
    const v = workView(
      { paused: true, reason: 'manual', until: null },
      [
        { status: 'PAUSED', count: 0 },
        { status: 'WRITING_ARTICLE', count: 2 },
        { status: 'NEEDS_REVIEW', count: 1 },
        { status: 'QUEUED', count: 4 },
      ],
      [
        { status: 'WRITING_ARTICLE', percent: 40 },
        { status: 'RESEARCHING', percent: 20 },
        { status: 'NEEDS_REVIEW', percent: 90 },
      ],
    );
    expect(v).toMatchObject({ paused: true, reason: 'manual', queued: 4, running: 2, review: 1, pausedArticles: 0, needsYou: 1, progress: 30 });
    expect(v.message).toMatch(/paused/i);
    const open = workView({ paused: false, reason: null, until: null }, [{ status: 'LOGIN_REQUIRED', count: 3 }], []);
    expect(open).toMatchObject({ paused: false, pausedArticles: 3, needsYou: 3, progress: null, message: null });
    expect(pauseMessage({ paused: false, reason: null, until: null })).toBeNull();
  });
});
