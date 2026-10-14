import fs from 'node:fs';
import sharp from 'sharp';
import type { MediaAsset } from '@prisma/client';
import { db } from '@/lib/db';
import { audit } from '@/lib/audit';
import { badRequest, notFound } from '@/lib/errors';
import { fromDataRelative } from '@/lib/paths';
import { getSettings, parseSiteOverrides } from '@/lib/settings';
import { parseSiteImageSettings, sanitizeSvg, siteImageSettingsSchema, type ImageTemplate, type SiteImageSettings } from '@/lib/image-template';
import { outputSize, renderCanvas, renderCleanImage, renderTemplate } from './render';
import { MAX_IMAGE_BYTES, sniffImage, storeImage } from './store';

/**
 * Per-site image templates: load/save (validated, SVG sanitized, asset
 * references checked), template assets (logo, fixed photos) and the live
 * preview, which uses the same production renderer as the IMAGES stage.
 */

export const TEMPLATE_ASSET_ROLES = ['LOGO', 'TEMPLATE_PHOTO'] as const;
export type TemplateAssetRole = (typeof TEMPLATE_ASSET_ROLES)[number];

async function readAsset(a: Pick<MediaAsset, 'filePath'>): Promise<Buffer> {
  return fs.promises.readFile(fromDataRelative(a.filePath));
}

export async function siteTemplateAssets(websiteId: string) {
  return db.mediaAsset.findMany({ where: { websiteId, taskId: null, role: { in: [...TEMPLATE_ASSET_ROLES] }, status: { not: 'REJECTED' } }, orderBy: { createdAt: 'desc' }, take: 60 });
}

/** The logo the renderer uses: the chosen one, else the newest uploaded logo. */
export async function siteLogoAsset(websiteId: string, logoAssetId: string | null) {
  if (logoAssetId) {
    const chosen = await db.mediaAsset.findFirst({ where: { id: logoAssetId, websiteId, status: { not: 'REJECTED' } } });
    if (chosen) return chosen;
  }
  return db.mediaAsset.findFirst({ where: { websiteId, role: 'LOGO', status: { not: 'REJECTED' } }, orderBy: { createdAt: 'desc' } });
}

/** Logo and fixed-photo buffers for a template (missing files are skipped, never fatal). */
export async function loadTemplateAssets(websiteId: string, settings: SiteImageSettings, templates: (ImageTemplate | null)[]): Promise<{ logo: Buffer | null; fixedPhotos: Record<string, Buffer> }> {
  const logoAsset = await siteLogoAsset(websiteId, settings.logoAssetId);
  let logo: Buffer | null = null;
  if (logoAsset) logo = await readAsset(logoAsset).catch(() => null);
  const ids = [...new Set(templates.flatMap((t) => t?.layers ?? []).flatMap((l) => (l.type === 'fixed-photo' ? [l.assetId] : [])))];
  const fixedPhotos: Record<string, Buffer> = {};
  if (ids.length) {
    for (const a of await db.mediaAsset.findMany({ where: { id: { in: ids }, websiteId } })) {
      const buf = await readAsset(a).catch(() => null);
      if (buf) fixedPhotos[a.id] = buf;
    }
  }
  return { logo, fixedPhotos };
}

export async function getSiteImageSettings(websiteId: string) {
  const site = await db.website.findUnique({ where: { id: websiteId } });
  if (!site) throw notFound('Website');
  return { site, settings: parseSiteImageSettings(site.imageSettings) };
}

function sanitizeTemplate(t: ImageTemplate, label: string, errors: string[]): ImageTemplate {
  return {
    ...t,
    layers: t.layers.map((l) => {
      if (l.type !== 'svg') return l;
      const svg = sanitizeSvg(l.svg);
      if (!svg) errors.push(`${label}: SVG layer “${l.name || l.id}” is not a plain inline SVG.`);
      return { ...l, svg: svg ?? '' };
    }),
  };
}

