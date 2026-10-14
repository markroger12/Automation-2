import { load, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

/**
 * Article HTML → Gutenberg block markup. Uses conservative, current core
 * block forms (validated against a real WordPress 6.5 and 6.7 block editor);
 * anything unusual becomes a Custom HTML block, which is always valid. After
 * saving, the editor check re-validates the blocks in the site's own editor
 * and falls back to plain HTML (one Classic block) if any block is invalid.
 */

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => esc(s).replace(/"/g, '&quot;');
const attrJson = (attrs: Record<string, unknown>) => (Object.keys(attrs).length ? ` ${JSON.stringify(attrs)}` : '');

function block(name: string, attrs: Record<string, unknown>, inner: string): string {
  return `<!-- wp:${name}${attrJson(attrs)} -->\n${inner}\n<!-- /wp:${name} -->`;
}

const INLINE = new Set(['a', 'strong', 'em', 'b', 'i', 'u', 'code', 'sup', 'sub', 'span', 'br', 'mark', 's']);

function isInlineOnly($: CheerioAPI, el: Element): boolean {
  let ok = true;
  $(el)
    .find('*')
    .each((_, d) => {
      if (!INLINE.has((d as Element).tagName.toLowerCase())) ok = false;
    });
  return ok;
}

function innerHtml($: CheerioAPI, el: Element): string {
  return ($(el).html() ?? '').trim();
}

function listBlock($: CheerioAPI, el: Element): string | null {
  const ordered = el.tagName.toLowerCase() === 'ol';
  const items: string[] = [];
  for (const li of $(el).children().toArray() as Element[]) {
    if (li.tagName.toLowerCase() !== 'li') return null;
    const nested = $(li).children('ul,ol').toArray() as Element[];
    const clone = $(li).clone();
    clone.children('ul,ol').remove();
    const text = (clone.html() ?? '').trim();
    if ($(clone).find('*').toArray().some((d) => !INLINE.has((d as Element).tagName.toLowerCase()))) return null;
    const nestedBlocks: string[] = [];
    for (const n of nested) {
      const b = listBlock($, n);
      if (!b) return null;
      nestedBlocks.push(b);
    }
    items.push(block('list-item', {}, `<li>${text}${nestedBlocks.join('')}</li>`));
  }
  const tag = ordered ? 'ol' : 'ul';
  return block('list', ordered ? { ordered: true } : {}, `<${tag} class="wp-block-list">${items.join('')}</${tag}>`);
}

function cellHtml($: CheerioAPI, cell: Element): string | null {
  if (!isInlineOnly($, cell)) return null;
  const tag = cell.tagName.toLowerCase();
  const attrs: string[] = [];
  for (const a of ['colspan', 'rowspan']) {
    const v = $(cell).attr(a);
    if (v && /^\d+$/.test(v)) attrs.push(`${a}="${v}"`);
  }
  return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${innerHtml($, cell)}</${tag}>`;
}

function tableBlock($: CheerioAPI, table: Element, className?: string): string | null {
  const sections: string[] = [];
  const rowsOf = (sel: Element) => $(sel).children('tr').toArray() as Element[];
  const renderRows = (rows: Element[]) => {
    const out: string[] = [];
    for (const tr of rows) {
      const cells: string[] = [];
      for (const c of $(tr).children().toArray() as Element[]) {
        const tag = c.tagName.toLowerCase();
        if (tag !== 'td' && tag !== 'th') return null;
        const h = cellHtml($, c);
        if (h === null) return null;
        cells.push(h);
      }
      out.push(`<tr>${cells.join('')}</tr>`);
    }
    return out.join('');
  };
  for (const child of $(table).children().toArray() as Element[]) {
    const tag = child.tagName.toLowerCase();
    if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      const r = renderRows(rowsOf(child));
      if (r === null) return null;
      sections.push(`<${tag}>${r}</${tag}>`);
    } else if (tag === 'tr') {
      const r = renderRows([child]);
      if (r === null) return null;
      sections.push(`<tbody>${r}</tbody>`);
    } else return null;
  }
  // Merge consecutive bare rows that were wrapped one-by-one.
  const html = sections.join('').replace(/<\/tbody><tbody>/g, '');
  const attrs: Record<string, unknown> = { hasFixedLayout: false };
  if (className) attrs.className = className;
  return block('table', attrs, `<figure class="wp-block-table${className ? ' ' + className : ''}"><table>${html}</table></figure>`);
}

function nodeToBlock($: CheerioAPI, node: AnyNode): string | null {
  if (node.type === 'text') {
    const text = (node as unknown as { data: string }).data.trim();
    return text ? block('paragraph', {}, `<p>${esc(text)}</p>`) : null;
  }
  if (node.type !== 'tag') return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const html = $.html(el);
  const fallback = () => block('html', {}, html);
  switch (tag) {
    case 'p': {
      if (!isInlineOnly($, el)) return fallback();
      const cls = $(el).attr('class');
      const inner = innerHtml($, el);
      if (!inner) return null;
      if (cls && /^[a-z0-9 _-]+$/i.test(cls)) return block('paragraph', { className: cls }, `<p class="${cls}">${inner}</p>`);
      if (cls || Object.keys(el.attribs).some((a) => a !== 'class' && !a.startsWith('data-bas-'))) return fallback();
      return block('paragraph', {}, `<p>${inner}</p>`);
    }
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      if (!isInlineOnly($, el)) return fallback();
      const level = Number(tag.slice(1));
      return block('heading', level === 2 ? {} : { level }, `<${tag} class="wp-block-heading">${innerHtml($, el)}</${tag}>`);
    }
    case 'ul':
    case 'ol':
      return listBlock($, el) ?? fallback();
    case 'table':
      return tableBlock($, el, safeClass($(el).attr('class'))) ?? fallback();
    case 'figure': {
      const table = $(el).children('table').toArray() as Element[];
      if (table.length === 1 && $(el).children().length === 1) return tableBlock($, table[0], safeClass($(table[0]).attr('class'))) ?? fallback();
      const img = $(el).children('img').first();
      const wpId = Number(img.attr('data-wp-id') ?? /wp-image-(\d+)/.exec(img.attr('class') ?? '')?.[1]);
      if (img.length && $(el).children().length === 1 && wpId > 0 && img.attr('src')) {
        const alt = img.attr('alt') ?? '';
        return block('image', { id: wpId, sizeSlug: 'full', linkDestination: 'none' }, `<figure class="wp-block-image size-full"><img src="${attr(img.attr('src')!)}" alt="${attr(alt)}" class="wp-image-${wpId}"/></figure>`);
      }
      return fallback();
    }
    default:
      return fallback();
  }
}

function safeClass(cls: string | undefined): string | undefined {
  return cls && /^[a-z0-9 _-]+$/i.test(cls) ? cls.trim() : undefined;
}

export function htmlToBlocks(html: string): string {
  const $ = load(`<body>${html}</body>`);
  const out: string[] = [];
  for (const node of $('body').contents().toArray()) {
    const b = nodeToBlock($, node);
    if (b) out.push(b);
  }
  return out.join('\n\n');
}

/** Plain HTML for the Classic editor (no newlines inside elements, which wpautop would turn into <br>). */
export function htmlForClassic(html: string): string {
  const $ = load(`<body>${html}</body>`);
  const parts: string[] = [];
  for (const node of $('body').contents().toArray()) {
    if (node.type === 'text') {
      const t = (node as unknown as { data: string }).data.trim();
      if (t) parts.push(`<p>${esc(t)}</p>`);
      continue;
    }
    if (node.type !== 'tag') continue;
    $(node)
      .find('img[data-wp-id]')
      .each((_, img) => {
        const id = $(img).attr('data-wp-id');
        $(img).attr('class', `aligncenter size-full wp-image-${id}`).removeAttr('data-wp-id').removeAttr('data-bas-media');
      });
    parts.push($.html(node).replace(/\s*\n\s*/g, ' '));
  }
  return parts.join('\n\n');
}
