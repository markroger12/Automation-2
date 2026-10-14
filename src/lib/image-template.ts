import { z } from 'zod';

/**
 * Branded image templates (client-safe). Coordinates are always in a true
 * 1920×1080 canvas; the renderer scales to the output size (1200×675 or
 * 1920×1080). Nothing in a template can execute code: text is plain text,
 * colors are validated, SVG layers are sanitized, URLs are never fetched.
 */

export const CANVAS = { width: 1920, height: 1080 } as const;

const color = z.string().regex(/^(#[0-9a-fA-F]{3,8}|accent|transparent|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\))$/, 'Use #rrggbb, rgba(), "accent" or "transparent"');
const num = (min: number, max: number) => z.number().finite().min(min).max(max);

const base = {
  id: z.string().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().max(60).default(''),
  x: num(-1920, 3840),
  y: num(-1080, 2160),
  width: num(1, 3840),
  height: num(1, 2160),
  rotation: num(-360, 360).default(0),
  opacity: num(0, 1).default(1),
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
};

export const layerSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('photo'), slot: z.number().int().min(0).max(1).default(0), radius: num(0, 540).default(0), focus: z.enum(['auto', 'center', 'top']).default('auto') }),
  z.object({ ...base, type: z.literal('fixed-photo'), assetId: z.string().max(40), radius: num(0, 540).default(0) }),
  z.object({ ...base, type: z.literal('logo'), plate: z.boolean().default(false), plateColor: color.default('#ffffff'), platePadding: num(0, 200).default(16), plateRadius: num(0, 540).default(12) }),
  z.object({
    ...base,
    type: z.literal('text'),
    text: z.string().max(400),
    fontFamily: z.enum(['sans', 'serif', 'condensed', 'mono']).default('sans'),
    fontSize: num(8, 400).default(64),
    fontWeight: z.union([z.literal(400), z.literal(600), z.literal(700), z.literal(800)]).default(700),
    color: color.default('#ffffff'),
    align: z.enum(['left', 'center', 'right']).default('left'),
    lineHeight: num(0.8, 2.5).default(1.15),
    maxLines: z.number().int().min(1).max(8).default(3),
    uppercase: z.boolean().default(false),
    background: color.nullable().default(null),
    padding: num(0, 200).default(0),
  }),
  z.object({ ...base, type: z.literal('rect'), fill: color.default('accent'), stroke: color.nullable().default(null), strokeWidth: num(0, 100).default(0), radius: num(0, 540).default(0) }),
  z.object({ ...base, type: z.literal('circle'), fill: color.default('accent'), stroke: color.nullable().default(null), strokeWidth: num(0, 100).default(0) }),
  z.object({ ...base, type: z.literal('svg'), svg: z.string().max(50_000) }),
]);
export type Layer = z.output<typeof layerSchema>;
export type LayerInput = z.input<typeof layerSchema>;

export const templateSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().max(80).default('Custom'),
  background: color.default('#111827'),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#4f46e5'),
  layers: z.array(layerSchema).max(40).default([]),
});
export type ImageTemplate = z.output<typeof templateSchema>;

export const siteImageSettingsSchema = z.object({
  featured: templateSchema,
  /** Body images: null = clean photo/illustration cropped to 16:9 (no text, no logo). */
  body: templateSchema.nullable().default(null),
  logoAssetId: z.string().max(40).nullable().default(null),
});
export type SiteImageSettings = z.output<typeof siteImageSettingsSchema>;

let counter = 0;
const lid = (p: string) => `${p}${(counter++).toString(36)}`;

/** Preset: one photo, title band, logo in the top-right corner. */
export function presetSingle(accent = '#4f46e5'): ImageTemplate {
  return templateSchema.parse({
    name: 'Single photo · corner logo',
    background: '#111827',
    accent,
    layers: [
      { id: lid('photo'), name: 'Photo', type: 'photo', slot: 0, x: 0, y: 0, width: 1920, height: 1080 },
      { id: lid('band'), name: 'Title band', type: 'rect', x: 0, y: 720, width: 1920, height: 360, fill: 'rgba(0,0,0,0.55)' },
      { id: lid('accent'), name: 'Accent bar', type: 'rect', x: 80, y: 760, width: 140, height: 12, fill: 'accent' },
      { id: lid('title'), name: 'Title', type: 'text', text: '{{title}}', x: 80, y: 800, width: 1640, height: 240, fontSize: 76, fontWeight: 800, maxLines: 2 },
      { id: lid('logo'), name: 'Logo', type: 'logo', x: 1580, y: 50, width: 290, height: 130, plate: true, plateColor: '#ffffff' },
    ],
  });
}

