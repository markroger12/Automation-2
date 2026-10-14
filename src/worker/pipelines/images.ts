import fs from 'node:fs';
import type { MediaAsset } from '@prisma/client';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { parseJson } from '@/lib/json';
import { fromDataRelative } from '@/lib/paths';
import { NeedsReviewError } from '@/lib/pipeline-errors';
import { parseSiteImageSettings, presetSingle, type ImageTemplate } from '@/lib/image-template';
import { outputSize, renderCleanImage, renderTemplate } from '@/images/render';
import { hammingDistance, storeRendered } from '@/images/store';
import { collectCommonsGallery } from '@/images/sources/wikimedia';
import { loadTemplateAssets } from '@/images/site-templates';
import type { StageManifest } from '@/modules/types';
import type { PipelineContext, PipelineStage, StageResult } from '../pipeline/types';
import { bind, waiting } from './common';

/**
 * IMAGES: a 16:9 featured image (site template: photo/illustration, title,
 * logo) and two clean body images. Celebrity articles use a bounded photo
 * gallery (owner uploads first, then Wikimedia Commons); general articles use
 * an image plan and ChatGPT image generation. Every optional part degrades
 * safely: missing images are reported, never faked, and never block the text.
 * No image-rights/licensing checks exist by design (owner decision).
 */

export type ImageSlotName = 'FEATURED' | 'BODY1' | 'BODY2';

export interface ImageSlot {
  slot: ImageSlotName;
  mediaAssetId: string;
  alt: string;
  sourceAssetIds: string[];
  /** BODY slots: the figure inserted by assembly. */
  html?: string;
  width: number;
  height: number;
  bytes: number;
}

export interface ImagesData {
  slots: ImageSlot[];
  gallery: { id: string; source: string; sourceUrl: string | null; title: string; used: boolean; note?: string }[];
  plan?: { slot: ImageSlotName; direction: string; alt: string }[];
  notes: string[];
  warnings: string[];
}

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function figure(slot: ImageSlotName, asset: { id: string; width: number | null; height: number | null }, alt: string): string {
  return `<figure class="bas-image" data-bas-slot="${slot}"><img src="/api/media/${asset.id}" alt="${escAttr(alt)}" width="${asset.width ?? ''}" height="${asset.height ?? ''}" data-bas-media="${asset.id}" loading="lazy"></figure>`;
}

async function readAsset(a: MediaAsset): Promise<Buffer> {
  return fs.promises.readFile(fromDataRelative(a.filePath));
}

async function supersedeRendered(taskId: string) {
  await db.mediaAsset.updateMany({ where: { taskId, origin: 'RENDERED', role: { in: ['FEATURED', 'BODY1', 'BODY2'] }, status: { in: ['READY', 'UPLOADED'] } }, data: { status: 'REJECTED', notes: 'superseded by a newer image run' } });
}

function templatePhotoSlots(t: ImageTemplate): number {
  return Math.max(0, ...t.layers.filter((l) => l.type === 'photo' && l.visible).map((l) => (l.type === 'photo' ? l.slot + 1 : 0)));
}

interface RenderPlan {
  featuredPhotos: { asset: MediaAsset; focus?: { x: number; y: number } | null }[];
  body1?: { asset: MediaAsset; alt: string };
  body2?: { asset: MediaAsset; alt: string };
  featuredAlt: string;
}

