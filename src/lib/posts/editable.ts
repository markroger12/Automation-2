import { load, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';
import { htmlToMarkdown } from '@/lib/content/html-to-markdown';
import { markdownToHtml } from '@/lib/content/markdown';
import { stripTags, wordCount } from '@/lib/content/text';
import { markRichText, restoreRichText, type MarkedLink } from '@/lib/seo/correction';
import { htmlToBlocks } from '@/wordpress/blocks';

/**
 * “Update to latest” (owner request 2026-11-27): a WordPress post as an article ChatGPT can update, and ChatGPT's
 * answer back as the same kind of post content.
 *
 * Only text is given to ChatGPT: paragraphs, headings, lists and tables. Everything else stays exactly as it is in
 * WordPress (images, embeds, galleries, ads, shortcodes, quotes, styled or nested blocks) and travels as a mark {K1},
 * {K2}…, the same way links travel as {L1}…{/L1} (seo/correction.ts). The answer is accepted only when every mark is
 * back (checks.ts), and each mark gets its original content again, byte for byte.
 */

export type PostEditor = 'GUTENBERG' | 'CLASSIC';

export interface Kept {
  n: number;
  raw: string;
  /** A whole block (on its own line in the article) or a part inside a sentence (an image, a shortcode). */
  block: boolean;
  /** What it is, for messages: "image", "shortcode", "core/gallery"… */
  what: string;
}

export interface EditablePost {
  editor: PostEditor;
  /** For each table in order: whether it has a header row. */
  tableHeaders: boolean[];
  /** The article for ChatGPT: Markdown with the marks. */
  markdown: string;
  /** The editable text as HTML (the comparison), kept parts left out. */
  html: string;
  keeps: Kept[];
  links: MarkedLink[];
  /** Words ChatGPT can update, and words in the whole post. */
  editableWords: number;
  totalWords: number;
}

const OPEN = '';
const CLOSE = '';
const marker = (n: number) => `${OPEN}K${n}${CLOSE}`;
export const keepMark = (n: number) => `{K${n}}`;

/** Elements inside a sentence that are kept as they are. */
const INLINE_KEEP = 'img, iframe, script, style, video, audio, embed, object, svg, noscript, picture, canvas, form, input, button, select, textarea';
const SHORTCODE_RE = /\[(\/?)([a-zA-Z][a-zA-Z0-9_-]*)((?:\s[^\]]*)?)\]/g;
/** Gutenberg blocks whose text is updated (with no attributes beyond these, so no styling is lost). */
const TEXT_BLOCKS: Record<string, string[]> = {
  'core/paragraph': [],
  'core/heading': ['level'],
  'core/list': ['ordered'],
  'core/table': ['hasFixedLayout'],
};

// ---------------------------------------------------------------- Gutenberg blocks

interface RawBlock {
  /** core/paragraph …; null for content between blocks (or a whole post without blocks). */
  name: string | null;
  attrs: Record<string, unknown>;
  raw: string;
  /** The block's HTML without its own comments (and without inner block comments). */
  inner: string;
}

const BLOCK_COMMENT = /<!--\s+(\/)?wp:([a-z0-9-]+\/)?([a-z0-9-]+)(\s+(\{[\s\S]*?\}))?\s+(\/)?-->/g;

