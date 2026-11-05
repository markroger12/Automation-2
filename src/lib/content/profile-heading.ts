import type { CheerioAPI } from 'cheerio';

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PROFILE_RE = /^(family profile|familienprofil|steckbrief|profile|profil)$/i;

/**
 * Owner report (Celebrity 2): the “Family Profile” heading above the person's table must be an H2. ChatGPT writes it
 * as a bold line, with a colon, as an H3 — or leaves it out. The line right above the first matching table becomes an
 * H2 with its own words; without one, “Family Profile” (German: “Familienprofil”) is added. The paragraph above the
 * table that is not such a label (the direct answer) is left as it is.
 */
export function profileHeadingAsH2($: CheerioAPI, language: string, tableSelector = 'table'): void {
  const table = $(tableSelector).first();
  if (!table.length) return;
  const label = table.prev();
  if (label.is('h2')) return;
  const text = label.text().replace(/\s+/g, ' ').trim().replace(/[:：]$/, '').trim();
  const strong = label.children('strong, b');
  const boldLine = label.is('p') && strong.length === 1 && strong.text().trim() === label.text().trim() && text.length > 0 && text.length <= 60;
  const heading = label.is('h3, h4') && text.length > 0 && text.length <= 80;
  if (boldLine || heading || (label.is('p') && PROFILE_RE.test(text))) label.replaceWith(`<h2>${esc(text)}</h2>`);
  else table.before(`<h2>${language === 'de' ? 'Familienprofil' : 'Family Profile'}</h2>`);
}
