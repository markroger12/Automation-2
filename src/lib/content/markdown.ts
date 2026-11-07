import { Marked } from 'marked';
import { sanitizeArticleHtml } from '../html/sanitize';
import { stripTracking } from '../links/url';

const marked = new Marked({ gfm: true, breaks: false, async: false });

/**
 * The label ChatGPT shows above a writing block (owner report: “Writing” under the title of every article). The page
 * text of an answer can carry it as a line of its own; it is never article text.
 */
export const WRITING_LABEL_RE = /^(?:writing|schreiben)$/i;

/** Text compared loosely (case, punctuation, spacing), e.g. a heading against the article title. */
export const sameTitle = (a: string, b: string) => {
  const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return Boolean(norm(a)) && norm(a) === norm(b);
};

/** Remove chatbot wrappers, fences and a leading duplicate title from model Markdown. */
export function cleanModelMarkdown(md: string, options: { title?: string | null } = {}): string {
  let text = md.replace(/\r\n/g, '\n').trim();
  const fenced = text.match(/^```(?:markdown|md|html)?\n([\s\S]*?)\n```$/i);
  if (fenced) text = fenced[1].trim();
  // The writing block's “Writing” label (a line of its own), wherever it stands.
  const lines = text.split('\n').filter((line) => !WRITING_LABEL_RE.test(line.replace(/^\*\*|\*\*$/g, '').trim()));
  // Leading H1 or "Title:" line that repeats the article title.
  while (lines.length && /^\s*$/.test(lines[0])) lines.shift();
  if (lines.length) {
    const first = lines[0].trim();
    const isTitle = /^#\s+/.test(first) || /^(?:title|titel)\s*:/i.test(first) || (options.title && sameTitle(first.replace(/^#+\s*/, '').replace(/^\*\*|\*\*$/g, ''), options.title));
    if (isTitle) lines.shift();
  }
  text = lines.join('\n');
  // Common AI commentary lines (whole lines only).
  text = text.replace(/^(?:here(?:'s| is) (?:the|your)[^\n]*:|word count:[^\n]*|\(?approx(?:\.|imately)? \d[\d,]* words\)?|note:[^\n]*rewrite[^\n]*)\s*$/gim, '');
  // Promote stray H1 headings to H2 inside the body.
  text = text.replace(/^#\s+/gm, '## ');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function markdownToHtml(md: string): string {
  const html = marked.parse(md) as string;
  return stripTrackingHrefs(sanitizeArticleHtml(html));
}

/** ChatGPT adds utm_source=chatgpt.com to the links it cites; the article keeps the clean address. */
export function stripTrackingHrefs(html: string): string {
  return html.replace(/href="([^"]*[?&](?:amp;)?utm_[^"]*)"/gi, (_m, url: string) => `href="${stripTracking(url.replace(/&amp;/g, '&')).replace(/&/g, '&amp;')}"`);
}

/** Remove exact duplicate paragraphs/headings (normalized), keeping the first occurrence. */
export function dedupeBlocks(html: string): { html: string; removed: number } {
  const seen = new Set<string>();
  let removed = 0;
  const out = html.replace(/<(p|h2|h3|h4)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (match, tag: string, _attrs: string, inner: string) => {
    const key = `${tag.toLowerCase()}:${inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase()}`;
    if (key.length < tag.length + 6) return match;
    if (seen.has(key)) {
      removed++;
      return '';
    }
    seen.add(key);
    return match;
  });
  return { html: out, removed };
}
