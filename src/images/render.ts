import sharp, { type OverlayOptions } from 'sharp';
import { CANVAS, penPathD, sanitizeSvg, type ImageTemplate, type Layer, type PenPoint } from '@/lib/image-template';
import { fontChoice } from '@/lib/fonts';
import { covers, linesPath, loadFont, wrapMeasured } from './fonts';

/**
 * The production image renderer (also used for the designer's live preview).
 * Everything is composited with sharp in a true 1920×1080 canvas, then scaled
 * to the output size and encoded within the site's byte budget.
 */

export interface RenderInput {
  template: ImageTemplate;
  /** Photo slots 0 and 1 (missing slots fall back to slot 0, then to a flat accent panel). */
  photos: Buffer[];
  /** Optional focus per slot, in source-image fractions: a point, or the area around the main faces. */
  focus?: PhotoFocus[];
  logo?: Buffer | null;
  fixedPhotos?: Record<string, Buffer>;
  vars?: Record<string, string>;
}

type Area = { left: number; right: number; top: number; bottom: number };
/** Where a crop should centre: a point, and/or the area around the main faces, and each main face (fractions of the picture). */
export type PhotoFocus = { x: number; y: number; area?: Area; faces?: Area[] } | null;

export interface RenderOptions {
  width: number;
  height: number;
  maxBytes: number;
  format?: 'webp' | 'jpeg';
}

/** System font names for text drawn as SVG text (system fonts, or a bundled font missing a letter). */
function systemFonts(id: string): string {
  const f = fontChoice(id);
  return f.bundled ? `'${f.label}', ${f.css.split(', ').slice(1).join(', ')}` : f.css;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const resolveColor = (c: string | null | undefined, accent: string) => (!c ? 'none' : c === 'accent' ? accent : c === 'transparent' ? 'none' : c);

/** Fill {{title}}, {{site}}, {{keyword}} tokens with plain text. */
export function fillTokens(text: string, vars: Record<string, string> = {}): string {
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, k: string) => vars[k.toLowerCase()] ?? '');
}

/** Greedy word wrap using an average glyph width estimate; adds an ellipsis when cut. */
export function wrapText(text: string, fontSize: number, width: number, maxLines: number, weight = 700): string[] {
  const avg = fontSize * (weight >= 700 ? 0.56 : 0.52);
  const perLine = Math.max(4, Math.floor(width / avg));
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= perLine) line = next;
    else {
      if (line) lines.push(line);
      line = word.length > perLine ? `${word.slice(0, perLine - 1)}…` : word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1].replace(/[\s,.;:–-]+\S*$/, '')}…`;
    return kept;
  }
  return lines;
}

function svgBuffer(w: number, h: number, inner: string): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="0 0 ${Math.round(w)} ${Math.round(h)}">${inner}</svg>`);
}

/** A photo cut to its place's shape (rounded rectangle, circle or a pen-drawn shape) with the border drawn inside it. */
async function framed(buf: Buffer, w: number, h: number, l: { radius: number; shape: 'rect' | 'circle' | 'path'; points?: PenPoint[]; stroke: string | null; strokeWidth: number }, accent: string): Promise<Buffer> {
  const sw = l.stroke ? Math.min(l.strokeWidth, Math.min(w, h) / 2) : 0;
  if (l.shape === 'path' && l.points?.length) {
    const d = penPathD(l.points, true, w, h);
    const parts: OverlayOptions[] = [{ input: svgBuffer(w, h, `<path d="${d}" fill="#fff"/>`), blend: 'dest-in' }];
    // The border along the outline, inside the place (its outer half would fall outside the cut photo).
    if (sw) parts.push({ input: svgBuffer(w, h, `<defs><clipPath id="c"><path d="${d}"/></clipPath></defs><path d="${d}" fill="none" stroke="${esc(resolveColor(l.stroke!, accent))}" stroke-width="${sw * 2}" stroke-linejoin="round" clip-path="url(#c)"/>`) });
    return sharp(buf).ensureAlpha().composite(parts).png().toBuffer();
  }
  if (l.shape === 'circle') {
    const mask = svgBuffer(w, h, `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${w / 2}" ry="${h / 2}" fill="#fff"/>`);
    const parts: OverlayOptions[] = [{ input: mask, blend: 'dest-in' }];
    if (sw) parts.push({ input: svgBuffer(w, h, `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0, w / 2 - sw / 2)}" ry="${Math.max(0, h / 2 - sw / 2)}" fill="none" stroke="${esc(resolveColor(l.stroke!, accent))}" stroke-width="${sw}"/>`) });
    return sharp(buf).ensureAlpha().composite(parts).png().toBuffer();
  }
  const cut = await rounded(buf, w, h, l.radius);
  if (!sw) return cut;
  const ring = svgBuffer(w, h, `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(0, w - sw)}" height="${Math.max(0, h - sw)}" rx="${Math.max(0, l.radius - sw / 2)}" fill="none" stroke="${esc(resolveColor(l.stroke!, accent))}" stroke-width="${sw}"/>`);
  return sharp(cut).ensureAlpha().composite([{ input: ring }]).png().toBuffer();
}

