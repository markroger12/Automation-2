import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { formatSlot, parseSlot, upcomingSlots, zonedTimeToUtc } from '@/lib/workflow/time';
import { inspectionProperty, inspectionUrl, normalizeSearchConsoleProperty } from '@/lib/workflow/search-console';

describe('slot time math', () => {
  it('parses h:mm AM/PM and converts wall times to UTC, DST-safe', () => {
    expect(parseSlot('12:05 AM')).toEqual({ hour: 0, minute: 5 });
    expect(parseSlot('12:30 pm')).toEqual({ hour: 12, minute: 30 });
    expect(parseSlot('13:00 PM')).toBeNull();
    expect(formatSlot(15, 0)).toBe('3:00 PM');
    expect(zonedTimeToUtc(2026, 10, 15, 9, 0, 'Asia/Karachi').toISOString()).toBe('2026-10-15T04:00:00.000Z');
    expect(zonedTimeToUtc(2026, 7, 1, 9, 0, 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
    expect(zonedTimeToUtc(2026, 1, 15, 9, 0, 'America/New_York').toISOString()).toBe('2026-01-15T14:00:00.000Z');
    // Spring forward: 02:30 does not exist in Berlin on 29 March → 03:30 CEST.
    expect(zonedTimeToUtc(2026, 3, 29, 2, 30, 'Europe/Berlin').toISOString()).toBe('2026-03-29T01:30:00.000Z');
    // Fall back: 02:30 happens twice on 25 October → the earlier one.
    expect(zonedTimeToUtc(2026, 10, 25, 2, 30, 'Europe/Berlin').toISOString()).toBe('2026-10-25T00:30:00.000Z');
  });

  it('lists upcoming slots in order, honouring weekdays in the slot time zone', () => {
    const from = new Date('2026-10-14T05:00:00Z'); // Wed 10:00 in Karachi
    expect(upcomingSlots({ slots: ['9:00 AM', '3:00 PM'], weekdays: [], timezone: 'Asia/Karachi' }, from, 1).map((d) => d.toISOString())).toEqual(['2026-10-14T10:00:00.000Z', '2026-10-15T04:00:00.000Z', '2026-10-15T10:00:00.000Z']);
    const mondays = upcomingSlots({ slots: ['9:00 AM'], weekdays: [1], timezone: 'Asia/Karachi' }, from, 14);
    expect(mondays.map((d) => d.toISOString())).toEqual(['2026-10-19T04:00:00.000Z', '2026-10-26T04:00:00.000Z']);
    // Berlin slots keep their wall time across the October DST change.
    const berlin = upcomingSlots({ slots: ['9:00 AM'], weekdays: [], timezone: 'Europe/Berlin' }, new Date('2026-10-24T00:00:00Z'), 2);
    expect(berlin.map((d) => d.toISOString())).toEqual(['2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z', '2026-10-26T08:00:00.000Z']);
  });
});

describe('Search Console property', () => {
  it('accepts URL-prefix and domain properties, builds the inspection link, and falls back to the website URL', () => {
    expect(normalizeSearchConsoleProperty('https://Tech.example/blog')).toBe('https://tech.example/blog/');
    expect(normalizeSearchConsoleProperty(' sc-domain:Tech.Example ')).toBe('sc-domain:tech.example');
    for (const bad of ['ftp://tech.example/', 'sc-domain:', 'sc-domain:not a host', 'https://u:p@tech.example/', 'https://tech.example/?q=1', 'tech.example']) expect(normalizeSearchConsoleProperty(bad), bad).toBeNull();
    expect(normalizeSearchConsoleProperty('')).toBeNull();
    expect(inspectionProperty(null, 'https://tech.example')).toBe('https://tech.example/');
    expect(inspectionProperty('sc-domain:tech.example', 'https://tech.example')).toBe('sc-domain:tech.example');
    expect(inspectionUrl('sc-domain:tech.example', 'https://tech.example/a-post/')).toBe('https://search.google.com/search-console/inspect?resource_id=sc-domain%3Atech.example&id=https%3A%2F%2Ftech.example%2Fa-post%2F');
  });
});

let client: PrismaClient;
let wf: typeof import('@/lib/workflow/service');
let sched: typeof import('@/lib/workflow/scheduler');
let siteId: string;

const NOW = new Date('2026-10-14T05:00:00Z'); // 10:00 AM in Karachi
const at = (iso: string) => new Date(iso);
const kw = (keyword: string) => client.workflowKeyword.findFirstOrThrow({ where: { keyword } });

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  wf = await import('@/lib/workflow/service');
  sched = await import('@/lib/workflow/scheduler');
  const websites = await import('@/lib/websites');
  siteId = (await websites.createWebsite({ name: 'Tech Blog', publicUrl: 'https://tech.example', language: 'en', targetCountry: 'United States', timezone: 'America/New_York' })).id;
});

