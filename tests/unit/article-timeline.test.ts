import { describe, expect, it } from 'vitest';
import { medianByKey, timeLeftMs } from '@/lib/tasks/timeline-math';

/** Owner request (2026-11-12): a live timeline per article, with what is left judged by this computer's own articles. */
describe('article timeline estimates', () => {
  it('the median of the finished runs of each step; fewer than 3 runs: no estimate', () => {
    const rows = [
      { key: 'RESEARCH', durationMs: 60_000 },
      { key: 'RESEARCH', durationMs: 120_000 },
      { key: 'RESEARCH', durationMs: 90_000 },
      { key: 'WRITE', durationMs: 300_000 },
      { key: 'WRITE', durationMs: 200_000 },
      { key: 'IMAGES', durationMs: 0 },
    ];
    expect(medianByKey(rows)).toEqual({ RESEARCH: 90_000 });
    expect(medianByKey([...rows, { key: 'WRITE', durationMs: 100_000 }, { key: 'WRITE', durationMs: 400_000 }])).toEqual({ RESEARCH: 90_000, WRITE: 250_000 });
  });

  it('what is left: the rest of the running step and the steps to come', () => {
    const now = Date.parse('2026-11-12T12:00:00Z');
    const stages = [
      { key: 'RESEARCH', status: 'COMPLETED', startedAt: null, durationMs: 80_000 },
      { key: 'WRITE', status: 'RUNNING', startedAt: new Date(now - 60_000).toISOString(), durationMs: null },
      { key: 'IMAGES', status: 'PENDING', startedAt: null, durationMs: null },
      { key: 'SKIPPED_ONE', status: 'SKIPPED', startedAt: null, durationMs: null },
    ];
    expect(timeLeftMs(stages, { WRITE: 240_000, IMAGES: 120_000 }, now)).toBe(180_000 + 120_000);
    // A running step past its usual time counts as nothing left (never negative).
    expect(timeLeftMs(stages, { WRITE: 30_000, IMAGES: 120_000 }, now)).toBe(120_000);
  });

  it('a step to come without an estimate: no time left is claimed', () => {
    expect(timeLeftMs([{ key: 'NEW', status: 'PENDING', startedAt: null, durationMs: null }], {}, Date.now())).toBeNull();
  });
});