async function rounded(buf: Buffer, w: number, h: number, radius: number): Promise<Buffer> {
  if (!radius) return buf;
  const mask = svgBuffer(w, h, `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="#fff"/>`);
  return sharp(buf).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

/**
 * Where a photo is cut for its place (cover crop) around the faces — face LOCATIONS only. The earlier tool's rule:
 * the main faces centred across, a little above the middle with room over the heads. Owner reports (group photos in
 * the narrow half of the featured design: faces at both edges cut in half; keeping only some of the people left half
 * bodies at the edges): when the main faces do not all fit the place, there is no good crop — null, and the photo is
 * shown whole instead.
 */
export function cropBox(sw: number, sh: number, w: number, h: number, focus: NonNullable<PhotoFocus>): { rw: number; rh: number; left: number; top: number } | null {
  const scale = Math.max(w / sw, h / sh);
  const rw = Math.ceil(sw * scale);
  const rh = Math.ceil(sh * scale);
  const area = focus.area;
  if (area && focus.faces?.length) {
    // Hair and ears reach a little past the detected face (as fitsPlace counts them).
    const pad = (f: { left: number; right: number }) => (f.right - f.left) * 0.2;
    const across = (Math.max(...focus.faces.map((f) => f.right + pad(f))) - Math.min(...focus.faces.map((f) => f.left - pad(f)))) * rw;
    const down = (Math.max(...focus.faces.map((f) => f.bottom)) - Math.min(...focus.faces.map((f) => f.top))) * rh * 1.4;
    if (across > w || down > h) return null;
  }
  let left: number;
  let top: number;
  if (area) {
    left = ((area.left + area.right) / 2) * rw - w / 2;
    top = Math.min(((area.top + area.bottom) / 2) * rh - h * 0.4, area.top * rh - h * 0.08);
  } else {
    left = focus.x * rw - w / 2;
    top = focus.y * rh - h / 2;
  }
  return { rw, rh, left: Math.min(Math.max(0, Math.round(left)), rw - w), top: Math.min(Math.max(0, Math.round(top)), rh - h) };
}

/** The whole picture on a blurred, darkened copy of itself (nothing of it is cut). */
async function wholeOnBlur(upright: Buffer, w: number, h: number): Promise<Buffer> {
  const backdrop = await sharp(upright).resize(w, h, { fit: 'cover' }).blur(Math.max(8, Math.round(Math.min(w, h) / 30))).modulate({ brightness: 0.8 }).png().toBuffer();
  const whole = await sharp(upright).resize(w, h, { fit: 'inside' }).png().toBuffer();
  return sharp(backdrop).composite([{ input: whole, gravity: 'centre' }]).png().toBuffer();
}

async function photoTile(src: Buffer, w: number, h: number, focus: PhotoFocus, mode: 'auto' | 'center' | 'top'): Promise<Buffer> {
  const upright = await sharp(src, { failOn: 'none' }).rotate().toBuffer();
  const meta = await sharp(upright).metadata();
  const sw = meta.width ?? w;
  const sh = meta.height ?? h;
  // As in the owner's earlier tool: a picture much taller than its place would lose the face when cropped, so it is
  // shown whole on a blurred copy of itself.
  if (mode === 'auto' && sw / sh < (w / h) * 0.8) return wholeOnBlur(upright, w, h);
  if (focus) {
    const box = cropBox(sw, sh, w, h, focus);
    // Faces that do not all fit the place: the whole photo (no face or person cut), unless a crop mode was chosen.
    if (!box) {
      if (mode === 'auto') return wholeOnBlur(upright, w, h);
      return sharp(upright).resize(w, h, { fit: 'cover', position: mode === 'top' ? 'north' : 'centre' }).png().toBuffer();
    }
    return sharp(upright).resize(box.rw, box.rh).extract({ left: box.left, top: box.top, width: w, height: h }).png().toBuffer();
  }
  const position = mode === 'top' ? 'north' : mode === 'center' ? 'centre' : sharp.strategy.attention;
  return sharp(upright).resize(w, h, { fit: 'cover', position }).png().toBuffer();
}

async function layerImage(layer: Layer, input: RenderInput, template: ImageTemplate): Promise<Buffer | null> {
  const w = Math.max(1, Math.round(layer.width));
  const h = Math.max(1, Math.round(layer.height));
  const accent = template.accent;
  switch (layer.type) {
    case 'photo': {
      const src = input.photos[layer.slot] ?? input.photos[0];
      if (!src) return framed(await sharp({ create: { width: w, height: h, channels: 4, background: accent } }).png().toBuffer(), w, h, layer, accent);
      return framed(await photoTile(src, w, h, input.focus?.[layer.slot] ?? null, layer.focus), w, h, layer, accent);
    }
    case 'fixed-photo': {
      const src = input.fixedPhotos?.[layer.assetId];
      if (!src) return null;
      return framed(await photoTile(src, w, h, null, 'auto'), w, h, layer, accent);
    }
    case 'logo': {
      if (!input.logo) return null;
      const pad = layer.plate ? layer.platePadding : 0;
      const inner = await sharp(input.logo)
        .resize(Math.max(1, w - 2 * pad), Math.max(1, h - 2 * pad), { fit: 'inside' })
        .png()
        .toBuffer();
      const meta = await sharp(inner).metadata();
      const canvas = sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } });
      const parts: OverlayOptions[] = [];
      if (layer.plate) parts.push({ input: svgBuffer(w, h, `<rect width="${w}" height="${h}" rx="${layer.plateRadius}" fill="${esc(resolveColor(layer.plateColor, accent))}"/>`), left: 0, top: 0 });
      parts.push({ input: inner, left: Math.round((w - (meta.width ?? 0)) / 2), top: Math.round((h - (meta.height ?? 0)) / 2) });
      return canvas.composite(parts).png().toBuffer();
    }
    case 'text': {
      const raw = fillTokens(layer.text, input.vars);
      const text = layer.uppercase ? raw.toUpperCase() : raw;
      if (!text.trim()) return null;
      const inner = Math.max(1, w - 2 * layer.padding);
      // A bundled font is drawn from its file (same picture on every computer), lines broken by real letter widths.
      const loaded = loadFont(layer.fontFamily, layer.fontWeight);
      const font = loaded && covers(loaded, text) ? loaded : null;
      const wrap = (fs: number, max: number) => (font ? wrapMeasured(font, text, fs, inner, max) : wrapText(text, fs, inner, max, layer.fontWeight));
      // Auto-fit: shrink the font (down to 60 %) until all lines fit the box; then truncate with an ellipsis.
      let fontSize = layer.fontSize;
      let lines = wrap(fontSize, 99);
      const fits = (fs: number, n: number) => n <= layer.maxLines && 2 * layer.padding + fs * 1.25 + (n - 1) * fs * layer.lineHeight <= h;
      while (!fits(fontSize, lines.length) && fontSize > layer.fontSize * 0.6) {
        fontSize = Math.round(fontSize * 0.92);
        lines = wrap(fontSize, 99);
      }
      const roomLines = Math.max(1, Math.min(layer.maxLines, Math.floor((h - 2 * layer.padding - fontSize * 1.25) / (fontSize * layer.lineHeight)) + 1));
      if (lines.length > roomLines) lines = wrap(fontSize, roomLines);
      const lh = fontSize * layer.lineHeight;
      const fill = esc(resolveColor(layer.color, accent));
      const bg = layer.background ? `<rect width="${w}" height="${h}" fill="${esc(resolveColor(layer.background, accent))}"/>` : '';
      if (font) return sharp(svgBuffer(w, h, `${bg}<path d="${linesPath(font, lines, { size: fontSize, width: w, padding: layer.padding, lineHeight: layer.lineHeight, align: layer.align })}" fill="${fill}"/>`)).png().toBuffer();
      const anchor = layer.align === 'center' ? 'middle' : layer.align === 'right' ? 'end' : 'start';
      const tx = layer.align === 'center' ? w / 2 : layer.align === 'right' ? w - layer.padding : layer.padding;
      const tspans = lines.map((l, i) => `<tspan x="${tx}" y="${layer.padding + fontSize + i * lh}">${esc(l)}</tspan>`).join('');
      return sharp(svgBuffer(w, h, `${bg}<text font-family="${esc(systemFonts(layer.fontFamily))}" font-size="${fontSize}" font-weight="${layer.fontWeight}" fill="${fill}" text-anchor="${anchor}">${tspans}</text>`)).png().toBuffer();
    }
    case 'rect': {
      const sw = layer.stroke ? layer.strokeWidth : 0;
      return sharp(svgBuffer(w, h, `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(0, w - sw)}" height="${Math.max(0, h - sw)}" rx="${layer.radius}" fill="${esc(resolveColor(layer.fill, accent))}"${sw ? ` stroke="${esc(resolveColor(layer.stroke, accent))}" stroke-width="${sw}"` : ''}/>`)).png().toBuffer();
    }
    case 'circle': {
      const sw = layer.stroke ? layer.strokeWidth : 0;
      return sharp(svgBuffer(w, h, `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0, w / 2 - sw / 2)}" ry="${Math.max(0, h / 2 - sw / 2)}" fill="${esc(resolveColor(layer.fill, accent))}"${sw ? ` stroke="${esc(resolveColor(layer.stroke, accent))}" stroke-width="${sw}"` : ''}/>`)).png().toBuffer();
    }
    case 'path': {
      // A shape drawn with the pen tool. Its border is centred on the line, so the picture reaches past the box by half
      // of it (placed back by `layerMargin`).
      const m = layerMargin(layer);
      const d = penPathD(layer.points, layer.closed, w, h);
      const stroke = layer.stroke && layer.strokeWidth ? ` stroke="${esc(resolveColor(layer.stroke, accent))}" stroke-width="${layer.strokeWidth}" stroke-linejoin="round" stroke-linecap="round"` : '';
      return sharp(svgBuffer(w + 2 * m, h + 2 * m, `<path transform="translate(${m} ${m})" d="${d}" fill="${layer.closed ? esc(resolveColor(layer.fill, accent)) : 'none'}"${stroke}/>`)).png().toBuffer();
    }
    case 'svg': {
      const safe = sanitizeSvg(layer.svg);
      if (!safe) return null;
      // preserveAspectRatio="none" (imported figures) stretches with the layer; any other SVG keeps its shape.
      const fit = /^<svg[^>]*preserveAspectRatio="none"/.test(safe) ? 'fill' : 'contain';
      return sharp(Buffer.from(safe)).resize(w, h, { fit, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    }
  }
}

