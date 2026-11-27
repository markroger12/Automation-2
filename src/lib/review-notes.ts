/**
 * Review notes as the article page shows them (owner report, screenshot of “Notes (10)”: “look how bad it looks”).
 * A note is stored as one long sentence ending in its source, e.g. “… Verify it, word it neutrally or leave it out.
 * [RESEARCH_EVIDENCE]”. Here it becomes a short title, the quoted text, the research notes and the advice, grouped by
 * where it came from. Nothing is dropped: the whole text stays available.
 */
export interface ReviewNote {
  /** The note without its source tag. */
  text: string;
  source: string | null;
  title: string;
  quote: string | null;
  /** Research notes quoted after the article's text. */
  notes: string[];
  /** “2 more notes”, when the note says there are more. */
  more: string | null;
  advice: string | null;
}

const clean = (s: string) =>
  s
    // Table rows quoted from research (“| December 25, 2008 | … |”) read better as a list.
    .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
    .replace(/\s*\|\s*/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim();

/** The notes cut their quotes at a fixed length (src/lib/research/ledger.ts); a quote of that length gets “…”. */
const quoted = (s: string, cutAt?: number) => {
  const q = clean(s);
  return cutAt && s.length >= cutAt && !/[.!?…]$/.test(q) ? `${q}…` : q;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function parseReviewNote(raw: string): ReviewNote {
  const tag = /\s*\[([A-Z][A-Z0-9_]*)\]\s*$/.exec(raw);
  const text = (tag ? raw.slice(0, tag.index) : raw).trim();
  const source = tag ? tag[1] : null;
  const base = { text, source, notes: [] as string[], more: null as string | null, advice: null as string | null };

  // “Sources disagree on the birth date: “…” (and 2 more note(s)). Check it in Research Evidence.”
  let m = /^Sources disagree on the (.+?): “([\s\S]*?)”(?: \(and (\d+) more note\(s\)\))?\. ([\s\S]+)$/.exec(text);
  if (m) return { ...base, title: `Sources disagree on the ${m[1]}`, quote: quoted(m[2], 120), more: m[3] ? `${m[3]} more note${m[3] === '1' ? '' : 's'}` : null, advice: m[4].trim() };

  // “The article states 3 unsupported family/relationship claims in paragraph 1: “…” (research notes: “…”; “…”; …). Verify …”
  m = /^The article states (.+?) in paragraph (\d+): “([\s\S]*?)” \(research notes?: ([\s\S]*)\)\. ([\s\S]+)$/.exec(text);
  if (m) {
    const what = m[1].replace(/^an? /, '');
    const notes = Array.from(m[4].matchAll(/“([\s\S]*?)”/g), (n) => quoted(n[1], 100));
    const more = /;\s*…\s*$/.test(m[4]) ? 'more notes' : null;
    return { ...base, title: `${cap(what)} · paragraph ${m[2]}`, quote: quoted(m[3], 160), notes, more, advice: m[5].trim() };
  }

  // “2 % of the wording (longest identical run 12 words, 2 identical paragraph(s)) repeats “Title” on Site. See Duplicate Review.”
  m = /^(\d+) % of the wording \(([^)]*\)?[^)]*)\) repeats “([\s\S]*?)” on (.+?)\. ([\s\S]+)$/.exec(text);
  if (m) return { ...base, title: `${m[1]} % of the wording repeats an article on ${m[4]}`, quote: clean(m[3]), notes: [cap(m[2])], advice: m[5].trim() };

  // Anything else: the first sentence (or the part before a quote) is the title.
  const colon = text.indexOf(': “');
  const stop = /[.!?](\s|$)/.exec(text);
  const cut = colon > 0 && colon < 140 ? colon : stop && stop.index < 160 ? stop.index + 1 : -1;
  if (cut <= 0 || cut >= text.length - 1) return { ...base, title: text, quote: null };
  const rest = text.slice(cut + 1).trim();
  const q = /^“([\s\S]*?)”/.exec(rest);
  return { ...base, title: text.slice(0, cut).replace(/[.:]$/, ''), quote: q ? quoted(q[1]) : null, advice: q ? rest.slice(q[0].length).replace(/^[.\s]+/, '').trim() || null : rest };
}

/** Where a note came from, in words, and the page that shows it in full. */
export const NOTE_SOURCES: Record<string, { label: string; tab?: string; page?: (taskId: string) => string; pageLabel?: string }> = {
  RESEARCH_EVIDENCE: { label: 'Research evidence', page: (id) => `/research-evidence?task=${encodeURIComponent(id)}`, pageLabel: 'Open Research Evidence' },
  DUPLICATES: { label: 'Duplicates', page: () => '/duplicates', pageLabel: 'Open Duplicate Review' },
  SEO_CHECK: { label: 'SEO', tab: 'seo' },
  IMAGES: { label: 'Images', tab: 'images' },
  FAQS: { label: 'Article', tab: 'editor' },
  QUICK_BIO: { label: 'Article', tab: 'editor' },
  FINAL_ARTICLE: { label: 'Article', tab: 'editor' },
  ARTICLE: { label: 'Article', tab: 'editor' },
  ASSEMBLY: { label: 'Article', tab: 'editor' },
  PRECHECK: { label: 'Category and duplicates' },
  PIPELINE: { label: 'Writing steps', tab: 'stages' },
};

/** The notes grouped by source label, in the order their groups first appear. */
export function groupReviewNotes(raw: string[]): { label: string; source: string | null; notes: ReviewNote[] }[] {
  const groups: { label: string; source: string | null; notes: ReviewNote[] }[] = [];
  for (const r of raw) {
    const note = parseReviewNote(r);
    const label = (note.source && NOTE_SOURCES[note.source]?.label) || 'Other';
    const group = groups.find((g) => g.label === label);
    if (group) group.notes.push(note);
    else groups.push({ label, source: note.source, notes: [note] });
  }
  return groups;
}
