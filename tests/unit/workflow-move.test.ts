import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { createTask } from '../helpers/fixtures';

/**
 * Owner request (screenshot of the queue: one keyword had moved to tomorrow; “ab ma chata hon ke sare hi kal per chale
 * jaen”): selected keywords move to a chosen day and take its free slots in queue order. A post already scheduled in
 * WordPress gets its new time through the approved scheduling path; nothing published is moved, and a move by the
 * owner does not count as one of the automatic moves.
 */
let client: PrismaClient;
let wf: typeof import('@/lib/workflow/service');
let sched: typeof import('@/lib/workflow/scheduler');
let siteId: string;
let workflowId: string;

const NOW = new Date('2026-10-31T11:45:00Z'); // Sat 31 Oct, 4:45 PM in Karachi
const SAT = (hm: string) => `2026-10-31T${hm}:00.000Z`;
const SUN = (hm: string) => `2026-11-01T${hm}:00.000Z`;
const MON = (hm: string) => `2026-11-02T${hm}:00.000Z`;
const kw = (keyword: string) => client.workflowKeyword.findFirstOrThrow({ where: { keyword } });
const slotOf = async (keyword: string) => (await kw(keyword)).scheduledAt?.toISOString() ?? null;
const reservationOf = async (keyword: string) => (await client.slotReservation.findUnique({ where: { workflowKeywordId: (await kw(keyword)).id } }))?.scheduledAt.toISOString() ?? null;

async function row(keyword: string, position: number, status: string, at: string | null, extra: Record<string, unknown> = {}) {
  let taskId: string | null = null;
  if (status !== 'WAITING') {
    const task = await createTask(client, siteId, { keyword, moduleKey: 'tigram-writer' });
    if (['READY', 'SCHEDULED', 'PUBLISHED'].includes(status)) await client.articleTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', wpPostId: 500 + position } });
    taskId = task.id;
  }
  const k = await client.workflowKeyword.create({ data: { workflowId, keyword, normalizedKeyword: keyword.toLowerCase(), position, writerType: 'TIGRAM', status, taskId, scheduledAt: at ? new Date(at) : null, ...extra } });
  if (at && status !== 'PUBLISHED') await client.slotReservation.create({ data: { websiteId: siteId, scheduledAt: new Date(at), workflowKeywordId: k.id } });
  return k;
}

let selected: string[];

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  wf = await import('@/lib/workflow/service');
  sched = await import('@/lib/workflow/scheduler');
  const websites = await import('@/lib/websites');
  siteId = (await websites.createWebsite({ name: 'Celeb Site', publicUrl: 'https://celeb.example', language: 'en', targetCountry: 'United States', timezone: 'America/New_York' })).id;
  await client.website.update({ where: { id: siteId }, data: { canPublish: true, canPublishAcknowledgedAt: new Date() } });
  workflowId = (await wf.saveWorkflow(siteId, { active: true, writerPreference: 'AUTO', slots: ['5:00 PM', '5:30 PM', '6:00 PM', '6:30 PM', '7:00 PM'], weekdays: [], writeAheadHours: 24, maxBacklog: 10, imagesOverride: 'off', requestIndexing: false, maxRetries: 3 })).id;
  // The owner's queue from the screenshot (slots in Pakistan time, UTC+5).
  const peter = await row('peter buchignani', 1, 'WRITING', SUN('12:00'), { retries: 1, lastError: 'The article was not ready by its slot. Moved to the next free slot.' });
  const isabella = await row('isabella brewster', 2, 'SCHEDULED', SAT('12:30'));
  const justin = await row('justin biel', 3, 'WRITING', SAT('13:00'));
  const fay = await row('fay asghari', 4, 'WRITING', SAT('13:30'));
  const antivirus = await row('Antivirus FreeDoor2.4.6.8', 5, 'WRITING', SAT('14:00'));
  // Not selected: tomorrow's 6:00 PM is already taken by another post.
  await row('already tomorrow', 6, 'SCHEDULED', SUN('13:00'));
  const later = await row('not started yet', 7, 'WAITING', null);
  const published = await row('published before', 8, 'PUBLISHED', SAT('10:00'));
  await row('not selected, waiting', 9, 'WAITING', null);
  selected = [peter, isabella, justin, fay, antivirus, later, published].map((k) => k.id);
});