async function renderAll(ctx: PipelineContext, plan: RenderPlan, notes: string[]): Promise<ImageSlot[]> {
  const site = await db.website.findUniqueOrThrow({ where: { id: ctx.task.websiteId } });
  const settings = parseSiteImageSettings(site.imageSettings);
  const size = outputSize(ctx.config.imageOutputSize);
  const opts = { ...size, maxBytes: ctx.config.imageMaxBytes };
  const { logo, fixedPhotos } = await loadTemplateAssets(site.id, settings, [settings.featured, settings.body]);
  const usesLogo = [settings.featured, settings.body].some((t) => t?.layers.some((l) => l.type === 'logo' && l.visible));
  if (!logo && usesLogo) notes.push('No site logo uploaded yet (Image Template → Logo); the images were rendered without it.');
  const title = (ctx.task.selectedTitle ?? ctx.task.seoTitle ?? ctx.task.keyword).trim();
  await supersedeRendered(ctx.taskId);
  const slots: ImageSlot[] = [];

  if (plan.featuredPhotos.length || templatePhotoSlots(settings.featured) === 0) {
    let template = settings.featured;
    if (templatePhotoSlots(template) > plan.featuredPhotos.length && plan.featuredPhotos.length === 1) {
      // A two-photo design with one usable photo: never repeat a photo — use the single-photo preset.
      template = presetSingle(template.accent);
      notes.push('Only one photo was available for the two-photo featured design; the single-photo preset was used.');
    }
    const photos = await Promise.all(plan.featuredPhotos.map((p) => readAsset(p.asset)));
    const r = await renderTemplate({ template, photos, focus: plan.featuredPhotos.map((p) => p.focus ?? null), logo, fixedPhotos, vars: { title, site: site.name, keyword: ctx.task.keyword } }, opts);
    const a = await storeRendered({ buffer: r.buffer, mime: r.mime, taskId: ctx.taskId, websiteId: site.id, role: 'FEATURED', altText: plan.featuredAlt, slug: ctx.task.slug, sourceUrl: plan.featuredPhotos[0]?.asset.sourceUrl ?? null });
    slots.push({ slot: 'FEATURED', mediaAssetId: a.id, alt: plan.featuredAlt, sourceAssetIds: plan.featuredPhotos.map((p) => p.asset.id), width: r.width, height: r.height, bytes: r.buffer.length });
  }
  for (const [slotName, b] of [['BODY1', plan.body1], ['BODY2', plan.body2]] as const) {
    if (!b) continue;
    const src = await readAsset(b.asset);
    const r = settings.body ? await renderTemplate({ template: settings.body, photos: [src], logo, fixedPhotos, vars: { title, site: site.name, keyword: ctx.task.keyword } }, opts) : await renderCleanImage(src, opts);
    const a = await storeRendered({ buffer: r.buffer, mime: r.mime, taskId: ctx.taskId, websiteId: site.id, role: slotName, altText: b.alt, slug: ctx.task.slug, sourceUrl: b.asset.sourceUrl });
    slots.push({ slot: slotName, mediaAssetId: a.id, alt: b.alt, sourceAssetIds: [b.asset.id], html: figure(slotName, { id: a.id, width: r.width, height: r.height }, b.alt), width: r.width, height: r.height, bytes: r.buffer.length });
  }
  return slots;
}

function finish(ctx: PipelineContext, data: ImagesData): StageResult {
  const have = new Set(data.slots.map((s) => s.slot));
  const missing = (['FEATURED', 'BODY1', 'BODY2'] as const).filter((s) => !have.has(s));
  if (missing.length) {
    const msg = `Missing image(s): ${missing.join(', ')}.`;
    if (ctx.config.imagesRequired) throw new NeedsReviewError(`${msg} Images are required for this site.`, [`Images: ${msg}`], 'Upload photos on the Images tab or adjust the image settings, then regenerate Images.');
    data.notes.push(`${msg} The draft continues without them (images are optional for this site).`);
  }
  return { outcome: 'completed', data, message: `${data.slots.length} image(s) ready${missing.length ? ` · missing ${missing.join(', ')}` : ''}` };
}

// ------------------------------------------------------------ general (Tigram)

export function parseImagePlan(text: string): { slot: ImageSlotName; direction: string; alt: string }[] {
  const out: { slot: ImageSlotName; direction: string; alt: string }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\*\*/g, '').replace(/^[\s>*\-•\d.)]+/, '').trim();
    const m = /^(FEATURED|BODY\s*1|BODY\s*2)\s*:\s*(.+?)\s*\|\s*ALT\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    const slot = m[1].toUpperCase().replace(/\s+/g, '') as ImageSlotName;
    if (!out.some((o) => o.slot === slot)) out.push({ slot, direction: m[2].trim().slice(0, 600), alt: m[3].trim().replace(/^["“]|["”]$/g, '').slice(0, 160) });
  }
  return out;
}

