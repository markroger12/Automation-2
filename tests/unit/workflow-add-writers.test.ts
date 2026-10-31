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

  it('refuses a writer that does not exist or a line that is not a number', async () => {
    await expect(wf.addKeywords(siteId, { text: 'someone new', writers: { '1': 'GHOSTWRITER' } })).rejects.toThrow();
    await expect(wf.addKeywords(siteId, { text: 'someone new', writers: { first: 'CELEBRITY' } })).rejects.toThrow();
  });
});
