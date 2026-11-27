import { cleanModelMarkdown } from '@/lib/content/markdown';

/**
 * ChatGPT's answer to the POST_UPDATE prompt (prompt-defaults.ts): sections between marker lines
 *
 *   ===TITLE===  ===META_DESCRIPTION===  ===CHANGES===  ===SOURCES===  ===ARTICLE===  ===END===
 *
 * Marker lines are found also when ChatGPT bolds them or puts spaces in them.
 */
export interface UpdateAnswer {
  title: string | null;
  metaDescription: string | null;
  changes: string[];
  /** ChatGPT says nothing needed to change. */
  noChanges: boolean;
  sources: { url: string; note: string }[];
  article: string;
}

const SECTIONS = ['TITLE', 'META_DESCRIPTION', 'CHANGES', 'SOURCES', 'ARTICLE', 'END'] as const;
type Section = (typeof SECTIONS)[number];
const MARKER = /^\s*[*_`#>\s]*={3,}\s*([A-Z][A-Z _]*[A-Z])\s*={3,}[*_`\s]*$/;

const bullet = (line: string) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();

export function parseUpdateAnswer(text: string): UpdateAnswer | { error: string } {
  const parts = new Map<Section, string[]>();
  let current: Section | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const m = MARKER.exec(line);
    const name = m ? (m[1].replace(/\s+/g, '_') as Section) : null;
    if (name && SECTIONS.includes(name)) {
      current = name;
      if (!parts.has(name)) parts.set(name, []);
      continue;
    }
    if (current && current !== 'END') parts.get(current)!.push(line);
  }
  if (!parts.has('ARTICLE')) return { error: 'ChatGPT’s answer has no ===ARTICLE=== part (it did not follow the answer format).' };
  const article = cleanModelMarkdown((parts.get('ARTICLE') ?? []).join('\n'));
  if (!article.trim()) return { error: 'ChatGPT’s answer has an empty article.' };
  const one = (s: Section) => {
    const v = (parts.get(s) ?? []).map((l) => l.trim()).filter(Boolean).join(' ').replace(/^["“]|["”]$/g, '').trim();
    return v || null;
  };
  const changes = (parts.get('CHANGES') ?? []).map(bullet).filter(Boolean);
  const sources = (parts.get('SOURCES') ?? [])
    .map(bullet)
    .map((l) => {
      const url = /(https?:\/\/[^\s)<>\]]+)/.exec(l)?.[1]?.replace(/[.,;]+$/, '');
      const note = l
        .replace(/\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/<?https?:\/\/[^\s)<>\]]+>?/g, '')
        .replace(/^[\s—–:\-()[\]]+|[\s—–:\-()[\]]+$/g, '')
        .trim();
      return url ? { url, note } : null;
    })
    .filter((s): s is { url: string; note: string } => Boolean(s));
  return {
    title: one('TITLE')?.replace(/^#+\s*/, '') ?? null,
    metaDescription: one('META_DESCRIPTION'),
    changes,
    noChanges: changes.length > 0 && changes.every((c) => /^(no changes? (were )?needed|nothing (needed|to change)|keine änderungen)/i.test(c)),
    sources,
    article,
  };
}
