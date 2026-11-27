/**
 * The help assistant's answer as simple blocks (client-safe, no HTML from the answer is ever used as HTML): paragraphs,
 * headings, and numbered or bulleted lists whose items can have indented sub-points. Gemini writes Markdown such as
 * “1.  **Websites** …” with “    *   detail” under it; the numbering continues after such sub-points.
 */
export type AnswerBlock =
  | { kind: 'p'; text: string }
  | { kind: 'h'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: { text: string; sub: string[] }[] };

export type InlinePart = { kind: 'text' | 'bold' | 'code'; text: string };

export function answerBlocks(input: unknown): AnswerBlock[] {
  const text = typeof input === 'string' ? input : input == null ? '' : String(input);
  const blocks: AnswerBlock[] = [];
  let list: Extract<AnswerBlock, { kind: 'list' }> | null = null;
  let inCode = false;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    // A fenced code block: its lines as they are, one paragraph each.
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      list = null;
      continue;
    }
    if (inCode) {
      if (line.trim()) blocks.push({ kind: 'p', text: line });
      continue;
    }
    const indent = line.length - line.trimStart().length;
    const ordered = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*•+]\s+(.*)$/.exec(line);
    if ((bullet || ordered) && indent >= 2 && list && list.items.length) {
      list.items[list.items.length - 1].sub.push(bullet ? bullet[1] : ordered![2]);
      continue;
    }
    if (ordered || bullet) {
      const isOrdered = Boolean(ordered);
      if (!list || list.ordered !== isOrdered) {
        list = { kind: 'list', ordered: isOrdered, start: ordered ? Math.max(1, Number(ordered[1]) || 1) : 1, items: [] };
        blocks.push(list);
      }
      list.items.push({ text: ordered ? ordered[2] : bullet![1], sub: [] });
      continue;
    }
    // A blank line keeps a list open (Gemini often puts blank lines between its items).
    if (!line.trim()) continue;
    list = null;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    blocks.push(heading ? { kind: 'h', text: heading[1] } : { kind: 'p', text: line.trim() });
  }
  return blocks;
}

/** **bold** and `code` inside a line; everything else is plain text. */
export function inlineParts(text: string): InlinePart[] {
  const parts: InlinePart[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) parts.push({ kind: 'text', text: text.slice(last, m.index) });
    parts.push(m[1] !== undefined ? { kind: 'bold', text: m[1] } : { kind: 'code', text: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}
