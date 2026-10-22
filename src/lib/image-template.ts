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

/**
 * A photo place's frame (owner request: a circle photo place with a coloured ring, as in a two-person featured image).
 * 'circle' cuts the photo to the circle (an ellipse in a non-square box); the border is drawn inside the place.
 */
const photoFrame = {
  shape: z.enum(['rect', 'circle']).default('rect'),
  stroke: color.nullable().default(null),
  strokeWidth: num(0, 100).default(0),
};

export const layerSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('photo'), slot: z.number().int().min(0).max(1).default(0), radius: num(0, 540).default(0), focus: z.enum(['auto', 'center', 'top']).default('auto'), ...photoFrame }),
  z.object({ ...base, type: z.literal('fixed-photo'), assetId: z.string().max(40), radius: num(0, 540).default(0), ...photoFrame }),
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

/** The Tigram writer's own templates (owner request: a Celebrity and a Tigram image template). */
export const writerTemplatesSchema = z.object({
  featured: templateSchema,
  body: templateSchema.nullable().default(null),
  /**
   * On: ChatGPT draws the featured picture without text and it goes into this featured design, whose title layer shows
   * the title. Off: ChatGPT writes the title on the picture, which gets the body design (logo) like the body pictures.
   */
  useFeatured: z.boolean().default(true),
});
export type WriterTemplates = z.output<typeof writerTemplatesSchema>;

export const siteImageSettingsSchema = z.object({
  /** Celebrity featured image (the photo design). */
  featured: templateSchema,
  /** Celebrity body images: null = clean photo cropped to 16:9 (no text, no logo). */
  body: templateSchema.nullable().default(null),
  logoAssetId: z.string().max(40).nullable().default(null),
  /** Tigram templates; null = the Celebrity templates are used for Tigram too (with the featured design on). */
  tigram: writerTemplatesSchema.nullable().default(null),
});
export type SiteImageSettings = z.output<typeof siteImageSettingsSchema>;

export type TemplateSet = 'celebrity' | 'tigram';

/** The templates one writer uses on a website. */
export function templateSet(s: SiteImageSettings, set: TemplateSet): WriterTemplates {
  if (set === 'tigram' && s.tigram) return s.tigram;
  return { featured: s.featured, body: s.body, useFeatured: true };
}

/** The settings with one writer's templates replaced. */
export function withTemplateSet(s: SiteImageSettings, set: TemplateSet, t: WriterTemplates): SiteImageSettings {
  return set === 'tigram' ? { ...s, tigram: t } : { ...s, featured: t.featured, body: t.body };
}

export const templateSetFor = (moduleKey: string): TemplateSet => (moduleKey === 'tigram-writer' ? 'tigram' : 'celebrity');

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

