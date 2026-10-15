import { describe, expect, it } from 'vitest';
import { aboutSubject, extractClaims, findAmounts, findDates, identityContext, internalConflicts, judge, locateInArticle, statusFor, type ExtractedClaim } from '@/lib/research/claims';

const NOTES = `## Identity
- Tom Kaulitz was born on September 1, 1989 in Leipzig, Germany. (https://en.wikipedia.org/wiki/Tom_Kaulitz)
- He has an identical twin brother, Bill Kaulitz, who is the band's singer.
Sources: https://www.tokiohotel.com/band https://www.imdb.com/name/nm1/

## Relationships
- He married model Heidi Klum in February 2019 on a yacht near Capri.
- A rumoured earlier relationship with Ria Sommerfeld is not confirmed by reliable sources.

## Money
- His net worth is estimated at $30 million (unofficial estimate).

## Career
- Tokio Hotel won an MTV Europe Music Award in 2007.
- He enjoys cooking and video games.`;

describe('research claims — values', () => {
  it('normalizes English and German dates', () => {
    for (const t of ['September 1, 1989', '1 September 1989', '1. September 1989', '01.09.1989', '1989-09-01', '1st of September 1989']) expect(findDates(`born ${t} in Leipzig`).map((d) => d.value)).toContain('1989-09-01');
    expect(findDates('married in February 2019').map((d) => d.value)).toEqual(['2019-02']);
    expect(findDates('won in 2007').map((d) => d.value)).toEqual(['2007']);
  });

  it('reads money amounts in English and German notation', () => {
    expect(findAmounts('net worth of $30 million')).toEqual([30_000_000]);
    expect(findAmounts('geschätzt 2,5 Mio. Euro Vermögen')).toEqual([2_500_000]);
    expect(findAmounts('around €1.2 billion')).toEqual([1_200_000_000]);
    expect(findAmounts('$1,200,000 in 2020')).toEqual([1_200_000]);
  });
});

describe('research claims — extraction', () => {
  const claims = extractClaims(NOTES, 'Tom Kaulitz');

  it('keeps only checkable statements, typed, with values, nature, impact and citations', () => {
    const byType = (t: string) => claims.filter((c) => c.type === t);
    const birth = byType('BIRTH')[0];
    expect(birth).toMatchObject({ highImpact: true, nature: 'REPORTED_FACT', citations: ['https://en.wikipedia.org/wiki/Tom_Kaulitz'] });
    expect(birth.values.dates).toEqual(['1989-09-01']);
    const twin = claims.find((c) => /twin/.test(c.text))!;
    expect(twin).toMatchObject({ type: 'FAMILY', citations: ['https://www.tokiohotel.com/band', 'https://www.imdb.com/name/nm1/'] });
    expect(twin.values.names).toEqual(['Bill Kaulitz']);
    const married = claims.find((c) => /married/.test(c.text))!;
    expect(married.values).toMatchObject({ dates: ['2019-02'], names: ['Heidi Klum'] });
    expect(claims.find((c) => /Ria Sommerfeld/.test(c.text))).toMatchObject({ type: 'FAMILY', nature: 'UNVERIFIED_CLAIM', highImpact: true });
    expect(byType('NET_WORTH')[0]).toMatchObject({ nature: 'ESTIMATE', values: { amounts: [30_000_000] } });
    expect(byType('AWARD')[0].values.dates).toEqual(['2007']);
    expect(claims.some((c) => /cooking/.test(c.text))).toBe(false);
  });

  it('finds conflicting birth dates inside the notes themselves', () => {
    const conflicting = extractClaims('He was born on 1 September 1989.\nOther profiles say he was born on 1 October 1989.', 'Tom Kaulitz');
    expect(internalConflicts(conflicting)).toEqual([{ type: 'BIRTH', values: ['1989-09-01', '1989-10-01'] }]);
  });
});

