import sharp, { type OverlayOptions } from 'sharp';
import { CANVAS, sanitizeSvg, type ImageTemplate, type Layer } from '@/lib/image-template';

/**
 * The production image renderer (also used for the designer's live preview).
 * Everything is composited with sharp in a true 1920×1080 canvas, then scaled
 * to the output size and encoded within the site's byte budget.
 */

export interface RenderInput {
  template: ImageTemplate;
  /** Photo slots 0 and 1 (missing slots fall back to slot 0, then to a flat accent panel). */
  photos: Buffer[];
  /** Optional focus points per slot, in source-image fractions (e.g. from face boxes). */
  focus?: ({ x: number; y: number } | null)[];
  logo?: Buffer | null;
  fixedPhotos?: Record<string, Buffer>;
  vars?: Record<string, string>;
}

export interface RenderOptions {
  width: number;
  height: number;
  maxBytes: number;
  format?: 'webp' | 'jpeg';
}

const FONTS: Record<string, string> = {
  sans: "Inter, 'Segoe UI', Arial, Helvetica, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  condensed: "'Arial Narrow', 'Roboto Condensed', Arial, sans-serif",
  mono: "Consolas, 'Courier New', monospace",
};

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

async function rounded(buf: Buffer, w: number, h: number, radius: number): Promise<Buffer> {
  if (!radius) return buf;
  const mask = svgBuffer(w, h, `<rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="#fff"/>`);
  return sharp(buf).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

async function photoTile(src: Buffer, w: number, h: number, focus: { x: number; y: number } | null, mode: 'auto' | 'center' | 'top'): Promise<Buffer> {
  const img = sharp(src, { failOn: 'none' }).rotate();
  if (focus) {
    // Crop around a known focus point (e.g. a detected face box) — face LOCATION only.
    const meta = await img.metadata();
    const sw = meta.width ?? w;
    const sh = meta.height ?? h;
    const scale = Math.max(w / sw, h / sh);
    const rw = Math.ceil(sw * scale);
    const rh = Math.ceil(sh * scale);
    const left = Math.min(Math.max(0, Math.round(focus.x * rw - w / 2)), rw - w);
    const top = Math.min(Math.max(0, Math.round(focus.y * rh - h / 2)), rh - h);
    return sharp(src).rotate().resize(rw, rh).extract({ left, top, width: w, height: h }).png().toBuffer();
  }
  const position = mode === 'top' ? 'north' : mode === 'center' ? 'centre' : sharp.strategy.attention;
  return img.resize(w, h, { fit: 'cover', position }).png().toBuffer();
}

async function layerImage(layer: Layer, input: RenderInput, template: ImageTemplate): Promise<Buffer | null> {
  const w = Math.max(1, Math.round(layer.width));
  const h = Math.max(1, Math.round(layer.height));
  const accent = template.accent;
  switch (layer.type) {
    case 'photo': {
      const src = input.photos[layer.slot] ?? input.photos[0];
      if (!src) return sharp({ create: { width: w, height: h, channels: 4, background: accent } }).png().toBuffer();
      return rounded(await photoTile(src, w, h, input.focus?.[layer.slot] ?? null, layer.focus), w, h, layer.radius);
    }
    case 'fixed-photo': {
      const src = input.fixedPhotos?.[layer.assetId];
      if (!src) return null;
      return rounded(await photoTile(src, w, h, null, 'auto'), w, h, layer.radius);
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
      // Auto-fit: shrink the font (down to 60 %) until all lines fit the box; then truncate with an ellipsis.
      let fontSize = layer.fontSize;
      let lines = wrapText(text, fontSize, inner, 99, layer.fontWeight);
      const fits = (fs: number, n: number) => n <= layer.maxLines && 2 * layer.padding + fs * 1.25 + (n - 1) * fs * layer.lineHeight <= h;
      while (!fits(fontSize, lines.length) && fontSize > layer.fontSize * 0.6) {
        fontSize = Math.round(fontSize * 0.92);
        lines = wrapText(text, fontSize, inner, 99, layer.fontWeight);
      }
      const roomLines = Math.max(1, Math.min(layer.maxLines, Math.floor((h - 2 * layer.padding - fontSize * 1.25) / (fontSize * layer.lineHeight)) + 1));
      if (lines.length > roomLines) lines = wrapText(text, fontSize, inner, roomLines, layer.fontWeight);
      const lh = fontSize * layer.lineHeight;
      const anchor = layer.align === 'center' ? 'middle' : layer.align === 'right' ? 'end' : 'start';
      const tx = layer.align === 'center' ? w / 2 : layer.align === 'right' ? w - layer.padding : layer.padding;
      const bg = layer.background ? `<rect width="${w}" height="${h}" fill="${esc(resolveColor(layer.background, accent))}"/>` : '';
      const tspans = lines.map((l, i) => `<tspan x="${tx}" y="${layer.padding + fontSize + i * lh}">${esc(l)}</tspan>`).join('');
      return sharp(svgBuffer(w, h, `${bg}<text font-family="${esc(FONTS[layer.fontFamily])}" font-size="${fontSize}" font-weight="${layer.fontWeight}" fill="${esc(resolveColor(layer.color, accent))}" text-anchor="${anchor}">${tspans}</text>`)).png().toBuffer();
    }
    case 'rect': {
      const sw = layer.stroke ? layer.strokeWidth : 0;
      return sharp(svgBuffer(w, h, `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(0, w - sw)}" height="${Math.max(0, h - sw)}" rx="${layer.radius}" fill="${esc(resolveColor(layer.fill, accent))}"${sw ? ` stroke="${esc(resolveColor(layer.stroke, accent))}" stroke-width="${sw}"` : ''}/>`)).png().toBuffer();
    }
    case 'circle': {
      const sw = layer.stroke ? layer.strokeWidth : 0;
      return sharp(svgBuffer(w, h, `<ellipse cx="${w / 2}" cy="${h / 2}" rx="${Math.max(0, w / 2 - sw / 2)}" ry="${Math.max(0, h / 2 - sw / 2)}" fill="${esc(resolveColor(layer.fill, accent))}"${sw ? ` stroke="${esc(resolveColor(layer.stroke, accent))}" stroke-width="${sw}"` : ''}/>`)).png().toBuffer();
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

async function placeRotated(buf: Buffer, layer: Layer): Promise<{ input: Buffer; left: number; top: number } | null> {
  let img = buf;
  let left = Math.round(layer.x);
  let top = Math.round(layer.y);
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
export async function renderCleanImage(photo: Buffer, opts: RenderOptions, focus?: { x: number; y: number } | null) {
  const tile = await photoTile(photo, CANVAS.width, CANVAS.height, focus ?? null, 'auto');
  return encodeWithinBudget(tile, opts);
}

export function outputSize(setting: string): { width: number; height: number } {
  return setting === '1920x1080' ? { width: 1920, height: 1080 } : { width: 1200, height: 675 };
}
