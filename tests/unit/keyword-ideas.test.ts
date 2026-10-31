import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { createTask, createWebsite } from '../helpers/fixtures';

/**
 * Owner request: keyword ideas on the Workflow page — Search Console queries with impressions that the website has no
 * keyword or article for, and Google's related searches / “People also ask” through Serper.
 */
let client: PrismaClient;
let ideas: typeof import('@/lib/workflow/keyword-ideas');
let siteId: string;
let server: http.Server;
let lastBody: Record<string, unknown> | null = null;
let lastKey: string | undefined;

beforeAll(async () => {
  ({ client } = await setupTestDb());
  ideas = await import('@/lib/workflow/keyword-ideas');
  siteId = (await createWebsite(client, { name: 'Ideas Site', language: 'de' })).id;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      lastBody = JSON.parse(body);
      lastKey = req.headers['x-api-key'] as string | undefined;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          organic: [{ link: 'https://example.org', title: 'x' }],
          relatedSearches: [{ query: 'Eartha Kitt net worth' }, { query: 'eartha kitt  daughter' }, { query: 'Eartha Kitt Net Worth' }, { query: 42 }],
          peopleAlsoAsk: [{ question: 'Who was Eartha Kitt married to?' }, { question: '' }],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  ideas.setIdeasEndpointForTests(`http://127.0.0.1:${(server.address() as AddressInfo).port}/search`);
});

afterAll(async () => {
  ideas.setIdeasEndpointForTests(null);
  await new Promise((r) => server.close(r));
});

describe('keyword ideas', () => {
  it('Search Console: queries with impressions that no keyword or article has, most impressions first', async () => {
    expect(await ideas.searchConsoleIdeas(siteId)).toEqual({ ideas: [], data: null });
    const snap = await client.searchPerformanceSnapshot.create({ data: { websiteId: siteId, property: 'sc-domain:ideas.example', source: 'GSC_API', fileName: 'api', sha256: 'a1', startDate: '2026-10-01', endDate: '2026-10-28', queryRows: 5 } });
    const row = (key: string, impressions: number, clicks = 0, position = 12.3) => ({ snapshotId: snap.id, websiteId: siteId, dimension: 'QUERY', key, impressions, clicks, position });
    await client.searchPerformanceRow.createMany({
      data: [row('eartha kitt daughter', 900, 12, 8.4), row('Eartha Kitt husband', 300), row('annie mae keith', 1500, 40, 3.1), row('kitt cat', 0), row('Eartha Kitt Daughter', 50), { ...row('page', 999), dimension: 'PAGE' }],
    });
    // Already in the queue (any state) or written: not an idea.
    const wf = await client.workflow.create({ data: { websiteId: siteId, name: 'wf' } });
    await client.workflowKeyword.create({ data: { workflowId: wf.id, keyword: 'Annie Mae Keith', normalizedKeyword: 'annie mae keith', position: 1 } });
    await createTask(client, siteId, { keyword: 'Eartha Kitt Husband' });
    const r = await ideas.searchConsoleIdeas(siteId);
    expect(r.data).toEqual({ source: 'GSC_API', startDate: '2026-10-01', endDate: '2026-10-28' });
    expect(r.ideas).toEqual([{ keyword: 'eartha kitt daughter', source: 'search-console', impressions: 900, clicks: 12, position: 8.4, covered: false }]);
  });

  it('Google: related searches and “People also ask” through Serper, in the website language; known ones marked', async () => {
    const key = process.env.SERPER_API_KEY;
    delete process.env.SERPER_API_KEY;
    await expect(ideas.googleIdeas(siteId, 'Eartha Kitt')).rejects.toThrow(/SERPER_API_KEY/);
    process.env.SERPER_API_KEY = 'test-key';
    try {
      await expect(ideas.googleIdeas(siteId, ' x ')).rejects.toThrow(/2 to 200 characters/);
      const found = await ideas.googleIdeas(siteId, '  Eartha   Kitt ');
      expect(lastBody).toEqual({ q: 'Eartha Kitt', hl: 'de', num: 10 });
      expect(lastKey).toBe('test-key');
      // Duplicates in Google's answer once; what is not text left out.
      expect(found).toEqual([
        { keyword: 'Eartha Kitt net worth', source: 'related', covered: false },
        { keyword: 'eartha kitt daughter', source: 'related', covered: false },
        { keyword: 'Who was Eartha Kitt married to?', source: 'people-also-ask', covered: false },
      ]);
      const wf = await client.workflow.findFirstOrThrow({ where: { websiteId: siteId } });
      await client.workflowKeyword.create({ data: { workflowId: wf.id, keyword: 'Eartha Kitt net worth', normalizedKeyword: 'eartha kitt net worth', position: 2 } });
      expect((await ideas.googleIdeas(siteId, 'Eartha Kitt'))[0]).toEqual({ keyword: 'Eartha Kitt net worth', source: 'related', covered: true });
    } finally {
      if (key === undefined) delete process.env.SERPER_API_KEY;
      else process.env.SERPER_API_KEY = key;
    }
  });
});
