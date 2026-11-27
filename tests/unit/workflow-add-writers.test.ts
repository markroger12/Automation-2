import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

/** Owner request (screenshot of Add keywords with “choose writer later”): choose the writer right there, per keyword or for all. */
let client: PrismaClient;
let wf: typeof import('@/lib/workflow/service');
let siteId: string;

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  wf = await import('@/lib/workflow/service');
  const websites = await import('@/lib/websites');
  siteId = (await websites.createWebsite({ name: 'Celeb Blog', publicUrl: 'https://celeb.example', language: 'en', targetCountry: 'United States', timezone: 'America/New_York' })).id;
});

describe('Add keywords: the writer chosen per line', () => {
  it('a chosen writer wins over the detection; “choose later” keeps a line undecided; the rest keep what was detected', async () => {
    const text = 'lyzel williams\nmorgan carey\nhow to install wordpress\nbest vpn apps';
    const preview = await wf.previewKeywords(siteId, text);
    expect(preview.rows.map((r) => r.writerType)).toEqual(['UNKNOWN', 'UNKNOWN', 'TIGRAM', 'TIGRAM']);
    expect(await wf.addKeywords(siteId, { text, writers: { '1': 'CELEBRITY', '2': 'CELEBRITY', '4': 'UNKNOWN' } })).toEqual({ added: 4, skippedDuplicates: 0, invalid: 0 });
    const rows = await client.workflowKeyword.findMany({ orderBy: { position: 'asc' }, select: { keyword: true, writerType: true, detectionSource: true, detectionReason: true } });
    expect(rows).toEqual([
      { keyword: 'lyzel williams', writerType: 'CELEBRITY', detectionSource: 'OVERRIDE', detectionReason: 'Chosen by you.' },
      { keyword: 'morgan carey', writerType: 'CELEBRITY', detectionSource: 'OVERRIDE', detectionReason: 'Chosen by you.' },
      { keyword: 'how to install wordpress', writerType: 'TIGRAM', detectionSource: preview.rows[2].detectionSource, detectionReason: preview.rows[2].detectionReason },
      { keyword: 'best vpn apps', writerType: 'UNKNOWN', detectionSource: 'OVERRIDE', detectionReason: 'Left for you to choose.' },
    ]);
  });

  it('owner decision (2026-11-04): a person keyword is not given a writer by itself; Celebrity 2 is chosen like any writer and writes the article', async () => {
    const text = 'Andrea Soros\nTaylor Swift net worth\nhow to clean a keyboard';
    const preview = await wf.previewKeywords(siteId, text);
    expect(preview.rows.map((r) => [r.writerType, r.detected])).toEqual([
      ['UNKNOWN', 'CELEBRITY'],
      ['UNKNOWN', 'CELEBRITY'],
      ['TIGRAM', null],
    ]);
    expect(preview.rows[1].detectionReason).toMatch(/Choose Celebrity or Celebrity 2\.$/);
    await wf.addKeywords(siteId, { text, writers: { '1': 'CELEBRITY2' } });
    const rows = await client.workflowKeyword.findMany({ where: { keyword: { in: ['Andrea Soros', 'Taylor Swift net worth', 'how to clean a keyboard'] } }, orderBy: { position: 'asc' } });
    expect(rows.map((r) => [r.keyword, r.writerType])).toEqual([
      ['Andrea Soros', 'CELEBRITY2'],
      ['Taylor Swift net worth', 'UNKNOWN'],
      ['how to clean a keyboard', 'TIGRAM'],
    ]);
    const { writerFor } = await import('@/lib/workflow/scheduler');
    expect(writerFor({ writerPreference: 'AUTO' }, rows[0])).toBe('celebrity2-writer');
    expect(writerFor({ writerPreference: 'AUTO' }, rows[1])).toBeNull();
    expect(writerFor({ writerPreference: 'celebrity2-writer' }, rows[1])).toBe('celebrity2-writer');
    // More → Writer → Celebrity 2 on the queue.
    await wf.keywordAction(siteId, { keywordIds: [rows[1].id], action: 'writer', writer: 'celebrity2-writer' });
    expect((await client.workflowKeyword.findUniqueOrThrow({ where: { id: rows[1].id } })).writerType).toBe('CELEBRITY2');
  });

  it('refuses a writer that does not exist or a line that is not a number', async () => {
    await expect(wf.addKeywords(siteId, { text: 'someone new', writers: { '1': 'GHOSTWRITER' } })).rejects.toThrow();
    await expect(wf.addKeywords(siteId, { text: 'someone new', writers: { first: 'CELEBRITY' } })).rejects.toThrow();
  });
});