/** Validate and save a site's templates. Asset references must belong to the site. */
export async function saveSiteImageSettings(websiteId: string, input: unknown): Promise<SiteImageSettings> {
  const parsed = siteImageSettingsSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw badRequest(`Template is not valid: ${first ? `${first.path.join('.')}: ${first.message}` : 'unknown error'}`);
  }
  const errors: string[] = [];
  const value: SiteImageSettings = {
    featured: sanitizeTemplate(parsed.data.featured, 'Featured', errors),
    body: parsed.data.body ? sanitizeTemplate(parsed.data.body, 'Body', errors) : null,
    logoAssetId: parsed.data.logoAssetId,
  };
  const layerIds = [value.featured, value.body].flatMap((t) => t?.layers.map((l) => l.id) ?? []);
  for (const t of [value.featured, value.body]) {
    if (!t) continue;
    const ids = t.layers.map((l) => l.id);
    if (new Set(ids).size !== ids.length) errors.push(`${t.name}: layer ids must be unique.`);
  }
  const refs = [...new Set([value.logoAssetId, ...[value.featured, value.body].flatMap((t) => t?.layers ?? []).flatMap((l) => (l.type === 'fixed-photo' ? [l.assetId] : []))].filter((x): x is string => Boolean(x)))];
  if (refs.length) {
    const found = await db.mediaAsset.findMany({ where: { id: { in: refs }, websiteId }, select: { id: true } });
    const missing = refs.filter((r) => !found.some((f) => f.id === r));
    if (missing.length) errors.push(`Unknown image asset(s) for this website: ${missing.join(', ')}.`);
  }
  if (errors.length) throw badRequest(errors.join(' '));
  const site = await db.website.update({ where: { id: websiteId }, data: { imageSettings: JSON.stringify(value) } }).catch(() => null);
  if (!site) throw notFound('Website');
  await audit('website.image_templates', 'Website', websiteId, { featured: value.featured.name, body: value.body?.name ?? 'clean photo', layers: layerIds.length, logoAssetId: value.logoAssetId });
  return value;
}

/** Store a site logo or fixed template photo. SVG logos are sanitized and rasterized (scripts never run). */
export async function storeTemplateAsset(websiteId: string, role: TemplateAssetRole, file: { name: string; bytes: Buffer }) {
  const site = await db.website.findUnique({ where: { id: websiteId } });
  if (!site) throw notFound('Website');
  if (file.bytes.length > MAX_IMAGE_BYTES) throw badRequest('Images must be 12 MB or smaller.');
  let buffer = file.bytes;
  const head = buffer.subarray(0, 512).toString('utf8').trimStart();
  if (!sniffImage(buffer) && /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) {
    if (role !== 'LOGO') throw badRequest('SVG is accepted for logos only.');
    const safe = sanitizeSvg(buffer.toString('utf8'));
    if (!safe) throw badRequest('This SVG could not be used (only plain shapes are allowed: no scripts, embedded images, fonts or external references).');
    try {
      buffer = await sharp(Buffer.from(safe), { density: 300 }).resize(1200, 1200, { fit: 'inside', withoutEnlargement: false }).png().toBuffer();
    } catch (error) {
      throw badRequest(`The SVG could not be rendered: ${(error as Error).message}`);
    }
  }
  if (!sniffImage(buffer)) throw badRequest('Upload a PNG, JPEG, WebP or GIF (logos may also be SVG).');
  try {
    const { asset } = await storeImage({ buffer, websiteId, role, origin: 'UPLOADED', notes: file.name.slice(0, 180) });
    await audit('website.image_asset', 'Website', websiteId, { role, assetId: asset.id, name: file.name.slice(0, 120) });
    return asset;
  } catch (error) {
    throw badRequest((error as Error).message);
  }
}

/** Retire a template asset (kept on disk; never deleted). */
export async function retireTemplateAsset(websiteId: string, assetId: string) {
  const asset = await db.mediaAsset.findFirst({ where: { id: assetId, websiteId, taskId: null, role: { in: [...TEMPLATE_ASSET_ROLES] } } });
  if (!asset) throw notFound('Image');
  await db.mediaAsset.update({ where: { id: asset.id }, data: { status: 'REJECTED', notes: `${asset.notes ?? ''} (removed from the template library)`.trim() } });
  const { settings } = await getSiteImageSettings(websiteId);
  if (settings.logoAssetId === asset.id) await db.website.update({ where: { id: websiteId }, data: { imageSettings: JSON.stringify({ ...settings, logoAssetId: null }) } });
  await audit('website.image_asset_removed', 'Website', websiteId, { assetId });
  return { ok: true };
}

