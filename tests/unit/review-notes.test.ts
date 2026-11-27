import { describe, expect, it } from 'vitest';
import { groupReviewNotes, parseReviewNote } from '@/lib/review-notes';

/**
 * Owner report (screenshot of an article's “Notes (10)”: “fix this, look how bad it looks”): every note was one long
 * sentence with its excerpts and a “[RESEARCH_EVIDENCE]” tag. The notes from that screenshot, as the app stores them.
 */
const OWNER_NOTES = [
  'Sources disagree on the birth date: “Eartha Kitt was born on January 17, 1927, in South Carolina.” (and 2 more note(s)). Check it in Research Evidence. [RESEARCH_EVIDENCE]',
  'Sources disagree on the death date: “| December 25, 2008 | Eartha Kitt died at age 81 | South Carolina Encyclopedia |” (and 1 more note(s)). Check it in Research Evidence. [RESEARCH_EVIDENCE]',
  'The article states 3 unsupported family/relationship claims in paragraph 1: “Annie Mae Keith is remembered through her connection to Eartha Kitt, the celebrated American singer and actress whose childhood was marked by poverty, racial pr” (research notes: “Annie Mae Keith is identified in several biographical accounts as the mother of American singer, act”; “Central editorial finding: The article can responsibly explain Annie Mae Keith\'s connection to Earth”; …). Verify it, word it neutrally or leave it out. [RESEARCH_EVIDENCE]',
  'The article states an unsupported family/relationship claim in paragraph 52: “Historical accounts identify a younger girl named Pearl in Eartha Kitt\'s family. The South Carolina Encyclopedia describes Pearl as Eartha\'s younger half-sister” (research note: “The South Carolina Encyclopedia describes Pearl as Eartha\'s younger half-sister.”). Verify it, word it neutrally or leave it out. [RESEARCH_EVIDENCE]',
  '2 % of the wording (longest identical run 12 words, 2 identical paragraph(s)) repeats “Who Was Annie Mae Keith? All About Eartha Kitt’s Mother” on Techeflux. See Duplicate Review. [DUPLICATES]',
];

describe('review notes: short title, quote, research notes, advice', () => {
  it('“Sources disagree”: the fact as the title, the note as the quote, how many more', () => {
    const n = parseReviewNote(OWNER_NOTES[0]);
    expect(n).toMatchObject({ source: 'RESEARCH_EVIDENCE', title: 'Sources disagree on the birth date', quote: 'Eartha Kitt was born on January 17, 1927, in South Carolina.', more: '2 more notes', advice: 'Check it in Research Evidence.' });
    // A table row from the research reads as a list, not with pipes.
    expect(parseReviewNote(OWNER_NOTES[1])).toMatchObject({ title: 'Sources disagree on the death date', quote: 'December 25, 2008 · Eartha Kitt died at age 81 · South Carolina Encyclopedia', more: '1 more note' });
  });

  it('unsupported claims: how many and the paragraph as the title; the cut excerpts end in “…”', () => {
    const n = parseReviewNote(OWNER_NOTES[2]);
    expect(n.title).toBe('3 unsupported family/relationship claims · paragraph 1');
    expect(n.quote).toMatch(/^Annie Mae Keith is remembered .* racial pr…$/);
    expect(n.notes).toEqual(['Annie Mae Keith is identified in several biographical accounts as the mother of American singer, act…', "Central editorial finding: The article can responsibly explain Annie Mae Keith's connection to Earth…"]);
    expect(n.more).toBe('more notes');
    expect(n.advice).toBe('Verify it, word it neutrally or leave it out.');
    const one = parseReviewNote(OWNER_NOTES[3]);
    expect(one.title).toBe('Unsupported family/relationship claim · paragraph 52');
    expect(one.notes).toEqual(["The South Carolina Encyclopedia describes Pearl as Eartha's younger half-sister."]);
    expect(one.more).toBeNull();
    // A quote that ends its sentence at the cut needs no “…”.
    const whole = 'In her July 1962 interview with Studs Terkel, Eartha recalled that the woman she considered her mother became seriously ill after giving birth to another child.';
    expect(parseReviewNote(`The article states an unsupported family/relationship claim in paragraph 68: “${whole}” (research note: “x”). Verify it. [RESEARCH_EVIDENCE]`).quote).toBe(whole);
  });

  it('duplicate wording: the share and the website as the title, the other article as the quote', () => {
    expect(parseReviewNote(OWNER_NOTES[4])).toMatchObject({
      source: 'DUPLICATES',
      title: '2 % of the wording repeats an article on Techeflux',
      quote: 'Who Was Annie Mae Keith? All About Eartha Kitt’s Mother',
      notes: ['Longest identical run 12 words, 2 identical paragraph(s)'],
      advice: 'See Duplicate Review.',
    });
  });

  it('other notes keep their text: the first sentence as the title, the rest as advice; no tag is fine', () => {
    expect(parseReviewNote('SEO readiness 62 is below 70. Failed: title length; meta description. [SEO_CHECK]')).toMatchObject({ source: 'SEO_CHECK', title: 'SEO readiness 62 is below 70', advice: 'Failed: title length; meta description.' });
    expect(parseReviewNote('The FAQ section is missing. [FAQS]')).toMatchObject({ title: 'The FAQ section is missing.', quote: null, advice: null });
    expect(parseReviewNote('Possible duplicate on this website: “Andre Rock” (draft #12).')).toMatchObject({ source: null, title: 'Possible duplicate on this website', quote: 'Andre Rock' });
    // Nothing is lost: the full text stays.
    expect(parseReviewNote(OWNER_NOTES[2]).text).toBe(OWNER_NOTES[2].replace(' [RESEARCH_EVIDENCE]', ''));
  });

  it('groups by where the notes came from, in their order', () => {
    const groups = groupReviewNotes([...OWNER_NOTES, 'The FAQ section is missing. [FAQS]', 'Keyword density 3% is above the 2.5% ceiling. [FINAL_ARTICLE]', 'Something else']);
    expect(groups.map((g) => [g.label, g.notes.length])).toEqual([
      ['Research evidence', 4],
      ['Duplicates', 1],
      ['Article', 2],
      ['Other', 1],
    ]);
  });
});
