/**
 * Bulk keyword import (client-safe, pure). Accepts:
 *  - one keyword per line;
 *  - "keyword | secondary1, secondary2 | example title" lines;
 *  - CSV with a header row (keyword, secondary_keywords, title, website,
 *    category, kind/writer, language, priority, notes);
 *  - columns pasted from a spreadsheet (tab-separated, header optional).
 * The original text of every row is kept untouched (`raw`); normalization
 * only produces derived fields.
 */

export const MAX_IMPORT_ROWS = 1000;

export interface ImportRow {
  /** 1-based line/record number in the input. */
  line: number;
  raw: string;
  keyword: string;
  secondaryKeywords: string[];
  exampleTitle: string | null;
  website: string | null;
  category: string | null;
  writer: string | null;
  language: string | null;
  priority: number | null;
  notes: string | null;
  errors: string[];
}

export interface ParseResult {
  format: 'lines' | 'pipe' | 'csv' | 'tsv';
  rows: ImportRow[];
  /** Problems with the input as a whole (e.g. too many rows, unknown columns). */
  problems: string[];
}

const HEADER_ALIASES: Record<string, keyof ImportRow> = {
  keyword: 'keyword',
  keywords: 'keyword',
  'primary keyword': 'keyword',
  primary_keyword: 'keyword',
  secondary: 'secondaryKeywords',
  secondary_keywords: 'secondaryKeywords',
  'secondary keywords': 'secondaryKeywords',
  title: 'exampleTitle',
  example_title: 'exampleTitle',
  'example title': 'exampleTitle',
  website: 'website',
  site: 'website',
  category: 'category',
  kind: 'writer',
  writer: 'writer',
  type: 'writer',
  language: 'language',
  lang: 'language',
  priority: 'priority',
  notes: 'notes',
  note: 'notes',
};

const clean = (s: string) => s.normalize('NFKC').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();

/** RFC 4180-style CSV/TSV record splitter (quotes, escaped quotes, newlines inside quotes). */
export function splitRecords(text: string, delimiter: ',' | '\t' | ';'): { fields: string[]; raw: string; line: number }[] {
  const out: { fields: string[]; raw: string; line: number }[] = [];
  let field = '';
  let fields: string[] = [];
  let inQuotes = false;
  let start = 0;
  let line = 1;
  let recordLine = 1;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') inQuotes = false;
      else if (c === undefined) {
        fields.push(field);
        out.push({ fields, raw: text.slice(start, i), line: recordLine });
      } else {
        if (c === '\n') line++;
        field += c;
      }
      continue;
    }
    if (c === '"' && field.trim() === '') {
      inQuotes = true;
      field = '';
    } else if (c === delimiter) {
      fields.push(field);
      field = '';
    } else if (c === '\n' || c === undefined) {
      fields.push(field.replace(/\r$/, ''));
      const raw = text.slice(start, i).replace(/\r$/, '');
      if (raw.trim()) out.push({ fields, raw, line: recordLine });
      fields = [];
      field = '';
      start = i + 1;
      line++;
      recordLine = line;
    } else field += c;
  }
  return out;
}

function detect(text: string): ParseResult['format'] {
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  const header = first.toLowerCase();
  if (first.includes('\t')) return 'tsv';
  if (/(^|[,;])\s*"?(keyword|keywords|primary[ _]keyword)"?\s*([,;]|$)/.test(header)) return 'csv';
  if (text.split('\n').some((l) => l.includes('|'))) return 'pipe';
  return 'lines';
}

function splitList(v: string): string[] {
  return [...new Set(v.split(/[,;\n]/).map(clean).filter(Boolean))];
}

function finalize(row: Omit<ImportRow, 'errors'>): ImportRow {
  const errors: string[] = [];
  if (!row.keyword) errors.push('Missing keyword.');
  else if (row.keyword.length < 2) errors.push('Keyword is too short.');
  else if (row.keyword.length > 160) errors.push('Keyword is longer than 160 characters.');
  if (row.exampleTitle && row.exampleTitle.length > 200) errors.push('Title is longer than 200 characters.');
  if (row.secondaryKeywords.length > 20) errors.push('More than 20 secondary keywords.');
  if (row.priority !== null && (!Number.isInteger(row.priority) || row.priority < -10 || row.priority > 10)) errors.push('Priority must be a whole number from -10 to 10.');
  if (row.language && !['en', 'de'].includes(row.language)) errors.push(`Unknown language “${row.language}” (use en or de).`);
  return { ...row, errors };
}

const blank = (line: number, raw: string): Omit<ImportRow, 'errors'> => ({ line, raw, keyword: '', secondaryKeywords: [], exampleTitle: null, website: null, category: null, writer: null, language: null, priority: null, notes: null });

const LANG: Record<string, string> = { en: 'en', english: 'en', englisch: 'en', de: 'de', german: 'de', deutsch: 'de' };

export function parseImport(input: string): ParseResult {
  const text = input.replace(/\r\n?/g, '\n');
  const format = detect(text);
  const problems: string[] = [];
  let rows: ImportRow[] = [];
  if (format === 'csv' || format === 'tsv') {
    const delimiter = format === 'tsv' ? '\t' : text.split('\n')[0].split(';').length > text.split('\n')[0].split(',').length ? ';' : ',';
    const records = splitRecords(text, delimiter);
    const headerCells = records[0]?.fields.map((h) => clean(h).toLowerCase()) ?? [];
    const hasHeader = headerCells.some((h) => HEADER_ALIASES[h] === 'keyword');
    const columns: (keyof ImportRow | null)[] = hasHeader ? headerCells.map((h) => HEADER_ALIASES[h] ?? null) : ['keyword', 'secondaryKeywords', 'exampleTitle'];
    if (hasHeader) {
      const unknown = headerCells.filter((h, i) => h && !columns[i]);
      if (unknown.length) problems.push(`Ignored unknown column(s): ${unknown.join(', ')}.`);
    }
    for (const rec of records.slice(hasHeader ? 1 : 0)) {
      const row = blank(rec.line, rec.raw);
      rec.fields.forEach((value, i) => {
        const col = columns[i];
        const v = clean(value);
        if (!col || !v) return;
        if (col === 'secondaryKeywords') row.secondaryKeywords = splitList(value);
        else if (col === 'priority') row.priority = Number(v);
        else if (col === 'language') row.language = LANG[v.toLowerCase()] ?? v.toLowerCase();
        else (row as unknown as Record<string, unknown>)[col] = v;
      });
      rows.push(finalize(row));
    }
  } else {
    text.split('\n').forEach((rawLine, i) => {
      if (!rawLine.trim()) return;
      const row = blank(i + 1, rawLine);
      if (format === 'pipe') {
        const [kw, secondary, title] = rawLine.split('|');
        row.keyword = clean(kw ?? '');
        row.secondaryKeywords = secondary ? splitList(secondary) : [];
        row.exampleTitle = title && clean(title) ? clean(title) : null;
      } else row.keyword = clean(rawLine);
      rows.push(finalize(row));
    });
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    problems.push(`${rows.length} rows found; at most ${MAX_IMPORT_ROWS} are imported at once. Rows after ${MAX_IMPORT_ROWS} were left out.`);
    rows = rows.slice(0, MAX_IMPORT_ROWS);
  }
  if (!rows.length) problems.push('No keywords found.');
  return { format, rows, problems };
}