describe('research claims — sources', () => {
  const birth: ExtractedClaim = { type: 'BIRTH', text: 'born 1 September 1989', values: { dates: ['1989-09-01'], amounts: [], names: [] }, nature: 'REPORTED_FACT', highImpact: true, citations: [] };

  it('accepts only pages about the same person', () => {
    expect(aboutSubject({ title: 'Tom Kaulitz – Wikipedia', text: 'Tom Kaulitz is a German guitarist of Tokio Hotel.' }, 'Tom Kaulitz')).toEqual({ ok: true, reason: null });
    expect(aboutSubject({ title: 'Bill Kaulitz', text: 'Bill is the singer.' }, 'Tom Kaulitz').reason).toMatch(/does not mention tom kaulitz/i);
    expect(aboutSubject({ title: 'Chris Evans', text: 'Chris Evans may refer to: Chris Evans (actor), Chris Evans (presenter).' }, 'Chris Evans').reason).toMatch(/disambiguation/);
    expect(aboutSubject({ title: 'Chris Evans (presenter)', text: 'Chris Evans is an English radio presenter and TV host.' }, 'Chris Evans', ['actor', 'marvel', 'captain america']).reason).toMatch(/different chris evans/);
  });

  it('the identifying context is what the secondary keywords add to the name, not the whole SEO phrases (owner live run)', () => {
    // Live run: “Gloria Krass Alter / Kinder / Wikipedia / Sascha Hehn Gloria Krass” were required verbatim, so BUNTE, BILD
    // and the agency's own site counted as “about a different Gloria Krass”.
    const ctx = identityContext('Gloria Krass ist eine deutsche Filmagentin und Unternehmerin.', ['Gloria Krass Alter', 'Gloria Krass Kinder', 'Sascha Hehn Gloria Krass', 'Gloria Krass Wikipedia'], 'Gloria Krass');
    expect(ctx).toContain('sascha hehn');
    expect(ctx).toContain('filmagentin');
    expect(ctx).not.toContain('gloria krass alter');
    expect(ctx.some((c) => /gloria|krass|alter|kinder|wikipedia/.test(c))).toBe(false);
    expect(aboutSubject({ title: 'Heimliche Hochzeit', text: 'Sascha Hehn hat zum ersten Mal Ja gesagt. Seine Frau Gloria Krass führt eine Agentur.' }, 'Gloria Krass', ctx).ok).toBe(true);
    expect(aboutSubject({ title: 'Gloria Krass Agency', text: 'Gloria Krass ist Filmagentin und vertritt Regisseure.' }, 'Gloria Krass', ctx).ok).toBe(true);
    // A namesake still never counts.
    expect(aboutSubject({ title: 'Gloria Krass', text: 'Gloria Krass ist Lehrerin in Wien.' }, 'Gloria Krass', ctx).reason).toMatch(/different gloria krass/);
  });

  it('editorial commentary in the notes (about the planned title, the article or the sources) is not a claim', () => {
    const notes = [
      'Der geplante Titel „Gloria Krass: Wer ist die Ehefrau von Sascha Hehn?“ ist durch die Recherche eindeutig gedeckt.',
      'Diese Quellen reichen aus, um Gloria Krass als eigenständige Unternehmerin und als Ehefrau von Sascha Hehn ausführlich vorzustellen.',
      'Für den Artikel reicht die Information, dass Krass Medienberichten zufolge einen erwachsenen Sohn aus einer früheren Beziehung hat.',
      'Gloria Krass ist seit 2022 mit Sascha Hehn verheiratet.',
    ].join('\n');
    const texts = extractClaims(notes, 'Gloria Krass').map((c) => c.text);
    expect(texts).toEqual(['Gloria Krass ist seit 2022 mit Sascha Hehn verheiratet.']);
  });

  it('judges support and contradiction with an excerpt', () => {
    expect(judge(birth, { title: '', text: 'Tom Kaulitz (born 1 September 1989 in Leipzig) is a guitarist.' })).toMatchObject({ verdict: 'SUPPORTS' });
    const c = judge(birth, { title: '', text: 'Tom Kaulitz was born on October 1, 1989 in Leipzig.' });
    expect(c).toMatchObject({ verdict: 'CONTRADICTS', detail: 'source gives 1989-10-01, the notes say 1989-09-01' });
    expect(c.excerpt).toContain('October 1, 1989');
    expect(judge(birth, { title: '', text: 'Tom Kaulitz plays guitar.' }).verdict).toBe('NO_MENTION');
    const worth: ExtractedClaim = { ...birth, type: 'NET_WORTH', values: { dates: [], amounts: [30_000_000], names: [] }, nature: 'ESTIMATE' };
    expect(judge(worth, { title: '', text: 'His net worth is about $30 million.' }).verdict).toBe('SUPPORTS');
    expect(judge(worth, { title: '', text: 'His net worth is about $45 million.' }).verdict).toBe('CONTRADICTS');
  });

  it('status needs two independent supporting sites for VERIFIED and never hides a contradiction', () => {
    expect(statusFor(birth, [{ host: 'a.org', verdict: 'SUPPORTS' }, { host: 'b.com', verdict: 'SUPPORTS' }])).toBe('VERIFIED');
    expect(statusFor(birth, [{ host: 'a.org', verdict: 'SUPPORTS' }, { host: 'a.org', verdict: 'SUPPORTS' }])).toBe('SINGLE_SOURCE');
    expect(statusFor(birth, [])).toBe('UNVERIFIED');
    expect(statusFor(birth, [{ host: 'a.org', verdict: 'SUPPORTS' }, { host: 'b.com', verdict: 'CONTRADICTS' }])).toBe('CONTRADICTED');
    expect(statusFor({ ...birth, nature: 'ESTIMATE' }, [{ host: 'a.org', verdict: 'SUPPORTS' }])).toBe('ESTIMATE');
    expect(statusFor({ ...birth, nature: 'ESTIMATE' }, [{ host: 'a.org', verdict: 'CONTRADICTS' }])).toBe('DISPUTED');
    expect(statusFor({ ...birth, nature: 'UNVERIFIED_CLAIM' }, [{ host: 'a.org', verdict: 'SUPPORTS' }])).toBe('DISPUTED');
  });

  it('locates a claim in the article', () => {
    expect(locateInArticle(birth, ['Intro.', 'He was born on September 1, 1989 in Leipzig.'])).toBe(1);
    expect(locateInArticle(birth, ['Intro without dates.'])).toBeNull();
  });
});
