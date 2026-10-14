import { load, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

/**
 * Article HTML → Markdown for prompts that must return Markdown (SEO
 * correction, humanizer). Covers the allow-listed article tags; anything else
 * keeps its text. Links, emphasis, lists and tables survive the round trip
 * through markdownToHtml.
 */

function inline($: CheerioAPI, nodes: AnyNode[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.type === 'text') {
      out += (n as unknown as { data: string }).data.replace(/\s+/g, ' ');
      continue;
    }
    if (n.type !== 'tag') continue;
    const el = n as Element;
    const inner = inline($, el.children as AnyNode[]);
    switch (el.tagName.toLowerCase()) {
      case 'strong':
      case 'b':
        out += inner.trim() ? `**${inner.trim()}**` : '';
        break;
      case 'em':
      case 'i':
        out += inner.trim() ? `*${inner.trim()}*` : '';
        break;
      case 'a': {
        const href = $(el).attr('href');
        out += href ? `[${inner.trim()}](${href})` : inner;
        break;
      }
      case 'br':
        out += '  \n';
        break;
      case 'code':
        out += `\`${inner}\``;
        break;
      case 'img': {
        const src = $(el).attr('src');
        if (src) out += `![${$(el).attr('alt') ?? ''}](${src})`;
        break;
      }
      default:
        out += inner;
    }
  }
  return out;
}

function list($: CheerioAPI, el: Element, depth: number): string {
  const ordered = el.tagName.toLowerCase() === 'ol';
  const lines: string[] = [];
  let i = 1;
  for (const li of $(el).children('li').toArray() as Element[]) {
    const own = (li.children as AnyNode[]).filter((c) => !(c.type === 'tag' && ['ul', 'ol'].includes((c as Element).tagName.toLowerCase())));
    lines.push(`${'  '.repeat(depth)}${ordered ? `${i++}.` : '-'} ${inline($, own).trim()}`);
    for (const nested of $(li).children('ul,ol').toArray() as Element[]) lines.push(list($, nested, depth + 1));
  }
  return lines.join('\n');
}

function table($: CheerioAPI, el: Element): string {
  const rows = $(el).find('tr').toArray() as Element[];
  if (!rows.length) return '';
  const cells = rows.map((r) => ($(r).children('th,td').toArray() as Element[]).map((c) => inline($, c.children as AnyNode[]).trim().replace(/\|/g, '\\|')));
  const width = Math.max(...cells.map((c) => c.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')];
  const [head, ...body] = cells;
  return [`| ${pad(head).join(' | ')} |`, `| ${Array(width).fill('---').join(' | ')} |`, ...body.map((r) => `| ${pad(r).join(' | ')} |`)].join('\n');
}

export function htmlToMarkdown(html: string): string {
  const $ = load(`<body>${html}</body>`);
  const blocks: string[] = [];
  const walk = (nodes: AnyNode[]) => {
    for (const n of nodes) {
      if (n.type === 'text') {
        const t = (n as unknown as { data: string }).data.trim();
        if (t) blocks.push(t);
        continue;
      }
      if (n.type !== 'tag') continue;
      const el = n as Element;
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) blocks.push(`${'#'.repeat(Math.max(2, Number(tag[1])))} ${inline($, el.children as AnyNode[]).trim()}`);
      else if (tag === 'p') {
        const t = inline($, el.children as AnyNode[]).trim();
        if (t) blocks.push(t);
      } else if (tag === 'ul' || tag === 'ol') blocks.push(list($, el, 0));
      else if (tag === 'table') blocks.push(table($, el));
      else if (tag === 'blockquote') blocks.push(inline($, el.children as AnyNode[]).trim().split('\n').map((l) => `> ${l}`).join('\n'));
      else if (tag === 'hr') blocks.push('---');
      else if (tag === 'figure' || tag === 'div' || tag === 'section') walk(el.children as AnyNode[]);
      else {
        const t = inline($, [el]).trim();
        if (t) blocks.push(t);
      }
    }
  };
  walk($('body').contents().toArray());
  return blocks.filter(Boolean).join('\n\n');
}