/** How far a layer's picture reaches past its box on each side (a pen shape's border, centred on its line). */
function layerMargin(layer: Layer): number {
  return layer.type === 'path' && layer.stroke && layer.strokeWidth ? Math.ceil(layer.strokeWidth / 2) + 1 : 0;
}

async function placeRotated(buf: Buffer, layer: Layer): Promise<{ input: Buffer; left: number; top: number } | null> {
  let img = buf;
  const margin = layerMargin(layer);
  let left = Math.round(layer.x) - margin;
  let top = Math.round(layer.y) - margin;
  if (layer.opacity < 1) {
    const meta = await sharp(img).metadata();
    const mask = svgBuffer(meta.width ?? 1, meta.height ?? 1, `<rect width="100%" height="100%" fill="#fff" fill-opacity="${layer.opacity}"/>`);
    img = await sharp(img).ensureAlpha().composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  }
  if (layer.rotation % 360 !== 0) {
    const rotated = await sharp(img).rotate(layer.rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    const meta = await sharp(rotated).metadata();
    left = Math.round(layer.x + layer.width / 2 - (meta.width ?? 0) / 2);
    top = Math.round(layer.y + layer.height / 2 - (meta.height ?? 0) / 2);
    img = rotated;
  }
  // Clip to the canvas (sharp refuses overlays that extend past the base image).
  const meta = await sharp(img).metadata();
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  const cl = Math.max(0, -left);
  const ct = Math.max(0, -top);
  const cw = Math.min(w - cl, CANVAS.width - Math.max(0, left));
  const ch = Math.min(h - ct, CANVAS.height - Math.max(0, top));
  if (cw <= 0 || ch <= 0) return null;
  if (cl || ct || cw < w || ch < h) img = await sharp(img).extract({ left: cl, top: ct, width: cw, height: ch }).png().toBuffer();
  return { input: img, left: Math.max(0, left), top: Math.max(0, top) };
}

/** Render a template at full 1920×1080 (PNG buffer). */
export async function renderCanvas(input: RenderInput): Promise<Buffer> {
  const t = input.template;
  const overlays: OverlayOptions[] = [];
  for (const layer of t.layers) {
    if (!layer.visible) continue;
    const img = await layerImage(layer, input, t);
    if (!img) continue;
    const placed = await placeRotated(img, layer);
    if (placed) overlays.push(placed);
  }
  return sharp({ create: { width: CANVAS.width, height: CANVAS.height, channels: 4, background: t.background === 'accent' ? t.accent : t.background } })
    .composite(overlays)
    .png()
    .toBuffer();
}

/** Encode within the byte budget: WebP quality steps, then JPEG, then a smaller size as a last resort. */
export async function encodeWithinBudget(png: Buffer, opts: RenderOptions): Promise<{ buffer: Buffer; mime: 'image/webp' | 'image/jpeg'; quality: number; width: number; height: number }> {
  let width = opts.width;
  let height = opts.height;
  for (let attempt = 0; attempt < 3; attempt++) {
    const resized = await sharp(png).resize(width, height, { fit: 'cover' }).toBuffer();
    for (const quality of [82, 74, 66, 58, 50, 42]) {
      const buffer = opts.format === 'jpeg' ? await sharp(resized).jpeg({ quality, mozjpeg: true }).toBuffer() : await sharp(resized).webp({ quality, effort: 4 }).toBuffer();
      if (buffer.length <= opts.maxBytes) return { buffer, mime: opts.format === 'jpeg' ? 'image/jpeg' : 'image/webp', quality, width, height };
    }
    width = Math.round(width * 0.8);
    height = Math.round((width * 9) / 16);
  }
  const buffer = await sharp(png).resize(width, height).webp({ quality: 40 }).toBuffer();
  return { buffer, mime: 'image/webp', quality: 40, width, height };
}

export async function renderTemplate(input: RenderInput, opts: RenderOptions) {
  return encodeWithinBudget(await renderCanvas(input), opts);
}

/** A clean 16:9 body image (no text, no logo): smart crop of one photo or illustration. */
export async function renderCleanImage(photo: Buffer, opts: RenderOptions, focus?: PhotoFocus) {
  const tile = await photoTile(photo, CANVAS.width, CANVAS.height, focus ?? null, 'auto');
  return encodeWithinBudget(tile, opts);
}

export function outputSize(setting: string): { width: number; height: number } {
  return setting === '1920x1080' ? { width: 1920, height: 1080 } : { width: 1200, height: 675 };
}