/** The top-level blocks of Gutenberg content, each with its exact original text. */
export function topLevelBlocks(raw: string): RawBlock[] {
  const out: RawBlock[] = [];
  let depth = 0;
  let start = 0;
  let current: { name: string; attrs: Record<string, unknown>; start: number } | null = null;
  const loose = (from: number, to: number) => {
    const text = raw.slice(from, to);
    if (text.trim()) out.push({ name: null, attrs: {}, raw: text.trim(), inner: text.trim() });
  };
  for (const m of raw.matchAll(BLOCK_COMMENT)) {
    const closing = Boolean(m[1]);
    const selfClosing = Boolean(m[6]);
    const name = `${m[2] ?? 'core/'}${m[3]}`;
    let attrs: Record<string, unknown> = {};
    try {
      attrs = m[5] ? (JSON.parse(m[5]) as Record<string, unknown>) : {};
    } catch {
      attrs = { __unreadable: true };
    }
    const at = m.index ?? 0;
    if (closing) {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && current) {
        const end = at + m[0].length;
        const blockRaw = raw.slice(current.start, end);
        out.push({ name: current.name, attrs: current.attrs, raw: blockRaw, inner: blockRaw.replace(/<!--\s+\/?wp:[\s\S]*?-->/g, '').trim() });
        current = null;
        start = end;
      }
      continue;
    }
    if (depth === 0) {
      loose(start, at);
      if (selfClosing) {
        const end = at + m[0].length;
        out.push({ name, attrs, raw: raw.slice(at, end), inner: '' });
        start = end;
        continue;
      }
      current = { name, attrs, start: at };
    }
    if (!selfClosing) depth++;
  }
  if (current) {
    // A block that is never closed: kept whole, as it is.
    out.push({ name: current.name, attrs: current.attrs, raw: raw.slice(current.start).trim(), inner: '' });
  } else loose(start, raw.length);
  return out;
}

function textBlock(b: RawBlock): boolean {
  const allowed = b.name ? TEXT_BLOCKS[b.name] : undefined;
  return Boolean(allowed) && Object.keys(b.attrs).every((k) => allowed!.includes(k)) && Boolean(b.inner);
}

// ---------------------------------------------------------------- classic content

const BLOCK_START = /^<(p|h[1-6]|ul|ol|li|table|thead|tbody|tr|blockquote|div|figure|pre|hr|iframe|script|style|form|section|article|aside|header|footer|nav|dl|address|details|!--)[\s>/]/i;

/**
 * WordPress's own paragraphs for classic content (wpautop, simplified): a blank line between paragraphs. A part that
 * is only shortcodes (a gallery, an ad) or only an address (an embed) is kept as it is.
 */
function classicParts(raw: string): { html: string; keep: string | null }[] {
  return raw
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      if (!chunk.replace(SHORTCODE_RE, '').trim()) return { html: chunk, keep: 'shortcode' };
      if (/^https?:\/\/\S+$/.test(chunk)) return { html: chunk, keep: 'embed' };
      if (BLOCK_START.test(chunk)) return { html: chunk, keep: null };
      return { html: `<p>${chunk.replace(/\n/g, '<br>')}</p>`, keep: null };
    });
}

// ---------------------------------------------------------------- the article for ChatGPT

const TEXT_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table']);
const INLINE_TAGS = new Set(['a', 'abbr', 'b', 'br', 'cite', 'code', 'del', 'em', 'i', 'img', 'ins', 'mark', 'q', 's', 'small', 'span', 'strong', 'sub', 'sup', 'u']);

/** Inline parts of a text element kept as marks: elements that are not text, and shortcodes. */
function markInline($: CheerioAPI, root: Element, keeps: Kept[]) {
  $(root)
    .find(INLINE_KEEP)
    .each((_, el) => {
      if ($(el).parents(INLINE_KEEP).length) return;
      // A link around an image is kept whole.
      const holder = $(el).parent('a').length && !$(el).parent('a').text().trim() ? $(el).parent('a') : $(el);
      const n = keeps.length + 1;
      keeps.push({ n, raw: $.html(holder), block: false, what: (holder[0] as Element).tagName === 'a' ? 'linked image' : (el as Element).tagName });
      holder.replaceWith(marker(n));
    });
  $(root)
    .find('*')
    .addBack()
    .contents()
    .each((_, node) => {
      if (node.type !== 'text') return;
      const t = node as unknown as { data: string };
      if (!SHORTCODE_RE.test(t.data)) return;
      SHORTCODE_RE.lastIndex = 0;
      t.data = t.data.replace(SHORTCODE_RE, (sc: string, _slash: string, name: string) => {
        const n = keeps.length + 1;
        keeps.push({ n, raw: sc, block: false, what: `shortcode [${name}]` });
        return marker(n);
      });
    });
}