/** Preset: two photos split by an accent divider with the logo in the center. */
export function presetSplit(accent = '#4f46e5'): ImageTemplate {
  return templateSchema.parse({
    name: 'Split photo · center divider and logo',
    background: '#111827',
    accent,
    layers: [
      { id: lid('left'), name: 'Left photo', type: 'photo', slot: 0, x: 0, y: 0, width: 952, height: 1080 },
      { id: lid('right'), name: 'Right photo', type: 'photo', slot: 1, x: 968, y: 0, width: 952, height: 1080 },
      { id: lid('divider'), name: 'Divider', type: 'rect', x: 952, y: 0, width: 16, height: 1080, fill: 'accent' },
      { id: lid('plate'), name: 'Logo plate', type: 'circle', x: 810, y: 390, width: 300, height: 300, fill: '#ffffff', stroke: 'accent', strokeWidth: 10 },
      { id: lid('logo'), name: 'Logo', type: 'logo', x: 860, y: 470, width: 200, height: 140 },
      { id: lid('band'), name: 'Title band', type: 'rect', x: 0, y: 860, width: 1920, height: 220, fill: 'rgba(0,0,0,0.6)' },
      { id: lid('title'), name: 'Title', type: 'text', text: '{{title}}', x: 80, y: 878, width: 1760, height: 190, fontSize: 60, fontWeight: 800, align: 'center', maxLines: 2 },
    ],
  });
}

/** Body preset: the photo full-bleed with a small logo in the corner (no text). */
export function presetBodyCornerLogo(accent = '#4f46e5'): ImageTemplate {
  return templateSchema.parse({
    name: 'Body · photo with corner logo',
    background: '#111827',
    accent,
    layers: [
      { id: lid('photo'), name: 'Photo', type: 'photo', slot: 0, x: 0, y: 0, width: 1920, height: 1080 },
      { id: lid('logo'), name: 'Logo', type: 'logo', x: 1640, y: 950, width: 230, height: 90, plate: true, plateColor: 'rgba(255,255,255,0.85)', platePadding: 12 },
    ],
  });
}

export const FEATURED_PRESETS = { single: presetSingle, split: presetSplit } as const;

export function defaultSiteImageSettings(accent?: string): SiteImageSettings {
  return { featured: presetSingle(accent), body: null, logoAssetId: null };
}

export function parseSiteImageSettings(raw: string | null | undefined): SiteImageSettings {
  try {
    const parsed = siteImageSettingsSchema.safeParse(JSON.parse(raw || '{}'));
    if (parsed.success) return parsed.data;
  } catch {
    /* fall through */
  }
  return defaultSiteImageSettings();
}

// ------------------------------------------------------------ SVG sanitizing

const SVG_ALLOWED = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'defs', 'lineargradient', 'radialgradient', 'stop', 'clippath', 'title']);
const ATTR_ALLOWED = /^(viewbox|width|height|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|d|points|fill|fill-opacity|fill-rule|stroke|stroke-width|stroke-opacity|stroke-linecap|stroke-linejoin|opacity|transform|offset|stop-color|stop-opacity|id|clip-path|gradientunits|gradienttransform|xmlns)$/i;

