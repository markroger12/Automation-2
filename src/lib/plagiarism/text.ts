import { load, type Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';

/**
 * Text model for the Plagiarism Evidence Checker: readable blocks of an
 * article or a fetched page, word tokens with their character offsets (so
 * evidence can be shown in the original wording) and quotation marks, whose
 * words are exempt from evidence (quoting a source is not copying it).
 */

export interface Segment {
  text: string;
  /** The whole block is a quotation (blockquote / q). */
  quote: boolean;
  /** The block is a heading (h1–h6). */
  heading?: boolean;
}

export interface Token {
  /** Normalized form used for matching. */
  norm: string;
  start: number;
  end: number;
  /** Inside a quotation. */
  quoted: boolean;
}

export interface TextModel {
  /** Blocks joined by blank lines; token offsets point into it. */
  text: string;
  tokens: Token[];
  /** Character ranges of the blocks in `text`. */
  blocks: { start: number; end: number; quote: boolean }[];
}

const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, td, th, dt, dd, figcaption, pre';
const DROP = 'script, style, noscript, template, nav, header, footer, aside, form, iframe, svg, button, select, [role="navigation"], [aria-hidden="true"], .navbox, .reflist, .references, .mw-editsection, #toc, .toc';

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Readable blocks of HTML (article or page). Pages use their main content when it is substantial. */
export function htmlSegments(html: string, opts: { page?: boolean } = {}): Segment[] {
  const $ = load(html);
  $(DROP).remove();
  // Inline <q> quotations get typographic quotes so the token pass exempts them.
  $('q').each((_, el) => {
    const q = $(el);
    q.replaceWith(`“${q.text()}”`);
  });
  // load() always wraps content in <html><body>.
  let root: Cheerio<AnyNode> = $('body').first();
  if (opts.page) {
    for (const sel of ['article', 'main', '[role="main"]', '#mw-content-text', '#content']) {
      const el = $(sel).first();
      if (el.length && squash(el.text()).split(' ').length >= 150) {
        root = el;
        break;
      }
    }
  }
  const out: Segment[] = [];
  // Innermost blocks only (a <li> holding a <p> yields the <p>).
  root.find(BLOCKS).each((_, el) => {
    const node = $(el);
    if (node.find(BLOCKS).length && !node.is('blockquote')) return;
    if (node.parents('blockquote').length) return;
    const quote = node.is('blockquote') || node.closest('blockquote').length > 0;
    const text = squash(node.text());
    if (text) out.push({ text, quote, heading: node.is('h1, h2, h3, h4, h5, h6') });
  });
  if (!out.length) {
    const text = squash(root.text());
    if (text) out.push({ text, quote: false });
  }
  return out;
}

/** Plain text or HTML from the owner (paste). Plain text paragraphs are separated by blank lines. */
export function inputSegments(input: string): Segment[] {
  if (/<\s*(p|h[1-6]|li|div|blockquote|br)\b/i.test(input)) return htmlSegments(input);
  return input
    .split(/\n\s*\n/)
    .map((p) => squash(p))
    .filter(Boolean)
    .map((text) => ({ text, quote: false }));
}

// Opening → closing quotation marks (EN, DE, FR, straight).
const QUOTE_PAIRS: [string, string][] = [
  ['“', '”'],
  ['„', '“'],
  ['«', '»'],
  ['»', '«'],
  ['"', '"'],
];

/** Character ranges inside quotation marks (≥ 3 words, closed within the block). */
function quoteRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let i = 0;
  while (i < text.length) {
    const pair = QUOTE_PAIRS.find(([open]) => text[i] === open);
    if (!pair) {
      i++;
      continue;
    }
    const close = text.indexOf(pair[1], i + 1);
    if (close === -1) {
      i++;
      continue;
    }
    const inner = text.slice(i + 1, close);
    if (inner.split(/\s+/).filter(Boolean).length >= 3 && inner.length <= 1200) ranges.push([i, close + 1]);
    i = close + 1;
  }
  return ranges;
}

const WORD = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;

export function normalizeWord(w: string): string {
  return w.normalize('NFKC').toLowerCase().replace(/’/g, "'");
}

export function buildTextModel(segments: Segment[]): TextModel {
  let text = '';
  const tokens: Token[] = [];
  const blocks: TextModel['blocks'] = [];
  for (const seg of segments) {
    if (text) text += '\n\n';
    const offset = text.length;
    text += seg.text;
    blocks.push({ start: offset, end: offset + seg.text.length, quote: seg.quote });
    const quoted = seg.quote ? [[0, seg.text.length] as [number, number]] : quoteRanges(seg.text);
    for (const m of seg.text.matchAll(WORD)) {
      const start = m.index!;
      tokens.push({ norm: normalizeWord(m[0]), start: offset + start, end: offset + start + m[0].length, quoted: quoted.some(([a, b]) => start >= a && start < b) });
    }
  }
  return { text, tokens, blocks };
}

export const STOPWORDS = new Set(
  (
    'a an the and or but if of to in on at by for with from as is are was were be been being it its this that these those he she they we you i his her their our your my me him them us ' +
    'not no so than then there here when where who whom which what why how all any both each few more most other some such only own same too very can will just do does did has have had ' +
    'into over under about after before between through during out up down off again further once also would could should may might must shall ' +
    'der die das den dem des ein eine einer eines einem einen und oder aber wenn als auch an auf aus bei bis durch für gegen in im ins mit nach ohne seit über um unter von vor zu zum zur ' +
    'ist sind war waren sein wird werden wurde wurden hat haben hatte hatten es er sie wir ihr ich du man sich nicht kein keine noch nur schon sehr so wie was wer wo dass ob doch denn dann da ' +
    'diese dieser dieses diesen diesem jede jeder jedes alle viel viele mehr hier dort'
  ).split(' '),
);

export const isContentWord = (norm: string) => norm.length > 2 && !STOPWORDS.has(norm) && !/^\d{1,2}$/.test(norm);

/** Sentences of the text as token index ranges [start, end). */
export function sentenceRanges(model: TextModel): [number, number][] {
  const out: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < model.tokens.length; i++) {
    const t = model.tokens[i];
    const next = model.tokens[i + 1];
    const between = next ? model.text.slice(t.end, next.start) : '';
    // Sentence ends at . ! ? (not inside numbers like 3.5 or abbreviations followed by lowercase) or at a block break.
    const breaks = !next || /\n\n/.test(between) || (/[.!?…]["”»“’)]*\s/.test(between) && !/^[\p{Ll}]/u.test(model.text.slice(next.start, next.start + 1)));
    if (breaks) {
      if (i + 1 > start) out.push([start, i + 1]);
      start = i + 1;
    }
  }
  return out;
}