async function generalImages(ctx: PipelineContext): Promise<StageResult> {
  const notes: string[] = [];
  const planRes = await ctx.askChatGPT('IMAGE_PLAN');
  if (planRes.status === 'waiting') return waiting('Waiting for ChatGPT: image plan');
  const plan = parseImagePlan(planRes.text);
  if (plan.length < 3) notes.push(`The image plan had ${plan.length} of 3 usable lines.`);
  // Owner uploads (Images tab) fill the slots first, in upload order; only the rest is generated.
  const uploads = await db.mediaAsset.findMany({ where: { taskId: ctx.taskId, role: 'UPLOAD', status: { not: 'REJECTED' } }, orderBy: { createdAt: 'asc' }, take: 3 });
  const owned = new Map<ImageSlotName, MediaAsset>((['FEATURED', 'BODY1', 'BODY2'] as const).slice(0, uploads.length).map((slot, i) => [slot, uploads[i]]));
  if (owned.size) notes.push(`${owned.size} of your uploaded image(s) used for ${[...owned.keys()].join(', ')}.`);
  // Ask for every image first (tabs can work in parallel), then wait.
  const results = await Promise.all(
    plan.filter((p) => !owned.has(p.slot)).map(async (p) => ({
      p,
      res: await ctx.askChatGPT('IMAGE_GENERATION', { image_brief: `${p.direction}${p.slot === 'FEATURED' ? ' — 16:9, leave calm space for a short headline and a logo.' : ' — 16:9, no text, no watermark, no logo.'}` }, { part: p.slot, newChat: true, expectImages: true }),
    })),
  );
  if (results.some((r) => r.res.status === 'waiting')) return waiting(`Waiting for ChatGPT: ${results.filter((r) => r.res.status === 'waiting').length} image(s)`);
  const byslot = new Map<ImageSlotName, { asset: MediaAsset; alt: string }>();
  const fallbackAlt = ctx.task.selectedTitle ?? ctx.task.seoTitle ?? ctx.task.keyword;
  for (const [slot, asset] of owned) byslot.set(slot, { asset, alt: plan.find((p) => p.slot === slot)?.alt ?? asset.altText ?? fallbackAlt });
  for (const { p, res } of results) {
    if (res.status !== 'completed') continue;
    const id = res.images[0]?.mediaAssetId;
    const asset = id ? await db.mediaAsset.findUnique({ where: { id } }) : null;
    if (!asset) {
      notes.push(`ChatGPT returned no image for ${p.slot}${res.text ? ` (“${res.text.slice(0, 80)}”)` : ''}.`);
      continue;
    }
    byslot.set(p.slot, { asset, alt: p.alt });
  }
  const featured = byslot.get('FEATURED');
  const slots = await renderAll(
    ctx,
    { featuredPhotos: featured ? [{ asset: featured.asset }] : [], featuredAlt: featured?.alt ?? (ctx.task.selectedTitle ?? ctx.task.keyword), body1: byslot.get('BODY1'), body2: byslot.get('BODY2') },
    notes,
  );
  return finish(ctx, { slots, gallery: [...byslot.entries()].map(([slot, v]) => ({ id: v.asset.id, source: v.asset.role === 'UPLOAD' ? 'your upload' : 'ChatGPT image', sourceUrl: v.asset.sourceUrl, title: slot, used: true })), plan, notes, warnings: [] });
}

// ------------------------------------------------------------------ celebrity

export function parsePhotoCheck(text: string, count: number): Map<number, { watermark: boolean; collage: boolean; alt: string }> {
  const out = new Map<number, { watermark: boolean; collage: boolean; alt: string }>();
  for (const raw of text.split('\n')) {
    const m = /^\s*(\d{1,2})\s*[:.)]\s*watermark\s*=\s*(yes|no)\s*\|\s*collage\s*=\s*(yes|no)\s*\|\s*alt\s*=\s*(.+)$/i.exec(raw.replace(/\*\*/g, ''));
    if (!m) continue;
    const n = Number(m[1]);
    if (n < 1 || n > count) continue;
    out.set(n, { watermark: m[2].toLowerCase() === 'yes', collage: m[3].toLowerCase() === 'yes', alt: m[4].trim().split(/\s+/).slice(0, 12).join(' ') });
  }
  return out;
}

interface CelebState extends Record<string, unknown> {
  galleryIds?: string[];
  galleryNotes?: string[];
}

