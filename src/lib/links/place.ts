import { load, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element, Text } from 'domhandler';
import { normalizeText } from '../content/text';

/**
 * Insert links at exact phrase occurrences in body text (paragraphs, list
 * items, table cells — never headings), at most `maxPerBlock` links per
 * block (existing links count), each phrase and each URL only once, never
 * the primary focus keyword. When the first occurrence sits in a full block,
 * a later mention is used.
 */

export interface LinkRequest {
  anchor: string;
  url: string;
  kind: 'ext' | 'int';
}

export interface PlaceResult {
  html: string;
  placed: (LinkRequest & { block: string })[];
  skipped: (LinkRequest & { reason: string })[];
}

const BLOCKS = 'p, li, td';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Text is re-inserted as markup, so it must be escaped (a "<" in prose must stay text).
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function insideForbidden(node: AnyNode): boolean {
  for (let p = node.parent as Element | null; p; p = p.parent as Element | null) {
    const tag = p.tagName?.toLowerCase();
    if (!tag) continue;
    if (tag === 'a' || /^h[1-6]$/.test(tag) || tag === 'th' || tag === 'figcaption' || tag === 'code') return true;
    if (tag === 'p' && p.attribs?.['data-bas-internal-link'] !== undefined) return true;
  }
  return false;
}

function textNodes($: CheerioAPI, block: Element): Text[] {
  const out: Text[] = [];
  const walk = (n: AnyNode) => {
    if (n.type === 'text') {
      if (!insideForbidden(n)) out.push(n as Text);
      return;
    }
    if (n.type === 'tag') for (const c of (n as Element).children) walk(c);
  };
  for (const c of block.children) walk(c);
  void $;
  return out;
}

export function placeLinks(html: string, requests: LinkRequest[], opts: { keyword?: string | null; maxPerBlock?: number } = {}): PlaceResult {
  const $ = load(`<body>${html}</body>`);
  const max = opts.maxPerBlock ?? 2;
  const kw = opts.keyword ? normalizeText(opts.keyword) : null;
  const placed: PlaceResult['placed'] = [];
  const skipped: PlaceResult['skipped'] = [];
  const existingHrefs = new Set($('a[href]').toArray().map((a) => ($(a).attr('href') ?? '').trim()));
  const linkedAnchors = new Set($('a').toArray().map((a) => normalizeText($(a).text())));
  const blocks = $(BLOCKS)
    .toArray()
    .filter((b) => !insideForbidden(b) && !(b as Element).attribs?.['data-bas-internal-link']) as Element[];

  for (const req of requests) {
    const anchor = req.anchor.trim();
    const norm = normalizeText(anchor);
    if (!anchor || anchor.length < 2) {
      skipped.push({ ...req, reason: 'empty anchor' });
      continue;
    }
    if (kw && norm === kw) {
      skipped.push({ ...req, reason: 'anchor is the primary focus keyword' });
      continue;
    }
    if (existingHrefs.has(req.url)) {
      skipped.push({ ...req, reason: 'URL already linked in the article' });
      continue;
    }
    if (linkedAnchors.has(norm)) {
      skipped.push({ ...req, reason: 'phrase already linked' });
      continue;
    }
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(anchor)}(?![\\p{L}\\p{N}])`, 'u');
    let done = false;
    let sawFullBlock = false;
    let sawAny = false;
    for (const block of blocks) {
      for (const node of textNodes($, block)) {
        const m = re.exec(node.data);
        if (!m) continue;
        sawAny = true;
        if ($(block).find('a').length >= max) {
          sawFullBlock = true;
          break; // try a later mention in another block
        }
        const before = node.data.slice(0, m.index);
        const after = node.data.slice(m.index + m[0].length);
        const attrs = `href="${escapeHtml(req.url).replace(/"/g, '&quot;')}" data-bas-link="${req.kind}"${req.kind === 'ext' ? ' rel="noopener"' : ''}`;
        // Replace the text node with escaped text + link + escaped text (cheerio's before() does not work on text nodes).
        $(node).replaceWith(`${escapeHtml(before)}<a ${attrs}>${escapeHtml(m[0])}</a>${escapeHtml(after)}`);
        placed.push({ ...req, block: $(block).text().slice(0, 80) });
        existingHrefs.add(req.url);
        linkedAnchors.add(norm);
        done = true;
        break;
      }
      if (done) break;
    }
    if (!done) skipped.push({ ...req, reason: !sawAny ? 'phrase not found in body text (headings and existing links excluded)' : sawFullBlock ? 'every paragraph containing the phrase already has 2 links' : 'phrase not placeable' });
  }
  return { html: $('body').html() ?? html, placed, skipped };
}
