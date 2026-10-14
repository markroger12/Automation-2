import { describe, expect, it } from 'vitest';
import { MAX_IMPORT_ROWS, parseImport, splitRecords } from '@/lib/campaigns/parse';
import { classifyKeyword, normalizeWriter, resolveWriter } from '@/lib/campaigns/router';

describe('bulk import parser', () => {
  it('reads one keyword per line, keeps the raw text and normalizes only derived fields', () => {
    const r = parseImport('  Tom   Kaulitz  \n\nHeidi​ Klum\nx\n');
    expect(r.format).toBe('lines');
    expect(r.rows.map((x) => [x.line, x.keyword, x.raw])).toEqual([
      [1, 'Tom Kaulitz', '  Tom   Kaulitz  '],
      [3, 'Heidi Klum', 'Heidi​ Klum'],
      [4, 'x', 'x'],
    ]);
    expect(r.rows[2].errors).toEqual(['Keyword is too short.']);
  });

  it('reads "keyword | secondary1, secondary2 | example title" with independent values per row', () => {
    const r = parseImport('Tom Kaulitz Heidi Klum | Tokio Hotel, wedding | Tom & Heidi: Their Story\nBest VPN Apps | | \nHow to Install WordPress | hosting');
    expect(r.format).toBe('pipe');
    expect(r.rows[0]).toMatchObject({ keyword: 'Tom Kaulitz Heidi Klum', secondaryKeywords: ['Tokio Hotel', 'wedding'], exampleTitle: 'Tom & Heidi: Their Story' });
    expect(r.rows[1]).toMatchObject({ keyword: 'Best VPN Apps', secondaryKeywords: [], exampleTitle: null });
    expect(r.rows[2]).toMatchObject({ keyword: 'How to Install WordPress', secondaryKeywords: ['hosting'], exampleTitle: null });
  });

  it('reads CSV with headers, quotes, embedded commas/newlines, aliases and unknown columns', () => {
    const csv = 'Keyword,Secondary_Keywords,Title,Kind,Language,Priority,Website,Extra\n"Taylor Swift","Travis Kelce, Eras Tour","Taylor Swift: ""The Eras"" Story",celebrity,English,2,Celeb News,foo\nBest Free VPN,"privacy\nsecurity",,tigram,de,,,\n';
    const r = parseImport(csv);
    expect(r.format).toBe('csv');
    expect(r.problems).toEqual(['Ignored unknown column(s): extra.']);
    expect(r.rows[0]).toMatchObject({ line: 2, keyword: 'Taylor Swift', secondaryKeywords: ['Travis Kelce', 'Eras Tour'], exampleTitle: 'Taylor Swift: "The Eras" Story', writer: 'celebrity', language: 'en', priority: 2, website: 'Celeb News', errors: [] });
    expect(r.rows[1]).toMatchObject({ line: 3, keyword: 'Best Free VPN', secondaryKeywords: ['privacy', 'security'], writer: 'tigram', language: 'de' });
    expect(splitRecords('a;"b;c"\n', ';')[0].fields).toEqual(['a', 'b;c']);
  });

  it('reads columns pasted from a spreadsheet (tab-separated, with or without a header)', () => {
    const withHeader = parseImport('keyword\ttitle\tsecondary keywords\nSelena Gomez\tSelena Gomez Today\tRare Beauty\n');
    expect(withHeader.format).toBe('tsv');
    expect(withHeader.rows[0]).toMatchObject({ keyword: 'Selena Gomez', exampleTitle: 'Selena Gomez Today', secondaryKeywords: ['Rare Beauty'] });
    const bare = parseImport('Selena Gomez\tRare Beauty\tSelena Today\nZendaya\t\t\n');
    expect(bare.rows.map((x) => [x.keyword, x.secondaryKeywords, x.exampleTitle])).toEqual([
      ['Selena Gomez', ['Rare Beauty'], 'Selena Today'],
      ['Zendaya', [], null],
    ]);
  });

  it('flags invalid rows without dropping them, and caps an import at 1,000 rows', () => {
    const r = parseImport(`keyword,priority,language\n${'k'.repeat(170)},1,en\nok keyword,99,fr\n`);
    expect(r.rows[0].errors).toEqual(['Keyword is longer than 160 characters.']);
    expect(r.rows[1].errors).toEqual(['Priority must be a whole number from -10 to 10.', 'Unknown language “fr” (use en or de).']);
    const big = parseImport(Array.from({ length: 1005 }, (_, i) => `keyword number ${i + 1}`).join('\n'));
    expect(big.rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(big.rows.at(-1)!.keyword).toBe('keyword number 1000');
    expect(big.problems[0]).toMatch(/1005 rows found; at most 1000/);
    expect(parseImport('   \n').problems).toEqual(['No keywords found.']);
  });
});

/** Curated mixed EN/DE intent dataset. null = UNKNOWN is the expected, safe answer. */
const DATASET: [string, 'en' | 'de', 'celebrity-writer' | 'tigram-writer' | null][] = [
  ['Tom Kaulitz Heidi Klum', 'en', 'celebrity-writer'],
  ['Taylor Swift net worth', 'en', 'celebrity-writer'],
  ['taylor swift boyfriend', 'en', 'celebrity-writer'],
  ['Selena Gomez husband', 'en', 'celebrity-writer'],
  ['brad pitt kids', 'en', 'celebrity-writer'],
  ['Zendaya age', 'en', 'celebrity-writer'],
  ['Heidi Klum', 'en', 'celebrity-writer'],
  ['Keanu Reeves girlfriend', 'en', 'celebrity-writer'],
  ['mark zuckerberg wife', 'en', 'celebrity-writer'],
  ['Helene Fischer Ehemann', 'de', 'celebrity-writer'],
  ['tom kaulitz vermögen', 'de', 'celebrity-writer'],
  ['Florian Silbereisen Freundin', 'de', 'celebrity-writer'],
  ['Lena Meyer-Landrut Kinder', 'de', 'celebrity-writer'],
  ['Dieter Bohlen Alter', 'de', 'celebrity-writer'],
  ['How to Install WordPress', 'en', 'tigram-writer'],
  ['best free vpn apps', 'en', 'tigram-writer'],
  ['iphone 15 vs samsung s24', 'en', 'tigram-writer'],
  ['download whatsapp apk', 'en', 'tigram-writer'],
  ['what is seo', 'en', 'tigram-writer'],
  ['chrome not working fix', 'en', 'tigram-writer'],
  ['best laptop for students', 'en', 'tigram-writer'],
  ['Netflix price 2026', 'en', 'tigram-writer'],
  ['apple net worth', 'en', 'tigram-writer'],
  ['banana bread recipe', 'en', 'tigram-writer'],
  ['WordPress Anleitung für Anfänger', 'de', 'tigram-writer'],
  ['beste kostenlose VPN', 'de', 'tigram-writer'],
  ['was ist ChatGPT', 'de', 'tigram-writer'],
  ['Windows 11 Fehler beheben', 'de', 'tigram-writer'],
  ['Handy Test 2026', 'de', 'tigram-writer'],
  // Ambiguous on purpose: names that overlap brands/things, intent without a name, mixed intent, bare words.
  ['Tokio Hotel', 'en', null],
  ['net worth', 'en', null],
  ['how old is the eiffel tower', 'en', null],
  ['Taylor Swift guide', 'en', 'tigram-writer'],
  ['Orange', 'en', null],
  ['jaguar', 'en', null],
  ['family vacation ideas', 'en', null],
];

describe('Smart Article Router', () => {
  it('routes a curated EN/DE dataset with no confident misroutes (confusion matrix)', () => {
    const labels = ['celebrity-writer', 'tigram-writer', 'UNKNOWN'] as const;
    const matrix: Record<string, Record<string, number>> = Object.fromEntries(labels.map((a) => [a, Object.fromEntries(labels.map((b) => [b, 0]))]));
    const confidentMisroutes: string[] = [];
    for (const [kw, lang, expected] of DATASET) {
      const r = resolveWriter({ keyword: kw, language: lang });
      const got = r.writer ?? 'UNKNOWN';
      matrix[expected ?? 'UNKNOWN'][got]++;
      if (r.writer && expected && r.writer !== expected) confidentMisroutes.push(`${kw} → ${r.writer} (${r.rationale})`);
      if (r.writer && !expected) confidentMisroutes.push(`${kw} → ${r.writer} but should ask (${r.rationale})`);
    }
    expect(confidentMisroutes).toEqual([]);
    // Most clear cases are routed automatically; the rest safely ask.
    expect(matrix['celebrity-writer']['celebrity-writer']).toBeGreaterThanOrEqual(13);
    expect(matrix['tigram-writer']['tigram-writer']).toBeGreaterThanOrEqual(15);
    expect(matrix['celebrity-writer']['tigram-writer'] + matrix['tigram-writer']['celebrity-writer']).toBe(0);
  });

  it('records version, confidence and rationale; overrides and campaign defaults win; 2.0 is never a writer', () => {
    const r = classifyKeyword('Taylor Swift net worth');
    expect(r).toMatchObject({ writer: 'celebrity-writer', source: 'RULE' });
    expect(r.version).toMatch(/^rules-/);
    expect(r.rationale).toMatch(/Person intent .*net worth.*Names a person \(Taylor Swift\)/);
    expect(resolveWriter({ keyword: 'Taylor Swift net worth', override: 'tigram' })).toMatchObject({ writer: 'tigram-writer', source: 'OVERRIDE' });
    expect(resolveWriter({ keyword: 'jaguar', campaignDefault: 'tigram-writer' })).toMatchObject({ writer: 'tigram-writer', source: 'CAMPAIGN' });
    expect(normalizeWriter('celebrity-writer-2')).toBeNull();
    expect(normalizeWriter('Celebrity Writer 2.0')).toBeNull();
    expect(resolveWriter({ keyword: 'jaguar', override: 'celebrity-writer-2' }).writer).toBeNull();
    // Below the automatic threshold → UNKNOWN with the reason.
    const low = resolveWriter({ keyword: 'Taylor Swift guide' , minConfidence: 0.7 });
    expect(low.writer).toBeNull();
    expect(low.rationale).toMatch(/below the automatic threshold/);
  });
});