// ------------------------------------------------------------- preview

let samples: Promise<Buffer[]> | null = null;

/** Two neutral sample “photos” for previews when the site has no photos yet (clearly synthetic). */
function samplePhotos(): Promise<Buffer[]> {
  samples ??= Promise.all(
    [
      ['#0ea5e9', '#1e3a8a', '#fcd34d'],
      ['#f97316', '#7c2d12', '#fde68a'],
    ].map(([a, b, c], i) =>
      sharp(
        Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="1600" height="1067" fill="url(#g)"/><circle cx="${i ? 980 : 620}" cy="400" r="170" fill="${c}"/><rect x="${i ? 760 : 400}" y="600" width="440" height="467" rx="200" fill="${c}" fill-opacity="0.85"/><text x="40" y="1030" font-family="Arial" font-size="42" fill="#ffffff" fill-opacity="0.75">Sample photo ${i + 1}</text></svg>`,
        ),
      )
        .jpeg({ quality: 85 })
        .toBuffer(),
    ),
  );
  return samples;
}

export interface PreviewInput {
  template: ImageTemplate | null;
  kind: 'featured' | 'body';
  title: string;
  photoAssetIds?: string[];
  logoAssetId?: string | null;
  final?: boolean;
}

/**
 * Render a preview with the production renderer. Draft previews are scaled to
 * 960×540 for speed; `final` uses the site's real output size and byte budget
 * and reports the encoded size.
 */
export async function renderPreview(websiteId: string, input: PreviewInput): Promise<{ buffer: Buffer; mime: string; width: number; height: number; bytes: number; quality: number | null; budget: number | null }> {
  const { site, settings } = await getSiteImageSettings(websiteId);
  const photos: Buffer[] = [];
  if (input.photoAssetIds?.length) {
    const assets = await db.mediaAsset.findMany({ where: { id: { in: input.photoAssetIds.slice(0, 2) }, websiteId } });
    for (const id of input.photoAssetIds.slice(0, 2)) {
      const a = assets.find((x) => x.id === id);
      const buf = a ? await readAsset(a).catch(() => null) : null;
      if (buf) photos.push(buf);
    }
  }
  if (photos.length < 2) photos.push(...(await samplePhotos()).slice(photos.length));
  const assets = await loadTemplateAssets(websiteId, { ...settings, logoAssetId: input.logoAssetId === undefined ? settings.logoAssetId : input.logoAssetId }, [input.template]);
  const vars = { title: input.title || 'Your article title appears here', site: site.name, keyword: 'example keyword' };
  if (input.final) {
    const global = await getSettings();
    const overrides = parseSiteOverrides(site.settingsOverrides);
    const size = outputSize(overrides.seo.imageOutputSize ?? global.seo.imageOutputSize);
    const opts = { ...size, maxBytes: global.seo.imageMaxBytes };
    const r = input.template ? await renderTemplate({ template: input.template, photos, logo: assets.logo, fixedPhotos: assets.fixedPhotos, vars }, opts) : await renderCleanImage(photos[0], opts);
    return { buffer: r.buffer, mime: r.mime, width: r.width, height: r.height, bytes: r.buffer.length, quality: r.quality, budget: opts.maxBytes };
  }
  const png = input.template ? await renderCanvas({ template: input.template, photos, logo: assets.logo, fixedPhotos: assets.fixedPhotos, vars }) : (await renderCleanImage(photos[0], { width: 1920, height: 1080, maxBytes: 5_000_000 })).buffer;
  const buffer = await sharp(png).resize(960, 540, { fit: 'cover' }).webp({ quality: 78 }).toBuffer();
  return { buffer, mime: 'image/webp', width: 960, height: 540, bytes: buffer.length, quality: null, budget: null };
}
