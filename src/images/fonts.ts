import fs from 'node:fs';
import path from 'node:path';
import opentype from 'opentype.js';
import { fontChoice, nearestWeight } from '@/lib/fonts';
import { projectRoot } from '@/lib/paths';

/**
 * Bundled fonts for the renderer (src/lib/fonts.ts lists them). Text in such a font is drawn as shapes from the font
 * file itself, so the picture is the same on every computer, whatever fonts are installed there; lines are broken by
 * the real letter widths. A text with a letter the font does not have is drawn with system fonts, as before.
 */

const cache = new Map<string, opentype.Font | null>();

export function loadFont(id: string, weight: number): opentype.Font | null {
  const choice = fontChoice(id);
  if (!choice.bundled || choice.id !== id) return null;
  const w = nearestWeight(choice, weight);
  const key = `${id}-${w}`;
  if (cache.has(key)) return cache.get(key) ?? null;
  let font: opentype.Font | null = null;
  try {
    const buf = fs.readFileSync(path.join(projectRoot(), 'public', 'fonts', id, `${id}-${w}.woff`));
    font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } catch {
    font = null;
  }
  cache.set(key, font);
  return font;
}

/** Every letter of the text is in the font (spaces aside). */
export function covers(font: opentype.Font, text: string): boolean {
  for (const ch of text) if (!/\s/.test(ch) && font.charToGlyph(ch).index === 0) return false;
  return true;
}

export const measure = (font: opentype.Font, text: string, size: number) => font.getAdvanceWidth(text, size);

function fitWithEllipsis(font: opentype.Font, text: string, size: number, width: number): string {
  let t = text;
  while (t.length > 1 && measure(font, `${t}…`, size) > width) t = t.slice(0, -1).trimEnd();
  return `${t}…`;
}

/** Greedy word wrap by real widths; a cut text ends with “…” (as wrapText does for system fonts). */
export function wrapMeasured(font: opentype.Font, text: string, size: number, width: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (measure(font, next, size) <= width) line = next;
    else {
      if (line) lines.push(line);
      line = measure(font, word, size) > width ? fitWithEllipsis(font, word, size, width) : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = fitWithEllipsis(font, `${kept[maxLines - 1]} ${lines[maxLines]}`, size, width);
    return kept;
  }
  return lines;
}

/** Path data of the lines, aligned in a box of the given width; baselines as the system-font text uses them. */
export function linesPath(font: opentype.Font, lines: string[], o: { size: number; width: number; padding: number; lineHeight: number; align: 'left' | 'center' | 'right' }): string {
  return lines
    .map((l, i) => {
      const lw = measure(font, l, o.size);
      const x = o.align === 'center' ? (o.width - lw) / 2 : o.align === 'right' ? o.width - o.padding - lw : o.padding;
      return font.getPath(l, x, o.padding + o.size + i * o.size * o.lineHeight, o.size).toPathData(2);
    })
    .join(' ');
}
