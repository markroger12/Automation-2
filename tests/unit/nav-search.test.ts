import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, filterNav } from '@/components/nav-config';

/** Owner request: a search box above Overview in the sidebar. */
describe('sidebar search', () => {
  const labels = (q: string) => filterNav(NAV_ITEMS, q).flatMap((i) => [i.label, ...(i.children ?? []).map((c) => `  ${c.label}`)]);

  it('keeps the whole menu without a search', () => {
    expect(filterNav(NAV_ITEMS, '  ')).toBe(NAV_ITEMS);
  });

  it('finds pages by name, also inside a section (with its section), ignoring case', () => {
    expect(labels('plagiar')).toEqual(['Editorial Tools', '  Plagiarism Evidence']);
    expect(labels('IMAGE')).toEqual(['Image Template']);
    expect(labels('search perf')).toEqual(['Productivity', '  Search Performance']);
  });

  it('a section that matches keeps all its pages', () => {
    expect(labels('editorial')).toEqual(['Editorial Tools', '  Humanizer', '  Plagiarism Evidence', '  Research Evidence', '  Duplicate Review', '  Content Refresh']);
  });

  it('nothing matches: an empty menu (the box then offers to search articles)', () => {
    expect(filterNav(NAV_ITEMS, 'anika bissel')).toEqual([]);
  });
});