describe('publishing scheduler', () => {
  it('validates settings and refuses to switch on without slots', async () => {
    const base = { active: true, writerPreference: 'AUTO' as const, slots: [], weekdays: [], writeAheadHours: 24, maxBacklog: 2, imagesOverride: 'off' as const, requestIndexing: false, maxRetries: 2 };
    await expect(wf.saveWorkflow(siteId, base)).rejects.toThrow(/at least one publishing slot/);
    await expect(wf.saveWorkflow(siteId, { ...base, slots: ['25:00 AM'] })).rejects.toThrow(/h:mm AM\/PM/);
    await expect(wf.saveWorkflow(siteId, { ...base, slots: ['9:00 AM'], slotTimezone: 'Mars/Base' })).rejects.toThrow(/Unknown time zone/);
    await expect(wf.saveWorkflow(siteId, { ...base, slots: ['9:00 AM'], searchConsoleProperty: 'tech.example' })).rejects.toThrow(/Search Console property/);
    const saved = await wf.saveWorkflow(siteId, { ...base, slots: ['3:00 pm', '9:00 AM', '09:00 am'], searchConsoleProperty: 'sc-domain:Tech.Example' });
    expect(JSON.parse(saved.slots)).toEqual(['9:00 AM', '3:00 PM']);
    expect(saved.searchConsoleProperty).toBe('sc-domain:tech.example');
    expect(saved.slotTimezone).toBe('Asia/Karachi');
  });

  it('starts articles into unique slots within the backlog cap and write-ahead horizon; unclear writers wait', async () => {
    const preview = await wf.previewKeywords(siteId, 'How to Install WordPress\nbest vpn apps\njaguar\nwhat is seo\nhow to install wordpress');
    expect(preview.rows.map((r) => r.writerType)).toEqual(['TIGRAM', 'TIGRAM', 'UNKNOWN', 'TIGRAM', 'TIGRAM']);
    expect(preview.rows[4].duplicateOf).toMatch(/How to Install WordPress/);
    expect(await wf.addKeywords(siteId, { text: 'How to Install WordPress\nbest vpn apps\njaguar\nwhat is seo\nhow to install wordpress' })).toEqual({ added: 4, skippedDuplicates: 1, invalid: 0 });
    const r1 = await sched.schedulerTick(NOW);
    expect(r1).toMatchObject({ workflows: 1, started: 2 });
    const a = await kw('How to Install WordPress');
    const b = await kw('best vpn apps');
    expect([a.status, b.status]).toEqual(['WRITING', 'WRITING']);
    expect([a.scheduledAt!.toISOString(), b.scheduledAt!.toISOString()]).toEqual(['2026-10-14T10:00:00.000Z', '2026-10-15T04:00:00.000Z']);
    expect(await client.slotReservation.count()).toBe(2);
    const task = await client.articleTask.findUniqueOrThrow({ where: { id: a.taskId! } });
    expect(task).toMatchObject({ source: 'WORKFLOW', moduleKey: 'tigram-writer', workflowKeywordId: a.id, idempotencyKey: `workflow-kw:${a.id}` });
    expect(JSON.parse(task.options)).toMatchObject({ images: 'off', saveToWordPress: true });
    expect((await kw('jaguar')).lastError).toBe('Choose a writer for this keyword.');
    expect((await kw('what is seo')).status).toBe('WAITING'); // backlog cap 2
    // Ticking again changes nothing (no second task, no second reservation).
    expect((await sched.schedulerTick(NOW)).started).toBe(0);
    expect(await client.articleTask.count({ where: { source: 'WORKFLOW' } })).toBe(2);
  });

  it('a verified draft becomes READY; with publishing off it waits as a draft, with publishing on one schedule job is queued', async () => {
    const a = await kw('How to Install WordPress');
    await client.articleTask.update({ where: { id: a.taskId! }, data: { status: 'COMPLETED', wpPostId: 101 } });
    const r = await sched.schedulerTick(NOW);
    expect(r.ready).toBe(1);
    expect(r.scheduleJobs).toBe(0);
    expect(await kw('How to Install WordPress')).toMatchObject({ status: 'READY', lastError: expect.stringMatching(/Publishing is off/) });
    await client.website.update({ where: { id: siteId }, data: { canPublish: true, canPublishAcknowledgedAt: new Date() } });
    expect((await sched.schedulerTick(NOW)).scheduleJobs).toBe(1);
    expect((await sched.schedulerTick(NOW)).scheduleJobs).toBe(0);
    const job = await client.queueJob.findFirstOrThrow({ where: { kind: 'wp.schedule' } });
    expect(job).toMatchObject({ queue: 'control', relatedId: a.id, websiteId: siteId });
    await client.website.update({ where: { id: siteId }, data: { canPublish: false } });
  });

  it('a slot that passes before the article is ready moves to the next free slot, then fails after maxRetries with the reason', async () => {
    const b = await kw('best vpn apps');
    // Slot 15th 04:00Z passes while writing.
    let t = new Date('2026-10-15T04:00:30Z');
    // Same tick: the draft-only site's READY draft (slot 14th 10:00Z) is kept for the owner, freeing a backlog place.
    expect(await sched.schedulerTick(t)).toMatchObject({ moved: 1, kept: 1, started: 1 });
    expect((await kw('How to Install WordPress')).status).toBe('DONE');
    expect((await kw('what is seo')).status).toBe('WRITING');
    let row = await kw('best vpn apps');
    expect(row).toMatchObject({ status: 'WRITING', retries: 1 });
    expect(row.scheduledAt!.toISOString()).toBe('2026-10-15T10:00:00.000Z');
    expect(row.lastError).toMatch(/not ready by its slot\. Moved to the next free slot/);
    expect(await client.slotReservation.count({ where: { workflowKeywordId: b.id } })).toBe(1);
    t = new Date('2026-10-15T10:00:30Z');
    await sched.schedulerTick(t);
    row = await kw('best vpn apps');
    expect(row.retries).toBe(2);
    const r = await sched.schedulerTick(new Date(row.scheduledAt!.getTime() + 30_000));
    expect(r.failed).toBe(1);
    row = await kw('best vpn apps');
    expect(row.status).toBe('FAILED');
    expect(row.lastError).toMatch(/Stopped after 2 automatic moves/);
    expect(await client.slotReservation.count({ where: { workflowKeywordId: b.id } })).toBe(0);
    // Retry from the queue: fresh budget, next free slot.
    await wf.keywordAction(siteId, { keywordIds: [b.id], action: 'retry' });
    row = await kw('best vpn apps');
    expect(row).toMatchObject({ status: 'WRITING', retries: 0 });
    expect(row.scheduledAt).not.toBeNull();
  });

  it('write-ahead horizon, owner writer choice, scheduled-post verification jobs and owner-verified indexing', async () => {
    // Choose a writer for "jaguar"; with write-ahead 1 h nothing starts 5 h before the next slot.
    const j = await kw('jaguar');
    await wf.keywordAction(siteId, { keywordIds: [j.id], action: 'writer', writer: 'tigram' });
    const settings = { active: true, writerPreference: 'AUTO' as const, slots: ['9:00 AM', '3:00 PM'], weekdays: [], writeAheadHours: 1, maxBacklog: 5, imagesOverride: 'inherit' as const, requestIndexing: false, maxRetries: 2 };
    await wf.saveWorkflow(siteId, settings);
    const early = new Date('2026-10-20T23:00:00Z'); // 4:00 AM Karachi; next free slot is 5 h away
    expect((await sched.schedulerTick(early)).started).toBe(0);
    // Write-ahead 0 = start as soon as queued.
    await wf.saveWorkflow(siteId, { ...settings, writeAheadHours: 0 });
    // ("what is seo" already started earlier, when the kept draft freed a backlog place.)
    expect((await sched.schedulerTick(early)).started).toBe(1);
    expect((await kw('jaguar')).status).toBe('WRITING');
    // A scheduled post past its time → one verification job per half hour.
    const a = await kw('How to Install WordPress');
    await client.workflowKeyword.update({ where: { id: a.id }, data: { status: 'SCHEDULED', scheduledAt: at('2026-10-20T22:00:00Z') } });
    expect((await sched.schedulerTick(early)).verifyJobs).toBe(1);
    expect((await sched.schedulerTick(early)).verifyJobs).toBe(0);
    // Indexing is recorded only from the owner's own actions, and only after publishing.
    const refused = await wf.keywordAction(siteId, { keywordIds: [a.id], action: 'indexed' });
    expect(refused.notes[0]).toMatch(/not published yet/);
    await client.workflowKeyword.update({ where: { id: a.id }, data: { status: 'PUBLISHED' } });
    await wf.keywordAction(siteId, { keywordIds: [a.id], action: 'indexing-requested' });
    expect((await kw('How to Install WordPress')).indexingStatus).toMatch(/not evidence of indexing/);
    await wf.keywordAction(siteId, { keywordIds: [a.id], action: 'indexed' });
    expect((await kw('How to Install WordPress')).status).toBe('INDEXED');
    // The calendar shows reserved and free slots.
    const cal = await wf.calendar('2026-10-20T00:00:00Z', 3);
    expect(cal.entries.some((e) => e.status === 'WRITING' && e.keyword === 'jaguar')).toBe(true);
    expect(cal.entries.some((e) => e.status === 'FREE')).toBe(true);
  });

  it('draft-only website: once its slot passes, a verified draft is kept for the owner and leaves the backlog', async () => {
    // Without this, a full backlog of unpublished drafts would stop the workflow for good.
    const w = await client.workflow.findFirstOrThrow({ where: { websiteId: siteId } });
    const slot = at('2026-10-25T06:30:00Z');
    const k = await client.workflowKeyword.create({ data: { workflowId: w.id, keyword: 'how to speed up wordpress', normalizedKeyword: 'how to speed up wordpress', position: 999, writerType: 'TIGRAM', status: 'READY', scheduledAt: slot } });
    await client.slotReservation.create({ data: { websiteId: siteId, scheduledAt: slot, workflowKeywordId: k.id } });
    expect((await sched.schedulerTick(at('2026-10-25T06:00:00Z'))).kept).toBe(0);
    expect((await kw('how to speed up wordpress')).status).toBe('READY');
    const r = await sched.schedulerTick(at('2026-10-25T06:31:00Z'));
    expect(r).toMatchObject({ kept: 1, scheduleJobs: 0 });
    expect(await kw('how to speed up wordpress')).toMatchObject({ status: 'DONE', lastError: expect.stringMatching(/stays in WordPress for you to publish/) });
    expect(await client.slotReservation.count({ where: { workflowKeywordId: k.id } })).toBe(1);
  });
});
