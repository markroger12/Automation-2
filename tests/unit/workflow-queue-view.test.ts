import { describe, expect, it } from 'vitest';
import { clampPage, pageCount, pageSlice } from '@/lib/pagination';
import { filterKeywords, readableTimes, statusCounts } from '@/lib/workflow/queue-view';
import { formatInZone } from '@/lib/workflow/time';

/**
 * Owner report (screen recording of the workflow keyword queue): “I have to scroll so much”. With 68 keywords the
 * page was 7334 px tall: every keyword on one page, each two to eight lines high. The queue now has pages, a search
 * and a status filter, and Google's long answers fit one line.
 */
describe('workflow keyword queue: pages', () => {
  const rows = Array.from({ length: 68 }, (_, i) => i + 1);

  it('20 per page: 68 keywords are 4 pages, the last one with 8', () => {
    expect(pageCount(68, 20)).toBe(4);
    expect(pageSlice(rows, 1, 20)).toEqual(rows.slice(0, 20));
    expect(pageSlice(rows, 4, 20)).toEqual([61, 62, 63, 64, 65, 66, 67, 68]);
  });

  it('a page past the end (after a filter or a delete) shows the last page; an empty list has one page', () => {
    expect(clampPage(9, 68, 20)).toBe(4);
    expect(pageSlice(rows, 9, 50)).toEqual(rows.slice(50));
    expect(clampPage(0, 68, 20)).toBe(1);
    expect(pageCount(0, 20)).toBe(1);
    expect(pageSlice([], 1, 20)).toEqual([]);
  });
});

describe('workflow keyword queue: search and status filter', () => {
  const kws = [
    { keyword: 'mekhi phifer net worth', status: 'INDEXED', secondaryKeywords: ['mekhi phifer wife'] },
    { keyword: 'Tariq Walker', status: 'FAILED', secondaryKeywords: [] },
    { keyword: 'tyrus wife', status: 'WRITING', secondaryKeywords: [] },
    { keyword: 'Rachel Sutherland', status: 'INDEXED', secondaryKeywords: [] },
  ];

  it('the search finds every word, in any case, also in the secondary keywords', () => {
    expect(filterKeywords(kws, { q: 'WIFE', statuses: [] }).map((k) => k.keyword)).toEqual(['mekhi phifer net worth', 'tyrus wife']);
    expect(filterKeywords(kws, { q: 'tariq  walker', statuses: [] }).map((k) => k.keyword)).toEqual(['Tariq Walker']);
  });

  it('statuses: none chosen shows all; chosen ones show only those, in queue order', () => {
    expect(filterKeywords(kws, { q: '', statuses: [] })).toHaveLength(4);
    expect(filterKeywords(kws, { q: '', statuses: ['FAILED', 'WRITING'] }).map((k) => k.keyword)).toEqual(['Tariq Walker', 'tyrus wife']);
    expect(filterKeywords(kws, { q: 'rachel', statuses: ['FAILED'] })).toEqual([]);
  });

  it('counts each status for the filter menu', () => {
    expect(statusCounts(kws)).toEqual({ INDEXED: 2, FAILED: 1, WRITING: 1 });
  });
});

describe("workflow keyword queue: Google's answers on one line", () => {
  it('UTC times become Pakistan time, as the slots are shown', () => {
    const text = 'Google: URL is on Google (Submitted and indexed · last crawl 2026-10-24T13:02:36Z · checked 2026-10-24T16:49:29.190Z)';
    const pk = (iso: string) => `${formatInZone(iso, 'Asia/Karachi')} PK`;
    expect(readableTimes(text, 'Asia/Karachi')).toBe(`Google: URL is on Google (Submitted and indexed · last crawl ${pk('2026-10-24T13:02:36Z')} · checked ${pk('2026-10-24T16:49:29.190Z')})`);
    // 13:02 UTC is 6:02 pm in Pakistan.
    expect(pk('2026-10-24T13:02:36Z')).toMatch(/24 Oct, 6:02\s?pm PK$/i);
  });

  it('text without times is left as it is', () => {
    expect(readableTimes('Draft #1344 saved but not published', 'Asia/Karachi')).toBe('Draft #1344 saved but not published');
  });
});