async function celebrityImages(ctx: PipelineContext): Promise<StageResult> {
  const settings = await getSettings();
  const notes: string[] = [];
  const quickBio = parseJson<{ attribute: string; details: string }[]>(ctx.task.quickBio, []);
  const { confirmedFullName } = await import('@/modules/celebrity-writer/parsers');
  const name = confirmedFullName(quickBio) ?? ctx.task.keyword;
  const state = ctx.privateState<CelebState>();

  // 1. Gallery: owner uploads first, then a bounded Wikimedia Commons search (collected once per run).
  let galleryIds = state.galleryIds;
  if (!galleryIds) {
    const uploads = await db.mediaAsset.findMany({ where: { taskId: ctx.taskId, role: 'UPLOAD', status: { not: 'REJECTED' } }, orderBy: { createdAt: 'asc' } });
    const ids = uploads.map((u) => u.id);
    const galleryNotes: string[] = [];
    if (ids.length < 4) {
      try {
        await ctx.progress(`Collecting photos of ${name}…`);
        const g = await collectCommonsGallery({ name, taskId: ctx.taskId, websiteId: ctx.task.websiteId, max: 6 - ids.length, timeoutMs: settings.advanced.linkCheckTimeoutSec * 1000 * 2 });
        ids.push(...g.assets.map((a) => a.id));
        galleryNotes.push(...g.notes.slice(0, 6));
      } catch (error) {
        galleryNotes.push(`Photo search unavailable: ${(error as Error).message}`);
      }
    }
    galleryIds = ids;
    await ctx.setPrivateState({ galleryIds, galleryNotes });
  }
  notes.push(...(ctx.privateState<CelebState>().galleryNotes ?? []));
  // Photos the owner removed on the Images tab are never used.
  let gallery = galleryIds.length ? await db.mediaAsset.findMany({ where: { id: { in: galleryIds }, status: { not: 'REJECTED' } } }) : [];
  gallery = galleryIds.map((id) => gallery.find((g) => g.id === id)).filter(Boolean) as MediaAsset[];
  // Near-duplicates across uploads and Commons.
  const distinct: MediaAsset[] = [];
  for (const g of gallery) {
    if (g.phash && distinct.some((d) => d.phash && hammingDistance(d.phash, g.phash!) <= 6)) notes.push('A near-duplicate photo was skipped.');
    else distinct.push(g);
  }

  // 2. Optional photo check through ChatGPT (watermarks/collages + alt text; never identifies anyone).
  const alts = new Map<string, string>();
  let usable = distinct;
  if (ctx.config.celebrityPhotoReview && distinct.length) {
    const sample = distinct.slice(0, 6);
    const res = await ctx.askChatGPT('PHOTO_CHECK', { photo_count: String(sample.length) }, { part: 'check', newChat: true, attachments: sample.map((a, i) => ({ mediaAssetId: a.id, name: `photo-${i + 1}.webp`, mime: a.mime ?? 'image/webp' })) });
    if (res.status === 'waiting') return waiting('Waiting for ChatGPT: photo check');
    const verdicts = parsePhotoCheck(res.text, sample.length);
    usable = [];
    sample.forEach((a, i) => {
      const v = verdicts.get(i + 1);
      if (v?.watermark || v?.collage) notes.push(`Photo ${i + 1} skipped: ${v.watermark ? 'watermark' : ''}${v.watermark && v.collage ? ' and ' : ''}${v.collage ? 'collage' : ''}.`);
      else {
        usable.push(a);
        if (v?.alt) alts.set(a.id, v.alt);
      }
    });
    if (!verdicts.size) notes.push('The photo check answer could not be read; all photos were kept.');
    if (!verdicts.size) usable = sample;
  }
  if (settings.seo.enhanceCelebrityImages) notes.push('Image enhancement is enabled but no local enhancement tool is installed; originals were used.');

  // 3. Distinct photos per design slot (never the same photo twice).
  if (!usable.length) {
    notes.push(`No usable photo of ${name} was found.`);
    return finish(ctx, { slots: [], gallery: gallery.map((g) => ({ id: g.id, source: g.origin, sourceUrl: g.sourceUrl, title: g.notes ?? '', used: false })), notes, warnings: [] });
  }
  const site = await db.website.findUniqueOrThrow({ where: { id: ctx.task.websiteId } });
  const featuredNeeds = Math.max(1, templatePhotoSlots(parseSiteImageSettings(site.imageSettings).featured));
  // A two-photo featured design only takes two photos when at least one is left for the body.
  const featuredPhotos = usable.slice(0, usable.length > 2 ? featuredNeeds : 1);
  const rest = usable.slice(featuredPhotos.length);
  const alt = (a: MediaAsset, fallback: string) => alts.get(a.id) ?? fallback;
  const lang = ctx.task.language;
  const slots = await renderAll(
    ctx,
    {
      featuredPhotos: featuredPhotos.map((asset) => ({ asset })),
      featuredAlt: ctx.task.selectedTitle ?? ctx.task.keyword,
      body1: rest[0] ? { asset: rest[0], alt: alt(rest[0], lang === 'de' ? `Foto von ${name}` : `Photo of ${name}`) } : undefined,
      body2: rest[1] ? { asset: rest[1], alt: alt(rest[1], lang === 'de' ? `Weiteres Foto von ${name}` : `Another photo of ${name}`) } : undefined,
    },
    notes,
  );
  const used = new Set(slots.flatMap((s) => s.sourceAssetIds));
  return finish(ctx, { slots, gallery: gallery.map((g) => ({ id: g.id, source: g.origin === 'UPLOADED' ? 'your upload' : g.origin === 'WIKIMEDIA' ? 'Wikimedia Commons' : g.origin, sourceUrl: g.sourceUrl, title: g.notes ?? '', used: used.has(g.id) })), notes, warnings: [] });
}

export function imagesStage(manifest: StageManifest): PipelineStage {
  return bind(manifest, {
    shouldRun: (ctx) => ctx.config.images,
    run: (ctx) => (ctx.task.moduleKey === 'tigram-writer' ? generalImages(ctx) : celebrityImages(ctx)),
  });
}