/** Keep only plain shapes: no scripts, no event handlers, no external references, no foreignObject/image/use. */
export function sanitizeSvg(svg: string): string | null {
  if (svg.length > 50_000) return null;
  const out: string[] = [];
  const re = /<\s*(\/?)\s*([a-zA-Z][\w:-]*)([^>]*?)(\/?)\s*>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let depthDenied = 0;
  while ((m = re.exec(svg))) {
    if (m[5] !== undefined) {
      if (!depthDenied && m[5].trim()) out.push(m[5].replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]!));
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const selfClosing = m[4] === '/';
    if (!SVG_ALLOWED.has(tag)) {
      if (!selfClosing) depthDenied += closing ? -1 : 1;
      depthDenied = Math.max(0, depthDenied);
      continue;
    }
    if (depthDenied) continue;
    if (closing) {
      out.push(`</${tag}>`);
      continue;
    }
    const attrs: string[] = [];
    for (const a of m[3].matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const name = a[1].toLowerCase();
      const value = a[3] ?? a[4] ?? '';
      if (!ATTR_ALLOWED.test(name)) continue;
      if (/url\s*\(\s*['"]?\s*(?!#)/i.test(value) || /javascript:|data:|expression\(/i.test(value)) continue;
      attrs.push(`${name}="${value.replace(/"/g, '&quot;')}"`);
    }
    out.push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClosing ? '/' : ''}>`);
  }
  const result = out.join('');
  return /^<svg[\s>]/.test(result) ? result : null;
}

// ------------------------------------------------------ Polotno-like import

interface ForeignElement {
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  opacity?: number;
  text?: string;
  fontSize?: number;
  fontWeight?: string | number;
  fill?: string;
  align?: string;
  src?: string;
  name?: string;
  cornerRadius?: number;
  stroke?: string;
  strokeWidth?: number;
  [k: string]: unknown;
}

const safeColor = (c: unknown, fallback: string) => (typeof c === 'string' && color.safeParse(c.trim()).success ? c.trim() : fallback);

/**
 * Import a Polotno-like design ({ width, height, pages: [{ children: [...] }] }).
 * Pages are scaled proportionally into 1920×1080, supported transforms kept,
 * image URLs are NEVER fetched (images become photo slots), SVG is sanitized,
 * unsupported elements are reported, nothing is executed.
 */
export function importForeignTemplate(raw: unknown): { template: ImageTemplate; notes: string[] } {
  const notes: string[] = [];
  const doc = (raw ?? {}) as { width?: number; height?: number; pages?: { background?: string; children?: ForeignElement[] }[] };
  const w = Number(doc.width) > 0 ? Number(doc.width) : CANVAS.width;
  const h = Number(doc.height) > 0 ? Number(doc.height) : CANVAS.height;
  const scale = Math.min(CANVAS.width / w, CANVAS.height / h);
  const offX = (CANVAS.width - w * scale) / 2;
  const offY = (CANVAS.height - h * scale) / 2;
  if (Math.abs(w / h - 16 / 9) > 0.01) notes.push(`Page ${w}×${h} is not 16:9; it was scaled proportionally and centered.`);
  const page = doc.pages?.[0];
  if (!page) return { template: presetSingle(), notes: ['No page found; the default preset was used.'] };
  if ((doc.pages?.length ?? 0) > 1) notes.push('Only the first page was imported.');
  const layers: LayerInput[] = [];
  let photoSlot = 0;
  for (const [i, el] of (page.children ?? []).slice(0, 40).entries()) {
    const geom = {
      id: `imp${i}`,
      name: String(el.name ?? el.type ?? 'layer').slice(0, 60),
      x: offX + (Number(el.x) || 0) * scale,
      y: offY + (Number(el.y) || 0) * scale,
      width: Math.max(1, (Number(el.width) || 100) * scale),
      height: Math.max(1, (Number(el.height) || 100) * scale),
      rotation: Number(el.rotation) || 0,
      opacity: el.opacity === undefined ? 1 : Math.min(1, Math.max(0, Number(el.opacity))),
    };
    switch (el.type) {
      case 'text':
        layers.push({ ...geom, type: 'text', text: String(el.text ?? '').slice(0, 400), fontSize: Math.min(400, Math.max(8, (Number(el.fontSize) || 40) * scale)), fontWeight: Number(el.fontWeight) >= 700 || el.fontWeight === 'bold' ? 700 : 400, color: safeColor(el.fill, '#ffffff'), align: el.align === 'center' || el.align === 'right' ? el.align : 'left' });
        break;
      case 'image':
        if (photoSlot <= 1) layers.push({ ...geom, type: 'photo', slot: photoSlot++ });
        else notes.push(`Image “${geom.name}” skipped (only two photo slots).`);
        if (el.src) notes.push(`Image “${geom.name}” became a photo slot; its URL was not fetched.`);
        break;
      case 'figure':
      case 'rect':
        layers.push({ ...geom, type: 'rect', fill: safeColor(el.fill, 'accent'), radius: Number(el.cornerRadius) || 0, stroke: el.stroke ? safeColor(el.stroke, '#000000') : null, strokeWidth: Number(el.strokeWidth) || 0 });
        break;
      case 'circle':
        layers.push({ ...geom, type: 'circle', fill: safeColor(el.fill, 'accent') });
        break;
      case 'svg': {
        const svg = typeof el.svg === 'string' ? sanitizeSvg(el.svg) : null;
        if (svg) layers.push({ ...geom, type: 'svg', svg });
        else notes.push(`SVG “${geom.name}” was not imported (unsafe or not inline).`);
        break;
      }
      default:
        notes.push(`Element type “${String(el.type)}” is not supported and was skipped.`);
    }
  }
  const parsed = templateSchema.safeParse({ name: 'Imported', background: safeColor(page.background, '#111827'), layers });
  if (!parsed.success) return { template: presetSingle(), notes: [...notes, 'The import was not valid; the default preset was used.'] };
  return { template: parsed.data, notes };
}