/** The post's content as the article for ChatGPT (Markdown with marks), and what is kept aside. */
export function editablePost(raw: string): EditablePost {
  const editor: PostEditor = /<!--\s+wp:/.test(raw) ? 'GUTENBERG' : 'CLASSIC';
  const keeps: Kept[] = [];
  const pieces: string[] = [];
  /** For each table in order: whether it has a header row (Markdown tables always have one). */
  const tables: boolean[] = [];
  const keepBlock = (rawPart: string, what: string) => {
    const n = keeps.length + 1;
    keeps.push({ n, raw: rawPart, block: true, what });
    pieces.push(`<p>${marker(n)}</p>`);
  };
  /** A text element: the table of a table figure counts as the table. */
  const textElement = ($: CheerioAPI, node: AnyNode): Element | null => {
    if (node.type !== 'tag') return null;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (TEXT_TAGS.has(tag)) return el;
    if (tag === 'figure') {
      const children = $(el).children().toArray() as Element[];
      if (children.length === 1 && children[0].tagName.toLowerCase() === 'table' && !$(el).text().replace($(children[0]).text(), '').trim()) return children[0];
    }
    return null;
  };
  /**
   * HTML whose text ChatGPT may update. `whole`: a Gutenberg text block, kept whole (as it is) when it holds anything
   * but text; otherwise each element that is not text is kept on its own.
   */
  const addHtml = (html: string, what: string, whole: string | null) => {
    const $ = load(`<body>${html}</body>`);
    const nodes = $('body')
      .contents()
      .toArray()
      .filter((n) => n.type === 'tag' || (n.type === 'text' && (n as unknown as { data: string }).data.trim()));
    if (whole !== null && (!nodes.length || nodes.some((n) => !textElement($, n)))) {
      keepBlock(whole, what);
      return;
    }
    // Text and inline elements next to each other at the top level are one paragraph (as WordPress shows them).
    let run: AnyNode[] = [];
    const flush = () => {
      if (!run.length) return;
      const inner = run.map((n) => $.html(n)).join('').trim();
      run = [];
      if (!inner) return;
      const holder = load(`<body><p>${inner.replace(/\n+/g, ' ')}</p></body>`);
      markInline(holder, holder('p')[0] as Element, keeps);
      pieces.push(holder('body').html() ?? '');
    };
    for (const node of nodes) {
      if (node.type === 'text' || (node.type === 'tag' && INLINE_TAGS.has((node as Element).tagName.toLowerCase()))) {
        run.push(node);
        continue;
      }
      flush();
      const el = textElement($, node);
      if (!el) {
        keepBlock($.html(node), (node as Element).tagName.toLowerCase());
        continue;
      }
      markInline($, el, keeps);
      if (el.tagName.toLowerCase() === 'table') tables.push($(el).find('th').length > 0);
      pieces.push($.html(el));
    }
    flush();
  };

  const classic = (content: string) => {
    for (const part of classicParts(content)) part.keep ? keepBlock(part.html, part.keep) : addHtml(part.html, 'html', null);
  };
  if (editor === 'GUTENBERG') {
    for (const b of topLevelBlocks(raw)) {
      if (b.name === 'core/freeform' || (b.name === null && !/<!--/.test(b.raw))) classic(b.inner);
      else if (textBlock(b)) addHtml(b.inner, b.name!, b.raw);
      else keepBlock(b.raw, b.name ?? 'html');
    }
  } else classic(raw);

  const html = pieces.join('\n');
  const marked = markRichText(html);
  const markdown = htmlToMarkdown(marked.html).replace(new RegExp(`${OPEN}K(\\d+)${CLOSE}`, 'g'), (_m, n: string) => keepMark(Number(n)));
  const editableHtml = html.replace(new RegExp(`<p>${OPEN}K\\d+${CLOSE}</p>\\n?`, 'g'), '').replace(new RegExp(`${OPEN}K\\d+${CLOSE}`, 'g'), '');
  return {
    editor,
    tableHeaders: tables,
    markdown: markdown.trim(),
    html: editableHtml,
    keeps,
    links: marked.links,
    editableWords: wordCount(stripTags(editableHtml)),
    totalWords: wordCount(stripTags(raw.replace(/<!--[\s\S]*?-->/g, ' '))),
  };
}

