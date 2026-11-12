import { describe, expect, it } from 'vitest';
import { NAV_ITEMS, filterNav, navGroups, searchPages } from '@/components/nav-config';

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

/** Owner request: the reference dashboard's layout — the search in the top bar, the menu in groups. */
describe('top bar search and menu groups', () => {
  const hits = (q: string) => searchPages(NAV_ITEMS, q).map((h) => (h.parent ? `${h.parent} › ${h.label}` : h.label));

  it('lists matching pages one per line, a sub-page with its parent', () => {
    expect(hits('plagiar')).toEqual(['Editorial Tools › Plagiarism Evidence']);
    expect(hits('search perf')).toEqual(['Productivity › Search Performance']);
    expect(hits('IMAGE')).toEqual(['Image Template']);
  });

  it('a page with sub-pages that matches brings them too', () => {
    expect(hits('editorial')).toEqual(['Editorial Tools', 'Editorial Tools › Humanizer', 'Editorial Tools › Plagiarism Evidence', 'Editorial Tools › Research Evidence', 'Editorial Tools › Duplicate Review', 'Editorial Tools › Content Refresh']);
    expect(hits('workflow')[0]).toBe('Workflow / Calendar');
  });

  it('nothing matches: no pages (the box then offers to search articles)', () => {
    expect(searchPages(NAV_ITEMS, 'anika bissel')).toEqual([]);
  });

  it('groups the menu by its headings, Overview first on its own', () => {
    const groups = navGroups(NAV_ITEMS);
    expect(groups.map((g) => g.section)).toEqual([null, 'Articles', 'Websites', 'Content tools', 'Growth & publishing', 'System']);
    expect(groups[0].items.map((i) => i.label)).toEqual(['Overview']);
    expect(groups.flatMap((g) => g.items)).toEqual(NAV_ITEMS);
  });
});
