import { Marked } from 'marked';
import { sanitizeArticleHtml } from '../html/sanitize';
import { stripTracking } from '../links/url';

const marked = new Marked({ gfm: true, breaks: false, async: false });

/** Remove chatbot wrappers, fences and a leading duplicate title from model Markdown. */
export function cleanModelMarkdown(md: string, options: { title?: string | null } = {}): string {
  let text = md.replace(/\r\n/g, '\n').trim();
  const fenced = text.match(/^```(?:markdown|md|html)?\n([\s\S]*?)\n```$/i);
  if (fenced) text = fenced[1].trim();
  // Leading H1 or "Title:" line that repeats the article title.
  const lines = text.split('\n');
  while (lines.length && /^\s*$/.test(lines[0])) lines.shift();
  if (lines.length) {
    const first = lines[0].trim();
    const isTitle = /^#\s+/.test(first) || /^(?:title|titel)\s*:/i.test(first) || (options.title && first.replace(/^#+\s*/, '').replace(/^\*\*|\*\*$/g, '').trim().toLowerCase() === options.title.trim().toLowerCase());
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