// ---------------------------------------------------------------- the answer back as post content

export interface MarkUse {
  missing: Kept[];
  repeated: Kept[];
  unknown: number[];
}

/** Which kept parts the answer leaves out, repeats, or invents. */
export function markUse(markdown: string, keeps: Kept[]): MarkUse {
  const counts = new Map<number, number>();
  for (const m of markdown.matchAll(/\{K(\d+)\}/g)) counts.set(Number(m[1]), (counts.get(Number(m[1])) ?? 0) + 1);
  const known = new Set(keeps.map((k) => k.n));
  return {
    missing: keeps.filter((k) => !counts.get(k.n)),
    repeated: keeps.filter((k) => (counts.get(k.n) ?? 0) > 1),
    unknown: [...counts.keys()].filter((n) => !known.has(n)),
  };
}

export interface RebuiltPost {
  /** What is written to WordPress (blocks or classic HTML). */
  raw: string;
  /** The updated editable text as HTML (the comparison), kept parts left out. */
  html: string;
}

/**
 * ChatGPT's article (Markdown with the marks) as post content for the same editor: its text as new blocks (or classic
 * HTML), each kept part back in its place exactly as it was.
 */
export function rebuildPost(answerMarkdown: string, post: Pick<EditablePost, 'editor' | 'keeps' | 'links' | 'tableHeaders'>): RebuiltPost {
  const byN = new Map(post.keeps.map((k) => [k.n, k]));
  const html = restoreRichText(markdownToHtml(answerMarkdown), post.links);
  const $ = load(`<body>${html}</body>`);
  // A Markdown table always has a header row: a table that had none gets its first row back as an ordinary row.
  $('table').each((i, table) => {
    if (post.tableHeaders[i] !== false) return;
    const head = $(table).find('thead tr');
    if (!head.length) return;
    head.find('th').each((_, th) => {
      th.tagName = 'td';
    });
    const body = $(table).find('tbody');
    if (body.length) body.prepend(head);
    else $(table).append($('<tbody>').append(head));
    $(table).find('thead').remove();
  });
  const segments: { kind: 'html' | 'keep'; text: string }[] = [];
  const pushHtml = (h: string) => {
    const last = segments[segments.length - 1];
    if (last?.kind === 'html') last.text += h;
    else segments.push({ kind: 'html', text: h });
  };
  const compare: string[] = [];
  for (const node of $('body').contents().toArray()) {
    if (node.type !== 'tag') {
      const text = node.type === 'text' ? (node as unknown as { data: string }).data.trim() : '';
      if (text) pushHtml(`<p>${$('<div>').text(text).html()}</p>`);
      continue;
    }
    const el = $(node as AnyNode);
    const alone = /^\{K(\d+)\}$/.exec(el.text().trim());
    if (alone && byN.get(Number(alone[1]))?.block && !el.find('img, a').length) {
      segments.push({ kind: 'keep', text: byN.get(Number(alone[1]))!.raw });
      continue;
    }
    // Block marks inside other text: the kept block follows the element it was written in.
    const after: string[] = [];
    let outer = $.html(node as AnyNode).replace(/\{K(\d+)\}/g, (m, n: string) => {
      const k = byN.get(Number(n));
      if (!k) return '';
      if (k.block) {
        after.push(k.raw);
        return '';
      }
      return k.raw;
    });
    if (!stripTags(outer).trim() && !/<(img|iframe|video|audio|embed|object|svg|picture)\b/i.test(outer)) outer = '';
    compare.push($.html(node as AnyNode).replace(/\{K\d+\}/g, ''));
    if (outer) pushHtml(outer);
    for (const raw of after) segments.push({ kind: 'keep', text: raw });
  }
  const raw = segments
    .map((s) => (s.kind === 'keep' ? s.text : post.editor === 'GUTENBERG' ? htmlToBlocks(s.text) : s.text))
    .filter((s) => s.trim())
    .join('\n\n');
  return { raw, html: compare.join('\n') };
}
