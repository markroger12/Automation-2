import { load, type CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

/**
 * Lossless rich-text marks for the humanizer. A paragraph's inner HTML
 * becomes plain text with {L1}anchor{/L1}, {b}bold{/b} and {i}italic{/i}
 * marks; links keep their original tag and inner HTML for restoration.
 * Paragraphs with other inline markup are not tokenized (left untouched).
 */

export interface LinkMark {
  n: number;
  openTag: string;
  innerHtml: string;
  innerText: string;
}

export interface TokenizedParagraph {
  text: string;
  links: LinkMark[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
/** Text never contains our mark syntax; braces are escaped as look-alikes so they cannot forge marks. */
const neutral = (s: string) => s.replace(/\{/g, '｛').replace(/\}/g, '｝');

function openTag($: CheerioAPI, el: Element): string {
  const attrs = Object.entries(el.attribs ?? {})
    .map(([k, v]) => `${k}="${escAttr(v)}"`)
    .join(' ');
  return `<${el.tagName}${attrs ? ' ' + attrs : ''}>`;
}

/** Tokenize a paragraph's inner HTML, or return null when it holds markup that cannot be edited safely. */
export function tokenizeParagraph(innerHtml: string): TokenizedParagraph | null {
  const $ = load(`<body>${innerHtml}</body>`);
  const links: LinkMark[] = [];
  let ok = true;
  const walk = (nodes: AnyNode[], inLink: boolean): string => {
    let out = '';
    for (const node of nodes) {
      if (node.type === 'text') {
        out += neutral((node as unknown as { data: string }).data);
        continue;
      }
      if (node.type !== 'tag') continue;
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a' && !inLink) {
        const n = links.length + 1;
        const innerText = $(el).text();
        links.push({ n, openTag: openTag($, el), innerHtml: $(el).html() ?? '', innerText });
        out += `{L${n}}${neutral(innerText)}{/L${n}}`;
      } else if ((tag === 'strong' || tag === 'b') && !inLink) {
        const inner = walk(el.children, inLink);
        if (/\{\/?(b|i|L\d+)\}/.test(inner)) ok = false; // nested marks are not editable losslessly
        out += `{b}${inner}{/b}`;
      } else if ((tag === 'em' || tag === 'i') && !inLink) {
        const inner = walk(el.children, inLink);
        if (/\{\/?(b|i|L\d+)\}/.test(inner)) ok = false;
        out += `{i}${inner}{/i}`;
      } else {
        ok = false;
      }
    }
    return out;
  };
  const text = walk($('body').contents().toArray(), false).replace(/\s+/g, ' ').trim();
  return ok ? { text, links } : null;
}

/** Inner texts of every mark, for fact locks. `stray` = an unmatched or malformed mark remains. */
export function markSpans(text: string): { links: { n: number; inner: string }[]; bold: string[]; italic: string[]; stray: boolean } {
  const links: { n: number; inner: string }[] = [];
  const bold: string[] = [];
  const italic: string[] = [];
  let rest = text.replace(/\{L(\d+)\}([\s\S]*?)\{\/L\1\}/g, (_, n: string, inner: string) => {
    links.push({ n: Number(n), inner });
    return ' ';
  });
  rest = rest.replace(/\{b\}([\s\S]*?)\{\/b\}/g, (_, inner: string) => {
    bold.push(inner);
    return ' ';
  });
  rest = rest.replace(/\{i\}([\s\S]*?)\{\/i\}/g, (_, inner: string) => {
    italic.push(inner);
    return ' ';
  });
  return { links, bold, italic, stray: /\{\/?(?:b|i|L\d+)\}/.test(rest) };
}

/** Plain text of a marked paragraph (marks removed, look-alike braces restored). */
export function plainText(text: string): string {
  return text
    .replace(/\{\/?(?:b|i|L\d+)\}/g, '')
    .replace(/｛/g, '{')
    .replace(/｝/g, '}')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Rebuild paragraph HTML from (validated) marked text. Links get their original tag and inner HTML back. */
export function restoreParagraph(text: string, links: LinkMark[]): string {
  const byN = new Map(links.map((l) => [l.n, l]));
  const parts: string[] = [];
  const re = /\{L(\d+)\}([\s\S]*?)\{\/L\1\}|\{b\}([\s\S]*?)\{\/b\}|\{i\}([\s\S]*?)\{\/i\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const plain = (s: string) => esc(s.replace(/｛/g, '{').replace(/｝/g, '}'));
  while ((m = re.exec(text))) {
    parts.push(plain(text.slice(last, m.index)));
    if (m[1]) {
      const link = byN.get(Number(m[1]));
      parts.push(link ? `${link.openTag}${link.innerHtml}</a>` : plain(m[2]));
    } else if (m[3] !== undefined) parts.push(`<strong>${plain(m[3])}</strong>`);
    else parts.push(`<em>${plain(m[4])}</em>`);
    last = re.lastIndex;
  }
  parts.push(plain(text.slice(last)));
  return parts.join('');
}
