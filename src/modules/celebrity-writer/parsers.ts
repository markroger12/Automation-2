import { load } from 'cheerio';
import { sanitizeArticleHtml } from '@/lib/html/sanitize';

/** Parse TITLES output: numbered options + the uniquely parseable "Recommended Title:" line. */
export function parseTitles(text: string): { options: string[]; recommended: string | null } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let recommended: string | null = null;
  const options: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    const rec = line.match(/^\**\s*(?:recommended title|empfohlener titel)\s*\**\s*:\s*\**\s*(.+?)\s*\**$/i);
    if (rec) {
      recommended = cleanTitle(rec[1]);
      continue;
    }
    const opt = line.match(/^(?:\d{1,2}[.)]|[-*•])\s+(.+)$/);
    if (opt) {
      const title = cleanTitle(opt[1]);
      if (title && title.length >= 8 && title.length <= 200 && !options.includes(title)) options.push(title);
    }
  }
  if (recommended && !options.includes(recommended)) options.unshift(recommended);
  return { options, recommended };
}

function cleanTitle(t: string): string {
  return t
    .replace(/^\*\*|\*\*$/g, '')
    .replace(/^["“„'‘]+|["”“'’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface FaqItem {
  question: string;
  answer: string;
}

/** Parse "QUESTION: … / ANSWER: …" pairs (also accepts FRAGE/ANTWORT and Q:/A:). */
export function parseFaqs(text: string): FaqItem[] {
  const items: FaqItem[] = [];
  const re = /(?:^|\n)\s*\**(?:question|frage|q)\s*\d*\**\s*[:：]\s*\**\s*([\s\S]+?)\s*\n\s*\**(?:answer|antwort|a)\s*\d*\**\s*[:：]\s*\**\s*([\s\S]+?)(?=\n\s*\**(?:question|frage|q)\s*\d*\**\s*[:：]|$)/gi;
  for (const m of text.replace(/\r\n/g, '\n').matchAll(re)) {
    const question = m[1].replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    const answer = m[2].replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
    if (question && answer) items.push({ question: question.endsWith('?') ? question : `${question}?`, answer });
  }
  return items;
}

export interface BioRow {
  attribute: string;
  details: string;
}

export interface QuickBioParse {
  rows: BioRow[];
  html: string;
  problems: string[];
}

const NOT_CONFIRMED: Record<string, string> = { en: 'Not publicly confirmed', de: 'Nicht öffentlich bestätigt' };

/**
 * Parse and rebuild the Quick Bio as clean two-column table markup
 * (<table><thead><tr><th>Attribute</th><th>Details</th></tr></thead><tbody>…).
 * Accepts an HTML table or a Markdown table from the model.
 */
export function parseQuickBio(text: string, language: string, expectedRows: number): QuickBioParse {
  const problems: string[] = [];
  let rows: BioRow[] = [];
  const cleaned = text.replace(/^```(?:html)?\n?|\n?```$/g, '');
  if (/<table/i.test(cleaned)) {
    const $ = load(cleaned);
    const trs = $('table').first().find('tr').toArray();
    for (const tr of trs) {
      const cells = $(tr).children('th,td').toArray().map((c) => $(c).text().replace(/\s+/g, ' ').trim());
      if (cells.length === 0) continue;
      if (cells.length !== 2) problems.push(`Row with ${cells.length} columns: "${cells.join(' | ').slice(0, 80)}"`);
      rows.push({ attribute: cells[0] ?? '', details: cells.slice(1).join(' ') });
    }
  } else {
    for (const line of cleaned.split('\n')) {
      if (!/^\s*\|/.test(line) || /^\s*\|\s*-{2,}/.test(line)) continue;
      const cells = line.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.replace(/\*\*/g, '').trim());
      if (cells.length !== 2) problems.push(`Row with ${cells.length} columns`);
      rows.push({ attribute: cells[0] ?? '', details: cells.slice(1).join(' ') });
    }
  }
  if (rows.length && /^(attribute|attribut|merkmal)$/i.test(rows[0].attribute) && /^(details|angaben|einzelheiten)$/i.test(rows[0].details)) rows = rows.slice(1);
  rows = rows.filter((r) => r.attribute && r.details);
  const seen = new Set<string>();
  rows = rows.filter((r) => {
    const k = r.attribute.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const fallback = NOT_CONFIRMED[language] ?? NOT_CONFIRMED.en;
  rows = rows.map((r) => ({ attribute: r.attribute, details: /^(n\/a|unknown|unbekannt|—|-|none)$/i.test(r.details) ? fallback : r.details }));
  if (rows.length === 0) problems.push('No table rows found.');
  const min = Math.max(6, expectedRows - 2);
  const max = expectedRows + 2;
  if (rows.length && (rows.length < min || rows.length > max)) problems.push(`Quick Bio has ${rows.length} rows; expected about ${expectedRows - 1}–${expectedRows + 1}.`);
  const header = language === 'de' ? ['Merkmal', 'Angaben'] : ['Attribute', 'Details'];
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = sanitizeArticleHtml(
    `<table class="bas-quick-bio"><thead><tr><th>${header[0]}</th><th>${header[1]}</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.attribute)}</td><td>${esc(r.details)}</td></tr>`).join('')}</tbody></table>`,
  );
  return { rows, html, problems };
}

/** Full name from the Quick Bio, only when actually confirmed (never inferred). */
export function confirmedFullName(rows: BioRow[]): string | null {
  const row = rows.find((r) => /^(full name|vollständiger name|name)$/i.test(r.attribute));
  if (!row) return null;
  if (/not publicly confirmed|nicht öffentlich bestätigt|unknown|unbekannt/i.test(row.details)) return null;
  return row.details.replace(/\s*\([^)]*\)\s*$/, '').trim() || null;
}

/** Extract cited URLs and uncertainty notes from research notes (kept out of the article body). */
export function analyzeResearch(text: string): { sources: { url: string; context: string }[]; uncertain: string[]; estimates: string[] } {
  const sources: { url: string; context: string }[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s)\]>"']+/g)) {
    const url = m[0].replace(/[.,;:]+$/, '');
    if (!sources.some((s) => s.url === url)) {
      const start = Math.max(0, (m.index ?? 0) - 120);
      sources.push({ url, context: text.slice(start, (m.index ?? 0)).split('\n').pop()?.trim().slice(-120) ?? '' });
    }
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const uncertain = lines.filter((l) => /\b(unconfirmed|not (publicly )?confirmed|disputed|rumou?r|unclear|conflicting|unverified|nicht bestätigt|umstritten|unklar|gerücht)\b/i.test(l)).slice(0, 30);
  const estimates = lines.filter((l) => /\b(estimate[sd]?|approximately|reportedly|geschätzt|angeblich|rund)\b/i.test(l)).slice(0, 30);
  return { sources, uncertain, estimates };
}
