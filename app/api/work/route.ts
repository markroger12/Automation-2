import { z } from 'zod';
import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { setValue } from '@/lib/settings';
import { audit } from '@/lib/audit';
import { CLAIMS_PAUSED_KEY, workPause, workView } from '@/lib/work-pause';

/**
 * The work at a glance (owner request 2026-11-12): whether new work is paused (the owner's switch or the quiet hours),
 * and how many articles are running, waiting and need the owner. The top bar's pause button and the desktop app's
 * tray icon and taskbar read it.
 */
async function state() {
  const [pause, rows, running] = await Promise.all([
    workPause(),
    db.articleTask.groupBy({ by: ['status'], _count: { _all: true } }),
    db.articleTask.findMany({ where: { status: { notIn: ['QUEUED', 'FAILED', 'CANCELLED'] }, completedAt: null }, select: { status: true, percent: true } }),
  ]);
  return workView(
    pause,
    rows.map((r) => ({ status: r.status, count: r._count._all })),
    running,
  );
}

export const GET = route({}, async () => state());

/** Pause or resume new work: running prompts finish; new prompts and indexing requests wait until resumed. */
export const PUT = route({ body: z.object({ paused: z.boolean() }) }, async ({ body }) => {
  await setValue(CLAIMS_PAUSED_KEY, body.paused);
  await audit(body.paused ? 'work.pause' : 'work.resume', 'Setting', CLAIMS_PAUSED_KEY, {});
  return state();
});