describe('move keywords to another day', () => {
  it('preview: the selected keywords take the chosen day’s free slots in queue order (spilling into the next day); nothing is written', async () => {
    const r = await wf.moveKeywords(siteId, { keywordIds: selected, date: '2026-11-01', dryRun: true }, NOW);
    expect(r.plan.map((p) => [p.keyword, p.from, p.to])).toEqual([
      ['peter buchignani', SUN('12:00'), SUN('12:00')],
      ['isabella brewster', SAT('12:30'), SUN('12:30')],
      // Sunday 6:00 PM belongs to a keyword that was not selected.
      ['justin biel', SAT('13:00'), SUN('13:30')],
      ['fay asghari', SAT('13:30'), SUN('14:00')],
      ['Antivirus FreeDoor2.4.6.8', SAT('14:00'), MON('12:00')],
      ['not started yet', null, MON('12:30')],
    ]);
    expect(r.notes).toEqual([expect.stringMatching(/“published before” is published; only keywords not published yet can be moved/)]);
    expect(r.changed).toBe(0);
    expect(await slotOf('justin biel')).toBe(SAT('13:00'));
    expect(await reservationOf('justin biel')).toBe(SAT('13:00'));
    expect((await kw('isabella brewster')).status).toBe('SCHEDULED');
  });

  it('move: slots and reservations change together; a scheduled post goes back through the approved scheduling path; the owner’s move is not an automatic one', async () => {
    const r = await wf.moveKeywords(siteId, { keywordIds: selected, date: '2026-11-01' }, NOW);
    expect(r.changed).toBe(6);
    for (const [keyword, at] of [
      ['peter buchignani', SUN('12:00')],
      ['isabella brewster', SUN('12:30')],
      ['justin biel', SUN('13:30')],
      ['fay asghari', SUN('14:00')],
      ['Antivirus FreeDoor2.4.6.8', MON('12:00')],
      ['not started yet', MON('12:30')],
    ]) {
      expect(await slotOf(keyword), keyword).toBe(at);
      expect(await reservationOf(keyword), keyword).toBe(at);
    }
    // The old “not ready by its slot” note is gone; the automatic-move count stays as it was.
    expect(await kw('peter buchignani')).toMatchObject({ status: 'WRITING', retries: 1, lastError: null });
    expect(await kw('not started yet')).toMatchObject({ status: 'WAITING', taskId: null });
    expect(await kw('published before')).toMatchObject({ status: 'PUBLISHED', scheduledAt: new Date(SAT('10:00')) });
    // Scheduled in WordPress: READY again, and one schedule job changes the post's time (withPublishPermit, read back).
    const isabella = await kw('isabella brewster');
    expect(isabella).toMatchObject({ status: 'READY', lastError: expect.stringMatching(/Moved by you/) });
    const jobs = await client.queueJob.findMany({ where: { kind: 'wp.schedule', relatedId: isabella.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ queue: 'control', websiteId: siteId });
    expect(await client.auditLog.count({ where: { action: 'workflow.keywords.move' } })).toBe(1);
  });

  it('afterwards the scheduler keeps the new slots: nothing moves back, no second schedule job, the planned keyword waits for its day', async () => {
    const r = await sched.schedulerTick(NOW);
    expect(r).toMatchObject({ moved: 0, failed: 0, scheduleJobs: 0 });
    expect(await slotOf('justin biel')).toBe(SUN('13:30'));
    // The moved keyword that had not started keeps its planned slot (48 h away, write-ahead 24 h) …
    expect(await kw('not started yet')).toMatchObject({ status: 'WAITING', scheduledAt: new Date(MON('12:30')) });
    // … while a keyword that was not selected may use today's slots that became free.
    expect(await kw('not selected, waiting')).toMatchObject({ status: 'WRITING', scheduledAt: new Date(SAT('12:00')) });

    // Within the write-ahead time of its planned slot, it starts there (not at the next free slot).
    const monday = new Date('2026-11-02T06:00:00Z'); // Mon 11:00 AM in Karachi
    await sched.schedulerTick(monday);
    expect(await kw('not started yet')).toMatchObject({ status: 'WRITING', scheduledAt: new Date(MON('12:30')) });
    expect(await reservationOf('not started yet')).toBe(MON('12:30'));
  });

  it('refuses a past or impossible day, a post WordPress publishes within minutes, and a scheduled post on a website whose publishing was switched off', async () => {
    await expect(wf.moveKeywords(siteId, { keywordIds: selected, date: '2026-10-30' }, NOW)).rejects.toThrow(/today or a later day/);
    await expect(wf.moveKeywords(siteId, { keywordIds: selected, date: '2026-02-30' }, NOW)).rejects.toThrow(/not a day/);
    const soon = await row('published in five minutes', 20, 'SCHEDULED', SAT('11:50'));
    const r = await wf.moveKeywords(siteId, { keywordIds: [soon.id], date: '2026-11-03' }, NOW);
    expect(r.changed).toBe(0);
    expect(r.notes[0]).toMatch(/WordPress publishes it at .* too soon to move/);
    expect(await slotOf('published in five minutes')).toBe(SAT('11:50'));

    await client.website.update({ where: { id: siteId }, data: { canPublish: false } });
    const THU = '2026-11-05T14:00:00.000Z';
    const off = await row('scheduled, publishing now off', 21, 'SCHEDULED', THU);
    const r2 = await wf.moveKeywords(siteId, { keywordIds: [off.id], date: '2026-11-03' }, NOW);
    expect(r2.notes[0]).toMatch(/publishing is now off for this website/);
    expect(await kw('scheduled, publishing now off')).toMatchObject({ status: 'SCHEDULED', scheduledAt: new Date(THU) });
    await client.website.update({ where: { id: siteId }, data: { canPublish: true } });
  });

  it('a planned keyword that is skipped gives its slot back; the action is also reachable as “move” on the keyword action route', async () => {
    const waiting = await row('planned then skipped', 30, 'WAITING', null);
    await wf.moveKeywords(siteId, { keywordIds: [waiting.id], date: '2026-11-03' }, NOW);
    expect(await reservationOf('planned then skipped')).not.toBeNull();
    await wf.keywordAction(siteId, { keywordIds: [waiting.id], action: 'skip' });
    expect(await kw('planned then skipped')).toMatchObject({ status: 'SKIPPED', scheduledAt: null });
    expect(await reservationOf('planned then skipped')).toBeNull();

    // Through keywordAction (the dashboard's route), with the real clock: tomorrow in Pakistan time.
    const restored = await wf.keywordAction(siteId, { keywordIds: [waiting.id], action: 'restore' });
    expect(restored.changed).toBe(1);
    const tomorrow = new Date(Date.now() + 5 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
    const r = await wf.keywordAction(siteId, { keywordIds: [waiting.id], action: 'move', date: tomorrow, dryRun: true });
    expect(r).toMatchObject({ changed: 0, plan: [expect.objectContaining({ keyword: 'planned then skipped' })] });
    expect(Date.parse((r as { plan: { to: string }[] }).plan[0].to)).toBeGreaterThanOrEqual(Date.parse(`${tomorrow}T00:00:00+05:00`));
  });
});