/** Preset (owner request): the main photo across the canvas, the second photo in a circle with an accent ring. */
export function presetPhotoCircle(accent = '#4f46e5'): ImageTemplate {
  return templateSchema.parse({
    name: 'Photo with circle photo',
    background: '#f3f4f6',
    accent,
    layers: [
      { id: lid('photo'), name: 'Main photo', type: 'photo', slot: 0, x: 0, y: 0, width: 1920, height: 1080 },
      { id: lid('circle'), name: 'Circle photo', type: 'photo', slot: 1, x: 1020, y: 110, width: 860, height: 860, shape: 'circle', stroke: 'accent', strokeWidth: 22 },
      { id: lid('logo'), name: 'Logo', type: 'logo', x: 50, y: 40, width: 260, height: 110, plate: true, plateColor: '#ffffff' },
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

export const FEATURED_PRESETS = { single: presetSingle, split: presetSplit, circle: presetPhotoCircle } as const;

export function defaultSiteImageSettings(accent?: string): SiteImageSettings {
  return { featured: presetSingle(accent), body: null, logoAssetId: null, tigram: null };
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
const ATTR_ALLOWED = /^(viewbox|preserveaspectratio|width|height|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|d|points|fill|fill-opacity|fill-rule|stroke|stroke-width|stroke-opacity|stroke-linecap|stroke-linejoin|opacity|transform|offset|stop-color|stop-opacity|id|clip-path|gradientunits|gradienttransform|xmlns)$/i;
// SVG is case-sensitive XML: lower-cased `viewbox` or `lineargradient` are silently ignored by browsers and librsvg.
const SVG_CASE: Record<string, string> = { lineargradient: 'linearGradient', radialgradient: 'radialGradient', clippath: 'clipPath', viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio', gradientunits: 'gradientUnits', gradienttransform: 'gradientTransform' };

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
      out.push(`</${SVG_CASE[tag] ?? tag}>`);
      continue;
    }
    const attrs: string[] = [];
    for (const a of m[3].matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
      const name = a[1].toLowerCase();
      const value = a[3] ?? a[4] ?? '';
      if (!ATTR_ALLOWED.test(name)) continue;
      if (/url\s*\(\s*['"]?\s*(?!#)/i.test(value) || /javascript:|data:|expression\(/i.test(value)) continue;
      attrs.push(`${SVG_CASE[name] ?? name}="${value.replace(/"/g, '&quot;')}"`);
    }
    // An SVG shown through <img> renders only with its namespace.
    if (tag === 'svg' && !out.length && !attrs.some((a) => a.startsWith('xmlns='))) attrs.push('xmlns="http://www.w3.org/2000/svg"');
    out.push(`<${SVG_CASE[tag] ?? tag}${attrs.length ? ' ' + attrs.join(' ') : ''}${selfClosing ? '/' : ''}>`);
  }
  const result = out.join('');
  return /^<svg[\s>]/.test(result) ? result : null;
}

// ------------------------------------------------------ Polotno-like import

interface ForeignElement {
  type?: string;
  subType?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
  opacity?: number;
  visible?: boolean;
  text?: string;
  fontSize?: number;
  fontWeight?: string | number;
  fill?: string;
  color?: string;
  align?: string;
  src?: string;
  svg?: string;
  name?: string;
  cornerRadius?: number;
  stroke?: string;
  strokeWidth?: number;
  cropX?: number;
  cropY?: number;
  cropWidth?: number;
  cropHeight?: number;
  colorsReplace?: Record<string, string>;
  children?: ForeignElement[];
  [k: string]: unknown;
}

/** A picture embedded in the imported file (data: URL). The designer stores it in the site's template library. */
export interface EmbeddedPicture {
  /** Placeholder assetId on the imported fixed-photo layer, replaced once the picture is stored. */
  ref: string;
  name: string;
  dataUrl: string;
  /** Polotno crop, as fractions of the picture (absent = the whole picture). */
  crop?: { x: number; y: number; width: number; height: number };
}

const NAMED_COLORS: Record<string, string> = { white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', gray: '#808080', grey: '#808080', silver: '#c0c0c0', navy: '#000080', teal: '#008080', gold: '#ffd700', brown: '#a52a2a' };
const safeColor = (c: unknown, fallback: string) => {
  if (typeof c !== 'string') return fallback;
  const v = NAMED_COLORS[c.trim().toLowerCase()] ?? c.trim();
  return color.safeParse(v).success ? v : fallback;
};

const EMBEDDED_IMAGE = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i;
/** An image named like this in Polotno becomes a photo slot even when it carries an embedded picture. */
const PHOTO_NAME = /photo|foto|bild|slot|placeholder|celebrity|person/i;

/** Polotno's simple figures as paths in a w×h box (stretched with the layer). Other figures are drawn as rectangles. */
function figurePath(subType: string, w: number, h: number): string | null {
  const poly = (n: number, inner?: number) => {
    const pts: string[] = [];
    const steps = inner ? n * 2 : n;
    for (let i = 0; i < steps; i++) {
      const r = inner && i % 2 ? inner : 1;
      const a = (i * 2 * Math.PI) / steps;
      pts.push(`${(w / 2 + (r * w * Math.sin(a)) / 2).toFixed(2)} ${(h / 2 - (r * h * Math.cos(a)) / 2).toFixed(2)}`);
    }
    return `M ${pts.join(' L ')} Z`;
  };
  switch (subType) {
    case 'triangle':
      return `M ${w / 2} 0 L ${w} ${h} L 0 ${h} Z`;
    case 'rightTriangle':
      return `M 0 0 L ${w} 0 L 0 ${h} Z`;
    case 'diamond':
      return `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`;
    case 'pentagon':
      return poly(5);
    case 'hexagon':
      return poly(6);
    case 'star':
      return poly(5, 0.5);
    case 'cross': {
      const [a, b, c, d] = [w * 0.35, w * 0.65, h * 0.35, h * 0.65];
      return `M ${a} 0 H ${b} V ${c} H ${w} V ${d} H ${b} V ${h} H ${a} V ${d} H 0 V ${c} H ${a} Z`;
    }
    default:
      return null;
  }
}

/** The SVG text inside a data: URL (base64 or URL-encoded), or null. Nothing is fetched. */
function svgFromDataUrl(src: unknown): string | null {
  if (typeof src !== 'string') return null;
  const m = /^data:image\/svg\+xml(;charset=[\w-]+)?(;base64)?,(.*)$/is.exec(src.trim());
  if (!m) return null;
  try {
    if (!m[2]) return decodeURIComponent(m[3]);
    const bin = atob(m[3].replace(/\s+/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Import a Polotno-like design ({ width, height, pages: [{ children: [...] }] }).
 * - Pages are scaled proportionally into 1920×1080. Polotno rotates around an element's top-left corner;
 *   the layer is moved so it lands where Polotno shows it (layers here rotate around their centre).
 * - Groups are flattened; rectangles, circles and simple figures (triangle, right triangle, diamond, pentagon,
 *   hexagon, star, cross) keep their shape.
 * - Pictures embedded in the file (data: URLs) stay part of the design: they are returned in `embedded` for the
 *   designer to store as fixed photos. Image URLs are NEVER fetched: such images (and images named “photo…”)
 *   become photo slots. A design without a photo place gets photo slots behind it: two beside a centre divider,
 *   otherwise one over the whole canvas.
 * - SVG (inline or data: URL) is sanitized; unsupported elements are reported; nothing is executed.
 */
export function importForeignTemplate(raw: unknown): { template: ImageTemplate; notes: string[]; embedded: EmbeddedPicture[] } {
  const notes: string[] = [];
  const embedded: EmbeddedPicture[] = [];
  const doc = (raw ?? {}) as { width?: number; height?: number; pages?: { background?: string; width?: unknown; height?: unknown; children?: ForeignElement[] }[] };
  const page = doc.pages?.[0];
  if (!page) return { template: presetSingle(), notes: ['No page found; the default preset was used.'], embedded };
  const w = Number(page.width) > 0 ? Number(page.width) : Number(doc.width) > 0 ? Number(doc.width) : CANVAS.width;
  const h = Number(page.height) > 0 ? Number(page.height) : Number(doc.height) > 0 ? Number(doc.height) : CANVAS.height;
  const scale = Math.min(CANVAS.width / w, CANVAS.height / h);
  const offX = (CANVAS.width - w * scale) / 2;
  const offY = (CANVAS.height - h * scale) / 2;
  if (Math.abs(w / h - 16 / 9) > 0.01) notes.push(`Page ${w}×${h} is not 16:9; it was scaled proportionally and centered.`);
  if ((doc.pages?.length ?? 0) > 1) notes.push('Only the first page was imported.');

  const flat: ForeignElement[] = [];
  const walk = (els: ForeignElement[] | undefined) => {
    for (const el of els ?? []) {
      if (!el || el.visible === false) continue;
      if (el.type === 'group') walk(el.children);
      else flat.push(el);
    }
  };
  walk(page.children);
  if (flat.length > 40) notes.push(`Only the first 40 of ${flat.length} elements were imported.`);

  const layers: LayerInput[] = [];
  let photoSlot = 0;
  const photoLayer = (geom: object, name: string) => {
    if (photoSlot <= 1) layers.push({ ...geom, type: 'photo', slot: photoSlot++ } as LayerInput);
    else notes.push(`Image “${name}” skipped (only two photo slots).`);
  };
  const background = typeof page.background === 'string' ? page.background.trim() : '';
  if (EMBEDDED_IMAGE.test(background)) {
    embedded.push({ ref: 'embedded-bg', name: 'background', dataUrl: background });
    layers.push({ id: 'impbg', name: 'background', type: 'fixed-photo', assetId: 'embedded-bg', x: 0, y: 0, width: CANVAS.width, height: CANVAS.height });
  } else if (/^(https?:|data:)/i.test(background)) notes.push('The page background picture is a link; it was not fetched.');

  for (const [i, el] of flat.slice(0, 40).entries()) {
    const ew = Math.max(1, (Number(el.width) || 100) * scale);
    const eh = Math.max(1, (Number(el.height) || 100) * scale);
    const rotation = Number(el.rotation) || 0;
    const rad = (rotation * Math.PI) / 180;
    // Polotno's pivot is the top-left corner: find where the centre ends up, then place the box around it.
    const cx = offX + (Number(el.x) || 0) * scale + (Math.cos(rad) * ew) / 2 - (Math.sin(rad) * eh) / 2;
    const cy = offY + (Number(el.y) || 0) * scale + (Math.sin(rad) * ew) / 2 + (Math.cos(rad) * eh) / 2;
    const name = String(el.name ?? el.type ?? 'layer').slice(0, 60);
    const geom = {
      id: `imp${i}`,
      name,
      x: clamp(cx - ew / 2, -1920, 3840),
      y: clamp(cy - eh / 2, -1080, 2160),
      width: Math.min(3840, ew),
      height: Math.min(2160, eh),
      rotation: ((rotation % 360) + 360) % 360 > 180 ? (((rotation % 360) + 360) % 360) - 360 : ((rotation % 360) + 360) % 360,
      opacity: el.opacity === undefined ? 1 : clamp(Number(el.opacity) || 0, 0, 1),
    };
    const stroke = el.stroke && Number(el.strokeWidth) > 0 ? { stroke: safeColor(el.stroke, '#000000'), strokeWidth: Math.min(100, Number(el.strokeWidth) * scale) } : { stroke: null, strokeWidth: 0 };
    switch (el.type) {
      case 'text':
        layers.push({ ...geom, type: 'text', text: String(el.text ?? '').slice(0, 400), fontSize: Math.min(400, Math.max(8, (Number(el.fontSize) || 40) * scale)), fontWeight: Number(el.fontWeight) >= 700 || el.fontWeight === 'bold' ? 700 : 400, color: safeColor(el.fill, '#ffffff'), align: el.align === 'center' || el.align === 'right' ? el.align : 'left' });
        break;
      case 'image': {
        const src = typeof el.src === 'string' ? el.src.trim() : '';
        if (EMBEDDED_IMAGE.test(src) && !PHOTO_NAME.test(name)) {
          const ref = `embedded-${i}`;
          const crop = { x: Number(el.cropX) || 0, y: Number(el.cropY) || 0, width: Number(el.cropWidth) || 1, height: Number(el.cropHeight) || 1 };
          const whole = crop.x < 0.001 && crop.y < 0.001 && crop.width > 0.999 && crop.height > 0.999;
          embedded.push({ ref, name, dataUrl: src, ...(whole ? {} : { crop }) });
          layers.push({ ...geom, type: 'fixed-photo', assetId: ref, radius: Math.min(540, (Number(el.cornerRadius) || 0) * scale) });
          notes.push(`Picture “${name}” is kept as part of the design (name it “photo” in Polotno to make it a photo slot instead).`);
        } else {
          photoLayer(geom, name);
          if (/^https?:/i.test(src)) notes.push(`Image “${name}” became a photo slot; its URL was not fetched.`);
        }
        break;
      }
      case 'figure':
      case 'rect':
      case 'circle':
      case 'line': {
        const sub = el.type === 'circle' ? 'circle' : el.type === 'line' ? 'rect' : String(el.subType ?? 'rect');
        const fill = safeColor(el.type === 'line' ? (el.color ?? el.stroke ?? el.fill) : el.fill, 'accent');
        if (sub === 'circle' || sub === 'ellipse') {
          layers.push({ ...geom, type: 'circle', fill, ...stroke });
          break;
        }
        const path = sub === 'rect' ? null : figurePath(sub, geom.width, geom.height);
        if (path) {
          const sw = stroke.stroke ? ` stroke="${stroke.stroke}" stroke-width="${stroke.strokeWidth.toFixed(2)}"` : '';
          const fillAttr = fill === 'accent' ? '#4f46e5' : fill;
          const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(geom.width)}" height="${Math.round(geom.height)}" viewBox="0 0 ${geom.width.toFixed(2)} ${geom.height.toFixed(2)}" preserveAspectRatio="none"><path d="${path}" fill="${fillAttr}"${sw}/></svg>`;
          layers.push({ ...geom, type: 'svg', svg: sanitizeSvg(svg) ?? svg });
          break;
        }
        if (sub !== 'rect') notes.push(`Figure “${name}” (${sub}) is drawn as a rectangle.`);
        layers.push({ ...geom, type: 'rect', fill, radius: Math.min(540, (Number(el.cornerRadius) || 0) * scale), ...stroke });
        break;
      }
      case 'svg': {
        let text = typeof el.svg === 'string' ? el.svg : svgFromDataUrl(el.src);
        if (text && el.colorsReplace && typeof el.colorsReplace === 'object') {
          for (const [from, to] of Object.entries(el.colorsReplace)) {
            const safeTo = safeColor(to, '');
            if (safeTo && from) text = text.split(from).join(safeTo);
          }
        }
        const svg = text ? sanitizeSvg(text) : null;
        if (svg) layers.push({ ...geom, type: 'svg', svg });
        else notes.push(`SVG “${name}” was not imported (${typeof el.src === 'string' && /^https?:/i.test(el.src) ? 'a link, not fetched' : 'unsafe, too large or not inline'}).`);
        break;
      }
      default:
        notes.push(`Element type “${String(el.type)}” is not supported and was skipped.`);
    }
  }

  if (!layers.some((l) => l.type === 'photo')) {
    // A full-height, narrow bar near the middle reads as a divider between two photos.
    const bars = layers.filter((l) => (l.type === 'rect' || l.type === 'svg') && !(l.rotation ?? 0) && (l.height ?? 0) >= CANVAS.height * 0.9 && (l.width ?? 0) <= CANVAS.width * 0.1 && Math.abs((l.x ?? 0) + (l.width ?? 0) / 2 - CANVAS.width / 2) <= CANVAS.width * 0.15);
    const slots: LayerInput[] = [];
    if (bars.length) {
      const left = Math.min(...bars.map((b) => b.x ?? 0));
      const right = Math.max(...bars.map((b) => (b.x ?? 0) + (b.width ?? 0)));
      slots.push({ id: 'impphoto0', name: 'Photo 1', type: 'photo', slot: 0, x: 0, y: 0, width: Math.max(1, left), height: CANVAS.height });
      slots.push({ id: 'impphoto1', name: 'Photo 2', type: 'photo', slot: 1, x: right, y: 0, width: Math.max(1, CANVAS.width - right), height: CANVAS.height });
      notes.push('The design has no photo place: two photo slots were added behind it, left and right of the centre divider.');
    } else {
      slots.push({ id: 'impphoto0', name: 'Photo 1', type: 'photo', slot: 0, x: 0, y: 0, width: CANVAS.width, height: CANVAS.height });
      notes.push('The design has no photo place: a photo slot was added behind it, over the whole canvas.');
    }
    const at = layers[0]?.id === 'impbg' ? 1 : 0;
    layers.splice(at, 0, ...slots);
    if (layers.length > 40) layers.length = 40;
  }

  const parsed = templateSchema.safeParse({ name: 'Imported', background: safeColor(background, '#ffffff'), layers });
  if (!parsed.success) return { template: presetSingle(), notes: [...notes, `The import was not valid (${parsed.error.issues[0]?.path.join('.')}: ${parsed.error.issues[0]?.message}); the default preset was used.`], embedded: [] };
  return { template: parsed.data, notes, embedded: embedded.filter((e) => parsed.data.layers.some((l) => l.type === 'fixed-photo' && l.assetId === e.ref)) };
}
