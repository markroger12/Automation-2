/**
 * The SEO lines an article answer starts with: “SEO Title: …”, “Meta Description: …”, “URL Slug: …” (Tigram and
 * Celebrity 2). Client-safe.
 *
 * Owner report (Celebrity 2, “Ricardo Joel Gomez”): the three lines stood at the top of the WordPress article. The
 * owner's prompt asks for each label on its own line and the value on the next (“**SEO Title:**  ↵ [title]”); the
 * extension turns that line break into a newline, and the old parser only read a value on the label's own line. These
 * helpers read both forms (also a heading or list mark before the label, bold around it, non-breaking spaces).
 */
export interface MetaLines {
  seoTitle: string | null;
  metaDescription: string | null;
  slug: string | null;
}

export type MetaKind = keyof MetaLines;

const LABEL_RE = /^\s*(?:#{1,6}\s*|[-*•>]\s+)?(?:\*\*|__)?\s*(SEO\s*-?\s*TIT(?:LE|EL)|META\s*-?\s*(?:DESCRIPTION|BESCHREIBUNG)|URL\s*-?\s*SLUG|SLUG)\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*(.*?)\s*$/i;

const kindOf = (label: string): MetaKind => {
  const k = label.toUpperCase().replace(/[^A-Z]/g, '');
  return k.startsWith('SEOTIT') ? 'seoTitle' : k.startsWith('META') ? 'metaDescription' : 'slug';
};

const normSpaces = (s: string) => s.replace(/[     ]/g, ' ');

/** A value without markdown bold, surrounding quotes or backticks. */
export function cleanMetaValue(raw: string): string {
  return raw
    .replace(/\*\*|__/g, '')
    .trim()
    .replace(/^["“„'`]+|["”“'`]+$/g, '')
    .trim();
}

/** “SEO Title: …” (one line of text) → its kind and value, or null. */
export function matchMetaLine(line: string): { kind: MetaKind; value: string } | null {
  const m = LABEL_RE.exec(normSpaces(line));
  if (!m) return null;
  return { kind: kindOf(m[1]), value: cleanMetaValue(m[2]) };
}

/**
 * The SEO lines at the top of a Markdown answer (before its first “## ” section), each label once, with the value on
 * the same line or on the next non-empty line. `body` is the answer without them; a short lead-in before them (the
 * writing block's title, a chatbot line) is left out too.
 */
export function extractMetaLines(text: string): MetaLines & { body: string; found: number } {
  const lines = normSpaces(text.replace(/\r\n/g, '\n')).split('\n');
  const out: MetaLines = { seoTitle: null, metaDescription: null, slug: null };
  const consumed = new Set<number>();
  let firstMeta = -1;
  const end = (() => {
    const i = lines.findIndex((l) => /^##\s/.test(l.trim()));
    return i < 0 ? lines.length : i;
  })();
  for (let i = 0; i < end; i++) {
    if (consumed.has(i)) continue;
    const hit = matchMetaLine(lines[i]);
    if (!hit || out[hit.kind] !== null) continue;
    let value = hit.value;
    consumed.add(i);
    if (!value) {
      // The value on the next non-empty line (at most one blank line between), unless that is another label or heading.
      for (let j = i + 1, blanks = 0; j < end && blanks <= 1; j++) {
        const t = lines[j].trim();
        if (!t) {
          blanks++;
          continue;
        }
        if (matchMetaLine(t) || /^#{1,6}\s/.test(t)) break;
        value = cleanMetaValue(t);
        consumed.add(j);
        break;
      }
    }
    if (firstMeta < 0) firstMeta = i;
    out[hit.kind] = value || null;
  }
  // A short lead-in before the first SEO line (the writing block's title, “Here is the article:”) is not article text.
  const lead = firstMeta > 0 ? lines.slice(0, firstMeta).filter((l) => l.trim()) : [];
  const dropLead = lead.length > 0 && lead.length <= 3 && !lead.some((l) => /^##\s/.test(l.trim()));
  const body = lines
    .filter((_, i) => !consumed.has(i) && !(dropLead && i < firstMeta))
    .join('\n')
    .replace(/^\s*\n/, '')
    .trim();
  return { ...out, body, found: [out.seoTitle, out.metaDescription, out.slug].filter((v) => v !== null).length };
}
