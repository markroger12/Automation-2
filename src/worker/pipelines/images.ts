import fs from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import type { MediaAsset } from '@prisma/client';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { parseJson } from '@/lib/json';
import { fromDataRelative } from '@/lib/paths';
import { NeedsReviewError, TransientError, UncertainSideEffectError } from '@/lib/pipeline-errors';
import { CANVAS, parseSiteImageSettings, presetBodyCornerLogo, presetSingle, templateSet, templateSetFor, type ImageTemplate } from '@/lib/image-template';
import { outputSize, renderCleanImage, renderTemplate, type PhotoFocus } from '@/images/render';
import { normalizeAltText, type AltSlot } from '@/images/alt-text';
import { hammingDistance, storeRendered } from '@/images/store';
import { collectCommonsGallery } from '@/images/sources/wikimedia';
import { collectChatGPTGallery, GALLERY_MIN_SIDE } from '@/images/sources/chatgpt-gallery';
import { loadTemplateAssets } from '@/images/site-templates';
import { detectSubjects, faceToolAvailable, headsOfPeople, mainFaceArea, mainFaces } from '@/images/faces';
import { enhancePhoto } from '@/images/upscale';
import { faceFingerprint, fingerprintDistance, pictureSharpness, SAME_FACES_BITS, SOFT_SHARE } from '@/images/measure';
import type { StageManifest } from '@/modules/types';
import type { PipelineContext, PipelineStage, StageResult } from '../pipeline/types';
import { bind, waiting } from './common';

/**
 * IMAGES: a 16:9 featured image (site template: photo/illustration, title,
 * logo) and two clean body images. Celebrity articles use a bounded photo
 * gallery (owner uploads first, then ChatGPT's image-search gallery and/or
 * Wikimedia Commons, per Settings); general articles use an image plan and
 * ChatGPT image generation. Every optional part degrades
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

type Focus = PhotoFocus;

interface RenderPlan {
  /** `buffer`: a prepared (e.g. upscaled) copy of the asset; `focus`: where the crop centres (faces). */
  featuredPhotos: { asset: MediaAsset; focus?: Focus; buffer?: Buffer }[];
  body1?: { asset: MediaAsset; alt: string; focus?: Focus; buffer?: Buffer };
  body2?: { asset: MediaAsset; alt: string; focus?: Focus; buffer?: Buffer };
  featuredAlt: string;
  /**
   * Tigram, as in the owner's earlier tool: the featured picture already carries its title (ChatGPT wrote it), so it
   * gets the picture-with-logo design like the body images, not the featured template with a title overlay.
   */
  featuredAsBody?: boolean;
}

async function renderAll(ctx: PipelineContext, plan: RenderPlan, notes: string[]): Promise<ImageSlot[]> {
  const site = await db.website.findUniqueOrThrow({ where: { id: ctx.task.websiteId } });
  const siteSettings = parseSiteImageSettings(site.imageSettings);
  // The writer's own templates (Image Template → Celebrity / Tigram).
  const settings = templateSet(siteSettings, templateSetFor(ctx.task.moduleKey));
  const size = outputSize(ctx.config.imageOutputSize);
  const opts = { ...size, maxBytes: ctx.config.imageMaxBytes };
  const { logo, fixedPhotos } = await loadTemplateAssets(site.id, siteSettings, [settings.featured, settings.body]);
  const usesLogo = [settings.featured, settings.body].some((t) => t?.layers.some((l) => l.type === 'logo' && l.visible));
  if (!logo && usesLogo) notes.push('No site logo uploaded yet (Image Template → Logo); the images were rendered without it.');
  const title = (ctx.task.selectedTitle ?? ctx.task.seoTitle ?? ctx.task.keyword).trim();
  await supersedeRendered(ctx.taskId);
  const slots: ImageSlot[] = [];
  // Descriptive, distinct alt text per slot (upgrade 08); problems are listed in the image notes.
  const usedAlt: string[] = [];
  const altFor = (slot: AltSlot, raw: string) => {
    const r = normalizeAltText(raw, slot, { subject: ctx.task.keyword, keyword: ctx.task.focusKeyword ?? ctx.task.keyword, title, language: ctx.task.language, others: usedAlt });
    if (r.issues.length) notes.push(`${slot} alt text: ${r.issues.join('; ')}${r.fallback ? ` → used “${r.alt}”` : ''}.`);
    usedAlt.push(r.alt);
    return r.alt;
  };

  // Every picture of the article carries the website's logo (earlier tool): without a body template, a corner logo.
  const bodyTemplate = settings.body ?? (logo ? presetBodyCornerLogo(settings.featured.accent) : null);
  if (plan.featuredAsBody && plan.featuredPhotos[0]) {
    const p = plan.featuredPhotos[0];
    const src = p.buffer ?? (await readAsset(p.asset));
    const r = bodyTemplate ? await renderTemplate({ template: bodyTemplate, photos: [src], focus: [p.focus ?? null], logo, fixedPhotos, vars: { title, site: site.name, keyword: ctx.task.keyword } }, opts) : await renderCleanImage(src, opts, p.focus ?? null);
    const alt = altFor('FEATURED', plan.featuredAlt);
    const a = await storeRendered({ buffer: r.buffer, mime: r.mime, taskId: ctx.taskId, websiteId: site.id, role: 'FEATURED', altText: alt, slug: ctx.task.slug, sourceUrl: p.asset.sourceUrl ?? null });
    slots.push({ slot: 'FEATURED', mediaAssetId: a.id, alt, sourceAssetIds: [p.asset.id], width: r.width, height: r.height, bytes: r.buffer.length });
  } else if (plan.featuredPhotos.length || templatePhotoSlots(settings.featured) === 0) {
    let template = settings.featured;
    if (templatePhotoSlots(template) > plan.featuredPhotos.length && plan.featuredPhotos.length === 1) {
      // A two-photo design with one usable photo: never repeat a photo — use the single-photo preset.
      template = presetSingle(template.accent);
      notes.push(ctx.task.moduleKey === 'tigram-writer' ? 'The Tigram featured design has more than one picture place, but a Tigram article has one featured picture; the single-photo preset was used (Image Template → Tigram: use a one-picture design).' : 'Only one photo was available for the two-photo featured design; the single-photo preset was used.');
    }
    const photos = await Promise.all(plan.featuredPhotos.map((p) => p.buffer ?? readAsset(p.asset)));
    const r = await renderTemplate({ template, photos, focus: plan.featuredPhotos.map((p) => p.focus ?? null), logo, fixedPhotos, vars: { title, site: site.name, keyword: ctx.task.keyword } }, opts);
    const alt = altFor('FEATURED', plan.featuredAlt);
    const a = await storeRendered({ buffer: r.buffer, mime: r.mime, taskId: ctx.taskId, websiteId: site.id, role: 'FEATURED', altText: alt, slug: ctx.task.slug, sourceUrl: plan.featuredPhotos[0]?.asset.sourceUrl ?? null });
    slots.push({ slot: 'FEATURED', mediaAssetId: a.id, alt, sourceAssetIds: plan.featuredPhotos.map((p) => p.asset.id), width: r.width, height: r.height, bytes: r.buffer.length });
  }
  for (const [slotName, b] of [['BODY1', plan.body1], ['BODY2', plan.body2]] as const) {
    if (!b) continue;
    const src = b.buffer ?? (await readAsset(b.asset));
    const r = bodyTemplate ? await renderTemplate({ template: bodyTemplate, photos: [src], focus: [b.focus ?? null], logo, fixedPhotos, vars: { title, site: site.name, keyword: ctx.task.keyword } }, opts) : await renderCleanImage(src, opts, b.focus ?? null);
    const alt = altFor(slotName, b.alt);
    const a = await storeRendered({ buffer: r.buffer, mime: r.mime, taskId: ctx.taskId, websiteId: site.id, role: slotName, altText: alt, slug: ctx.task.slug, sourceUrl: b.asset.sourceUrl });
    slots.push({ slot: slotName, mediaAssetId: a.id, alt, sourceAssetIds: [b.asset.id], html: figure(slotName, { id: a.id, width: r.width, height: r.height }, alt), width: r.width, height: r.height, bytes: r.buffer.length });
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

/**
 * The image plan: the earlier tool's “IMAGE 1 PROMPT: … / IMAGE 1 ALT: …” lines (bold labels and bullets allowed),
 * and the “FEATURED: … | ALT: …” lines of an edited prompt.
 */
export function parseImagePlan(text: string): { slot: ImageSlotName; direction: string; alt: string }[] {
  const SLOTS: ImageSlotName[] = ['FEATURED', 'BODY1', 'BODY2'];
  const prompts: Partial<Record<ImageSlotName, string>> = {};
  const alts: Partial<Record<ImageSlotName, string>> = {};
  const clean = (v: string) => v.trim().replace(/^["“„'](.*)["“”']$/s, '$1');
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\*\*|__|`/g, '').replace(/^\s*[>*\-•]\s*/, '').trim();
    const old = /^image\s*(\d)\s*(prompt|alt(?:\s*text)?)\s*[:\-–]\s*(.+)$/i.exec(line);
    if (old) {
      const slot = SLOTS[Number(old[1]) - 1];
      if (!slot) continue;
      if (/^prompt/i.test(old[2])) prompts[slot] ??= clean(old[3]).slice(0, 1200);
      else alts[slot] ??= clean(old[3]).slice(0, 125);
      continue;
    }
    const m = /^(FEATURED|BODY\s*1|BODY\s*2)\s*:\s*(.+?)\s*\|\s*ALT\s*:\s*(.+)$/i.exec(line.replace(/^\d+[.)]\s*/, ''));
    if (!m) continue;
    const slot = m[1].toUpperCase().replace(/\s+/g, '') as ImageSlotName;
    prompts[slot] ??= m[2].trim().slice(0, 1200);
    alts[slot] ??= clean(m[3]).slice(0, 160);
  }
  return SLOTS.filter((slot) => prompts[slot]).map((slot) => ({ slot, direction: prompts[slot]!, alt: alts[slot] ?? '' }));
}

/** Short text for the featured picture: the title without its tail after “:” or “–”, at most ~45 characters of whole words (earlier tool). */
export function featuredImageTitle(title: string): string {
  const head = title.split(/\s[:–—|-]\s|:\s/)[0].trim();
  const text = head.length >= 8 ? head : title.trim();
  if (text.length <= 45) return text;
  const words: string[] = [];
  for (const word of text.split(/\s+/)) {
    if ([...words, word].join(' ').length > 45) break;
    words.push(word);
  }
  // Never end on a small linking word (“… Software Cost in”).
  while (words.length > 2 && /^(in|of|for|the|and|to|a|an|with|on|at|by|or|vs\.?|&|-|–|und|der|die|das|für|mit|von)$/i.test(words[words.length - 1])) words.pop();
  return words.join(' ') || text.slice(0, 45);
}

const NO_TEXT = 'No text, letters, words or numbers anywhere in the picture (the title is added later on top of it).';

/** The plan's featured description without what it says about written title text, then “no text” (featured design on). */
export function withoutTitleText(direction: string, fallback: string): string {
  const kept = direction
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !/\b(title|text|words?|letters?|lettering|typography|headline|caption|font|spelled)\b/i.test(s))
    .join(' ')
    .trim();
  return kept.length >= 30 ? `${kept} ${NO_TEXT}` : fallback;
}

/** The earlier tool's default descriptions, for a plan line ChatGPT did not give. */
function defaultImagePlan(keyword: string, imageTitle: string, featuredDesign = false): Record<ImageSlotName, { direction: string; alt: string }> {
  const body = (topic: string) => `A minimal flat illustration about ${topic}. Soft colours, plain light background, lots of empty space, only a few simple objects, no text, letters or numbers at all, no logos, no faces.`;
  return {
    FEATURED: featuredDesign
      ? { direction: `A clean, modern wide blog header picture about "${keyword}": a simple scene that fits the topic, strong contrast, calm space in the lower third. ${NO_TEXT} No logos, no watermark.`, alt: keyword }
      : { direction: `A clean, modern blog header image about "${keyword}". Large bold title text in the middle, spelled exactly: "${imageTitle}". Empty space above and below the text, simple background that fits the topic, strong contrast, no logos, no watermark, no other words.`, alt: keyword },
    BODY1: { direction: body(keyword), alt: `${keyword} illustration` },
    BODY2: { direction: body(`the main steps and tips of ${keyword}`), alt: `${keyword} guide illustration` },
  };
}

const sha = async (a: MediaAsset) => createHash('sha256').update(await readAsset(a)).digest('hex');

async function generalImages(ctx: PipelineContext): Promise<StageResult> {
  const notes: string[] = [];
  const imageTitle = featuredImageTitle((ctx.task.selectedTitle ?? ctx.task.seoTitle ?? ctx.task.keyword).trim());
  // Owner request: the Tigram featured design (Image Template → Tigram) takes the featured picture and writes the title
  // itself, so ChatGPT draws that picture without text.
  const site = await db.website.findUniqueOrThrow({ where: { id: ctx.task.websiteId }, select: { imageSettings: true } });
  const featuredDesign = templateSet(parseSiteImageSettings(site.imageSettings), templateSetFor(ctx.task.moduleKey)).useFeatured;
  const planRes = await ctx.askChatGPT('IMAGE_PLAN', { image_title: imageTitle });
  if (planRes.status === 'waiting') return waiting('Waiting for ChatGPT: image plan');
  const fallback = defaultImagePlan(ctx.task.keyword, imageTitle, featuredDesign);
  const parsed = parseImagePlan(planRes.text);
  const plan = (['FEATURED', 'BODY1', 'BODY2'] as const).map((slot) => {
    const p = parsed.find((x) => x.slot === slot);
    const direction = p?.direction ?? fallback[slot].direction;
    return { slot, direction: slot === 'FEATURED' && featuredDesign && p ? withoutTitleText(direction, fallback.FEATURED.direction) : direction, alt: p?.alt || fallback[slot].alt };
  });
  if (parsed.length < 3) notes.push(`The image plan had ${parsed.length} of 3 usable lines; the earlier tool's default description was used for the rest.`);
  // Owner uploads (Images tab) fill the slots first, in upload order; only the rest is generated.
  const uploads = await db.mediaAsset.findMany({ where: { taskId: ctx.taskId, role: 'UPLOAD', status: { not: 'REJECTED' } }, orderBy: { createdAt: 'asc' }, take: 3 });
  const owned = new Map<ImageSlotName, MediaAsset>((['FEATURED', 'BODY1', 'BODY2'] as const).slice(0, uploads.length).map((slot, i) => [slot, uploads[i]]));
  if (owned.size) notes.push(`${owned.size} of your uploaded image(s) used for ${[...owned.keys()].join(', ')}.`);
  // One picture at a time in the article's chat, as in the owner's earlier tool (owner report: three pictures at once
  // in three new chats ran in background tabs, where ChatGPT does not draw; two prompts became uncertain). Only a
  // second try goes to a new chat.
  const ask = (p: (typeof plan)[number], again = false) => ctx.askChatGPT('IMAGE_GENERATION', { image_brief: p.direction }, { part: again ? `${p.slot}-again` : p.slot, newChat: again, expectImages: true });
  const results: { p: (typeof plan)[number]; res: Awaited<ReturnType<typeof ask>> }[] = [];
  for (const p of plan.filter((x) => !owned.has(x.slot))) {
    const res = await ask(p);
    if (res.status === 'waiting') return waiting(`Waiting for ChatGPT: ${p.slot === 'FEATURED' ? 'the featured picture' : `body picture ${p.slot.slice(-1)}`}`);
    results.push({ p, res });
  }
  const byslot = new Map<ImageSlotName, { asset: MediaAsset; alt: string }>();
  for (const [slot, asset] of owned) byslot.set(slot, { asset, alt: plan.find((p) => p.slot === slot)?.alt ?? asset.altText ?? imageTitle });
  const seen = new Map<string, ImageSlotName>();
  for (const [slot, v] of byslot) seen.set(await sha(v.asset), slot);
  for (const { p, res } of results) {
    if (res.status !== 'completed') continue;
    const id = res.images[0]?.mediaAssetId;
    let asset = id ? await db.mediaAsset.findUnique({ where: { id } }) : null;
    let digest = asset ? await sha(asset) : null;
    // No picture, or an earlier picture handed back for a new prompt (the earlier tool saw this; identical files are
    // stored once, so a repeat arrives as no picture): asked once more in a new chat.
    if (!asset || seen.has(digest!)) {
      const why = asset ? `an earlier picture (${seen.get(digest!)})` : `no picture${res.text ? ` (“${res.text.slice(0, 80)}”)` : ''}`;
      const again = await ask(p, true);
      if (again.status === 'waiting') return waiting(`Waiting for ChatGPT: ${p.slot} again`);
      const id2 = again.status === 'completed' ? again.images[0]?.mediaAssetId : undefined;
      asset = id2 ? await db.mediaAsset.findUnique({ where: { id: id2 } }) : null;
      digest = asset ? await sha(asset) : null;
      if (!asset || seen.has(digest!)) {
        notes.push(`ChatGPT handed back ${why} for ${p.slot}, and again in a new chat; ${p.slot} was left out.`);
        continue;
      }
      notes.push(`ChatGPT handed back ${why} for ${p.slot}; it was asked once more in a new chat.`);
    }
    seen.set(digest!, p.slot);
    byslot.set(p.slot, { asset, alt: p.alt });
  }
  const featured = byslot.get('FEATURED');
  // Featured design on: the picture goes into the writer's featured design, which writes the title. Off: the picture
  // carries its own title (ChatGPT wrote it) and, like the body images, gets the website's logo.
  const slots = await renderAll(
    ctx,
    { featuredPhotos: featured ? [{ asset: featured.asset }] : [], featuredAlt: featured?.alt ?? imageTitle, featuredAsBody: !featuredDesign && !owned.has('FEATURED'), body1: byslot.get('BODY1'), body2: byslot.get('BODY2') },
    notes,
  );
  return finish(ctx, { slots, gallery: [...byslot.entries()].map(([slot, v]) => ({ id: v.asset.id, source: v.asset.role === 'UPLOAD' ? 'your upload' : 'ChatGPT image', sourceUrl: v.asset.sourceUrl, title: slot, used: true })), plan, notes, warnings: [] });
}

// ------------------------------------------------------------------ celebrity

/**
 * Reads the photo check (earlier tool's parser): lines like “2: watermark=yes | collage=no | alt=…”. Markdown, “Photo 2”,
 * any field order and German ja/nein are accepted; a description that calls the picture a collage counts as one.
 */
export function parsePhotoCheck(text: string, count: number): Map<number, { watermark: boolean; collage: boolean; alt: string }> {
  const out = new Map<number, { watermark: boolean; collage: boolean; alt: string }>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[*_`]/g, '').trim();
    const m = /^(?:photo|foto|bild)?\s*#?(\d{1,2})\s*[:.)\-–]\s*(.+)$/i.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (n < 1 || n > count || out.has(n)) continue;
    const alt = (/\balt\s*[=:]\s*(.+)$/i.exec(m[2])?.[1] ?? '').replace(/^["'“”„]+|["'“”]+$/g, '').replace(/[.。]+$/, '').trim().split(/\s+/).slice(0, 12).join(' ');
    const watermark = /(?:watermark|wasserzeichen)\s*[=:]\s*(yes|ja|true)\b/i.test(m[2]);
    const collage = /(?:collage|kollage)\s*[=:]\s*(yes|ja|true)\b/i.test(m[2]) || COLLAGE_WORDS.test(alt);
    if (!alt && !/(watermark|wasserzeichen|collage|kollage)\s*[=:]/i.test(m[2])) continue;
    out.set(n, { watermark, collage, alt });
  }
  return out;
}

/** A description that says the picture is several photos put together (earlier tool). */
const COLLAGE_WORDS = /\b(collage|kollage|side[-\s]by[-\s]side|split[-\s]screen|montage|photo grid)\b/i;

type Area = { left: number; right: number; top: number; bottom: number };
/** What was measured about a gallery photo (kept in the stage state, so a retry measures nothing again). */
type PhotoFacts = { n: number; h: number; area: Area | null; faceprint?: string; sharpness: number; faces?: Area[]; aspect?: number };

/**
 * Whether a photo's main faces fit a place of this size whole (owner report: a group photo in the narrow half of the
 * featured design had the faces at both edges cut). Unknown faces count as fitting.
 */
export function fitsPlace(f: Pick<PhotoFacts, 'faces' | 'aspect'> | undefined, place: { width: number; height: number }): boolean {
  if (!f?.faces?.length || !f.aspect) return true;
  // The share of the photo's width a cover crop keeps; faces padded for hair and ears, as the crop does.
  const kept = Math.min(1, place.width / place.height / f.aspect);
  const left = Math.min(...f.faces.map((a) => a.left - (a.right - a.left) * 0.2));
  const right = Math.max(...f.faces.map((a) => a.right + (a.right - a.left) * 0.2));
  return right - left <= kept;
}

/**
 * One photo per place, in the order given: each place takes the first photo, or a photo just as good (same `tier`)
 * further down whose faces fit it whole. The others keep their order for the next places.
 */
export function photosForPlaces<T>(photos: T[], places: { width: number; height: number }[], fits: (photo: T, place: { width: number; height: number }) => boolean, tier: (photo: T) => string): { picked: T[]; rest: T[]; moved: number } {
  const rest = [...photos];
  const picked: T[] = [];
  let moved = 0;
  for (const place of places) {
    if (!rest.length) break;
    const i = rest.findIndex((p) => tier(p) === tier(rest[0]) && fits(p, place));
    if (i > 0) moved++;
    picked.push(...rest.splice(Math.max(0, i), 1));
  }
  return { picked, rest, moved };
}

/**
 * Owner request: in a featured design with two or more photos, each photo shows at most 2 people; when there are not
 * enough such photos, the limit goes up one person at a time (3, then 4 …), place by place. A single-photo featured
 * design takes any number. People = the main faces plus the people whose face was not found; unknown (no detector)
 * counts as fitting. Your uploads keep their places. The photos not picked keep their order for the body images.
 */
export function chooseFeatured<T>(
  photos: T[],
  places: { width: number; height: number }[],
  o: { fits: (photo: T, place: { width: number; height: number }) => boolean; tier: (photo: T) => string; people: (photo: T) => number | undefined; upload: (photo: T) => boolean },
): { picked: T[]; rest: T[]; moved: number; mostPeople: number; skippedGroups: number } {
  if (places.length < 2) {
    const r = photosForPlaces(photos, places, o.fits, o.tier);
    return { ...r, mostPeople: 0, skippedGroups: 0 };
  }
  const limit = (p: T) => (o.upload(p) ? 0 : Math.max(2, o.people(p) ?? 0));
  const ordered = photos.map((p, i) => ({ p, i })).sort((a, b) => limit(a.p) - limit(b.p) || a.i - b.i).map((x) => x.p);
  const r = photosForPlaces(ordered, places, o.fits, o.tier);
  const picked = new Set(r.picked);
  const mostPeople = Math.max(0, ...r.picked.filter((p) => !o.upload(p)).map((p) => o.people(p) ?? 0));
  // Photos with more people than the featured photos, skipped although they came first.
  const firstPicked = Math.max(...r.picked.map((p) => photos.indexOf(p)));
  const skippedGroups = photos.slice(0, firstPicked).filter((p) => !picked.has(p) && (o.people(p) ?? 0) > Math.max(2, mostPeople)).length;
  return { picked: r.picked, rest: photos.filter((p) => !picked.has(p)), moved: r.moved, mostPeople, skippedGroups };
}

interface CelebState extends Record<string, unknown> {
  galleryIds?: string[];
  galleryNotes?: string[];
  /** Image searches that brought back no photo (the second one runs in a new chat, as in the owner's earlier tool). */
  emptySearches?: number;
  /** Per photo (asset id): main faces, the biggest face's height (px), the area around them, its fingerprint, sharpness. */
  facts?: Record<string, PhotoFacts>;
  faceTool?: boolean;
  /** Asked for photos once more because the featured design has more places than photos (owner decision). */
  moreSearched?: boolean;
}

/**
 * Measures the photos not measured yet (owner's earlier tool, images/choose.ts): sharpness always, face locations
 * with the local MediaPipe detector when it is installed (never who it is).
 */
async function measurePhotos(ctx: PipelineContext, photos: MediaAsset[], notes: string[]): Promise<{ facts: Record<string, PhotoFacts>; faceTool: boolean }> {
  const state = ctx.privateState<CelebState>();
  const facts = { ...(state.facts ?? {}) };
  const todo = photos.filter((p) => !facts[p.id]);
  let faceTool = state.faceTool ?? faceToolAvailable();
  if (todo.length) {
    await ctx.progress(`Measuring ${todo.length} photo(s)${faceTool ? ' and finding faces' : ''}…`);
    const bufs = await Promise.all(todo.map((p) => readAsset(p)));
    let boxes: Awaited<ReturnType<typeof detectSubjects>> = null;
    if (faceTool) {
      try {
        boxes = await detectSubjects(bufs);
      } catch (error) {
        notes.push(`Face detection failed; photos were ordered and cropped without it (${(error as Error).message.slice(0, 120)}).`);
      }
    }
    faceTool = faceTool && boxes !== null;
    for (const [i, p] of todo.entries()) {
      const meta = await sharp(bufs[i]).rotate().metadata();
      const found = boxes?.[i]?.faces ?? [];
      const main = mainFaces(found);
      // People whose face was not found count for the crop too (where they stand, never who they are).
      const heads = headsOfPeople(boxes?.[i]?.people ?? [], found);
      const W = meta.width ?? 0;
      const H = meta.height ?? 0;
      const subjects = [...main, ...heads];
      const area = heads.length && W && H ? { left: Math.max(0, Math.min(...subjects.map((f) => f.x)) / W), right: Math.min(1, Math.max(...subjects.map((f) => f.x + f.w)) / W), top: Math.max(0, Math.min(...subjects.map((f) => f.y)) / H), bottom: Math.min(1, Math.max(...subjects.map((f) => f.y + f.h)) / H) } : mainFaceArea(found, W, H);
      facts[p.id] = {
        n: main.length,
        h: main.length ? Math.max(...main.map((f) => f.h)) : 0,
        area,
        faces: W && H ? subjects.map((f) => ({ left: f.x / W, right: (f.x + f.w) / W, top: f.y / H, bottom: (f.y + f.h) / H })) : undefined,
        aspect: W && H ? W / H : undefined,
        faceprint: area ? await faceFingerprint(bufs[i], area).catch(() => undefined) : undefined,
        sharpness: await pictureSharpness(bufs[i]).catch(() => 0),
      };
    }
    await ctx.setPrivateState({ facts, faceTool });
  }
  if (!faceTool) notes.push('Face detector not installed (it is installed by npm run start:all, or npm run tools:install); photos were ordered and cropped without face positions.');
  return { facts, faceTool };
}

/** Pixel size of each photo place of a template (the largest layer of each slot), on the 1920×1080 canvas. */
function placeSizes(t: ImageTemplate | null): Record<number, { width: number; height: number }> {
  const out: Record<number, { width: number; height: number }> = {};
  for (const l of t?.layers ?? []) {
    if (l.type !== 'photo' || !l.visible) continue;
    const cur = out[l.slot];
    if (!cur || l.width * l.height > cur.width * cur.height) out[l.slot] = { width: l.width, height: l.height };
  }
  return out;
}

async function celebrityImages(ctx: PipelineContext): Promise<StageResult> {
  const settings = await getSettings();
  const notes: string[] = [];
  const quickBio = parseJson<{ attribute: string; details: string }[]>(ctx.task.quickBio, []);
  const { confirmedFullName } = await import('@/modules/celebrity-writer/parsers');
  const name = confirmedFullName(quickBio) ?? ctx.task.keyword;
  const state = ctx.privateState<CelebState>();
  const site = await db.website.findUniqueOrThrow({ where: { id: ctx.task.websiteId } });
  const siteSettings = templateSet(parseSiteImageSettings(site.imageSettings), 'celebrity');
  const featuredNeeds = Math.max(1, templatePhotoSlots(siteSettings.featured));
  /** The photo places of the article: the featured design's, and the two body images. */
  const places = featuredNeeds + 2;

  // 1. Gallery: owner uploads first, then the configured photo source (collected once per run):
  //    ChatGPT's image-search gallery (as in the owner's earlier tool) and/or a bounded Wikimedia Commons search.
  let galleryIds = state.galleryIds;
  if (!galleryIds) {
    const uploads = await db.mediaAsset.findMany({ where: { taskId: ctx.taskId, role: 'UPLOAD', status: { not: 'REJECTED' } }, orderBy: { createdAt: 'asc' } });
    const ids = uploads.map((u) => u.id);
    const galleryNotes: string[] = state.emptySearches ? [...((state.searchNotes as string[] | undefined) ?? [])] : [];
    // Owner request: the photos you upload are used as they are. When they fill every place, nothing else is
    // collected (no earlier photos, no image search); only when they are fewer does the gallery add more.
    const ownFill = uploads.length >= places;
    if (ownFill) galleryNotes.push(`${uploads.length} photo(s) you uploaded fill every place (featured ${featuredNeeds}, body 2): no image search.`);
    // Owner report (Regenerate images used only the new search's two photos, and no body image was made): the photos
    // collected for this article before are used again, unless removed on the Images tab; a new search only when they
    // are not enough.
    if (!state.emptySearches && !ownFill) {
      // Not the small thumbnails the gallery also saved (the search left them out too), and not the photos this run's
      // own search brought (they arrive while the stage waits for ChatGPT, and are collected below).
      const earlier = await db.mediaAsset.findMany({ where: { taskId: ctx.taskId, role: 'GALLERY', status: { not: 'REJECTED' }, width: { gte: GALLERY_MIN_SIDE }, height: { gte: GALLERY_MIN_SIDE }, createdAt: { lt: ctx.stage.startedAt ?? new Date() } }, orderBy: { createdAt: 'asc' }, take: 10 });
      if (earlier.length) {
        ids.push(...earlier.map((e) => e.id));
        galleryNotes.push(`${earlier.length} photo(s) collected before for this article are used again (“Don't use” on the Images tab leaves one out).`);
      }
    }
    const source = ctx.config.celebrityPhotoSource ?? 'chatgpt';
    const timeoutMs = settings.advanced.linkCheckTimeoutSec * 1000 * 2;
    // Without uploads at least 4 photos to choose from; with uploads, only what the places still need.
    const enough = uploads.length ? places : Math.max(4, places);
    if (uploads.length && !ownFill && !state.emptySearches) galleryNotes.push(`${uploads.length} photo(s) you uploaded for ${places} place(s): ${ids.length >= enough ? 'the photos collected before for this article add the rest' : 'an image search adds the rest'}.`);
    if (!ownFill && ids.length < enough && source !== 'commons') {
      // In the chat the article was written in (owner request: no new chat for the photos). No photo from that search
      // (ChatGPT answered with text only): once more in a new chat.
      for (let attempt = state.emptySearches ?? 0; attempt < 2; attempt++) {
        const res = await ctx.askChatGPT('IMAGE_SEARCH', { person_name: name }, { part: attempt ? 'gallery-2' : 'gallery', newChat: attempt > 0, expectGallery: true });
        if (res.status === 'waiting') return waiting(`Waiting for ChatGPT: photo gallery of ${name}${attempt ? ' (second try)' : ''}`);
        await ctx.progress(`Saving gallery photos of ${name}…`);
        const g = await collectChatGPTGallery({ uploadedIds: res.images.map((i) => i.mediaAssetId), links: res.imageLinks, taskId: ctx.taskId, websiteId: ctx.task.websiteId, responseId: res.responseId, max: 10 - ids.length, timeoutMs });
        ids.push(...g.assets.map((a) => a.id));
        galleryNotes.push(`ChatGPT image search${attempt ? ' (second try, new chat)' : ''}: ${g.assets.length} usable photo(s).`, ...g.notes.slice(0, 6));
        if (g.assets.length) break;
        if (attempt === 0) {
          galleryNotes.push(`ChatGPT showed no usable photo${res.text ? ` (“${res.text.replace(/\s+/g, ' ').slice(0, 120)}”)` : ''}; asked once more in a new chat.`);
          await ctx.setPrivateState({ emptySearches: 1, searchNotes: galleryNotes });
        }
      }
    }
    if (!ownFill && ids.length < enough && (source === 'commons' || (source === 'chatgpt-then-commons' && ids.length < 2))) {
      try {
        await ctx.progress(`Collecting photos of ${name}…`);
        const g = await collectCommonsGallery({ name, taskId: ctx.taskId, websiteId: ctx.task.websiteId, max: 6 - ids.length, timeoutMs });
        ids.push(...g.assets.map((a) => a.id));
        galleryNotes.push(...g.notes.slice(0, 6));
      } catch (error) {
        galleryNotes.push(`Wikimedia Commons unavailable: ${(error as Error).message}`);
      }
    }
    galleryIds = ids;
    await ctx.setPrivateState({ galleryIds, galleryNotes });
  }
  notes.push(...(ctx.privateState<CelebState>().galleryNotes ?? []));
  // Photos the owner removed on the Images tab are never used.
  let gallery = galleryIds.length ? await db.mediaAsset.findMany({ where: { id: { in: galleryIds }, status: { not: 'REJECTED' } } }) : [];
  gallery = galleryIds.map((id) => gallery.find((g) => g.id === id)).filter(Boolean) as MediaAsset[];
  // Near-duplicates across uploads and Commons (the bigger copy stays; of two uploads, the one uploaded first).
  // Owner report: your uploads go to the featured image, body 1 and body 2 in the order you uploaded them; sorting
  // them by size had put a bigger photo uploaded second into the featured image.
  const uploaded = (a: MediaAsset) => a.origin === 'UPLOADED';
  const uploadOrder = new Map(gallery.map((g, i) => [g.id, i]));
  const byUploadOrder = (a: MediaAsset, b: MediaAsset) => (uploadOrder.get(a.id) ?? 0) - (uploadOrder.get(b.id) ?? 0);
  const distinct: MediaAsset[] = [];
  for (const g of [...gallery].sort((a, b) => Number(uploaded(b)) - Number(uploaded(a)) || (uploaded(a) && uploaded(b) ? byUploadOrder(a, b) : (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0)))) {
    if (g.phash && distinct.some((d) => d.phash && hammingDistance(d.phash, g.phash!) <= 6)) notes.push('A near-duplicate photo was skipped.');
    else distinct.push(g);
  }
  if (!distinct.length) {
    notes.push(`No usable photo of ${name} was found.`);
    return finish(ctx, { slots: [], gallery: gallery.map((g) => ({ id: g.id, source: sourceLabel(g.origin), sourceUrl: g.sourceUrl, title: g.notes ?? '', used: false })), notes, warnings: [] });
  }

  // 2. As in the owner's earlier tool (images/choose.ts): a cropped copy (the same faces in the same moment) counts
  //    once; photos with a clear face first, the biggest face first, soft photos last. Your uploads stay first, in
  //    the order you uploaded them.
  const { facts } = await measurePhotos(ctx, distinct, notes);
  let usable: MediaAsset[] = [];
  let crops = 0;
  for (const a of distinct) {
    const f = facts[a.id];
    const limit = (f?.n ?? 0) >= 2 ? SAME_FACES_BITS.several : SAME_FACES_BITS.one;
    const twin = f?.faceprint && usable.some((k) => facts[k.id]?.faceprint && facts[k.id].n === f.n && fingerprintDistance(facts[k.id].faceprint!, f.faceprint!) <= limit);
    if (twin) crops++;
    else usable.push(a);
  }
  if (crops) notes.push(`${crops} photo(s) left out as cropped copies of another one (the same faces in the same moment).`);
  const levels = usable.map((a) => facts[a.id]?.sharpness ?? 0).sort((x, y) => x - y);
  const middle = levels[Math.floor(levels.length / 2)] ?? 0;
  const soft = (a: MediaAsset) => usable.length >= 3 && (facts[a.id]?.sharpness ?? 0) < middle * SOFT_SHARE;
  const rank = (a: MediaAsset) => (a.origin === 'UPLOADED' ? -1 : (facts[a.id]?.n ? 0 : 2) + (soft(a) ? 1 : 0));
  const facePixels = (a: MediaAsset) => facts[a.id]?.h ?? 0;
  usable = [...usable].sort((x, y) => rank(x) - rank(y) || (uploaded(x) && uploaded(y) ? byUploadOrder(x, y) : facePixels(y) - facePixels(x) || (y.width ?? 0) * (y.height ?? 0) - (x.width ?? 0) * (x.height ?? 0)));
  const withFace = usable.filter((a) => facts[a.id]?.n).length;
  const softCount = usable.filter(soft).length;
  notes.push(`Photos ordered: ${usable.length} different${withFace ? `, ${withFace} with a face` : ''}${softCount ? `, ${softCount} soft (used last)` : ''}.`);

  // 3. Photo check through ChatGPT (as in the earlier tool, on by default): photos with a watermark or site name, then
  //    other sites' collages, go last; a collage never becomes a body image. Each photo gets its alt text. Never
  //    identifies anyone. Like the earlier tool, a check that cannot be done never stops the images.
  const alts = new Map<string, string>();
  const collages = new Set<string>();
  const flag = new Map<string, number>();
  // Your uploads are never checked (nor demoted): only the photos the search or Commons brought.
  const checkable = usable.filter((a) => a.origin !== 'UPLOADED');
  if (ctx.config.celebrityPhotoReview && checkable.length) {
    const sample = checkable.slice(0, 8);
    let res: Awaited<ReturnType<PipelineContext['askChatGPT']>> | null = null;
    try {
      // In the article's chat too (owner request), right after the photo search.
      res = await ctx.askChatGPT('PHOTO_CHECK', { photo_count: String(sample.length) }, { part: state.moreSearched ? 'check-2' : 'check', attachments: sample.map((a, i) => ({ mediaAssetId: a.id, name: `photo-${i + 1}.webp`, mime: a.mime ?? 'image/webp' })) });
    } catch (error) {
      if (!(error instanceof TransientError || error instanceof UncertainSideEffectError)) throw error;
      notes.push(`Photo check skipped (${(error as Error).message.slice(0, 160)}); collages could not be recognised, the photos were used in their order.`);
    }
    if (res?.status === 'waiting') return waiting('Waiting for ChatGPT: photo check');
    const verdicts = res?.status === 'completed' ? parsePhotoCheck(res.text, sample.length) : new Map<number, { watermark: boolean; collage: boolean; alt: string }>();
    sample.forEach((a, i) => {
      const v = verdicts.get(i + 1);
      if (v?.alt) alts.set(a.id, v.alt);
      if (v?.collage) collages.add(a.id);
      flag.set(a.id, collages.has(a.id) ? 2 : v?.watermark ? 1 : 0);
    });
    usable = usable.map((a, i) => ({ a, i })).sort((x, y) => (flag.get(x.a.id) ?? 0) - (flag.get(y.a.id) ?? 0) || x.i - y.i).map((x) => x.a);
    const marked = [...flag.values()].filter((v) => v === 1).length;
    if (res) notes.push(verdicts.size ? `Photo check: ${verdicts.size} of ${sample.length} described${marked ? `, ${marked} with a watermark or site name (used last)` : ''}${collages.size ? `, ${collages.size} collage(s) of other sites (left out)` : ''}.` : 'The photo check answer could not be read; the photos were used in their order.');
  }

  // 4. Your featured template takes its photos first (as in the earlier tool); the body images get the rest. Another
  //    site's collage is never used while there is a single photo (owner report: a designed thumbnail with a circle
  //    became half of the featured image); with only collages the featured image takes one. A photo is never used
  //    twice: a small gallery leaves body images out instead of repeating one.
  const single = usable.filter((a) => !collages.has(a.id));
  // Owner report: with one photo, the two-photo featured design became the built-in single-photo design. Owner
  // decision: before that, ChatGPT is asked for photos once more, in a new chat (the photos found so far stay).
  if (featuredNeeds >= 2 && single.length < featuredNeeds && !state.moreSearched && (ctx.config.celebrityPhotoSource ?? 'chatgpt') !== 'commons' && galleryIds.length < 10) {
    const res = await ctx.askChatGPT('IMAGE_SEARCH', { person_name: name }, { part: 'gallery-more', newChat: true, expectGallery: true });
    if (res.status === 'waiting') return waiting(`Waiting for ChatGPT: more photos of ${name} for the ${featuredNeeds}-photo featured design`);
    await ctx.progress(`Saving gallery photos of ${name}…`);
    const g = await collectChatGPTGallery({ uploadedIds: res.images.map((i) => i.mediaAssetId), links: res.imageLinks, taskId: ctx.taskId, websiteId: ctx.task.websiteId, responseId: res.responseId, max: 10 - galleryIds.length, timeoutMs: settings.advanced.linkCheckTimeoutSec * 1000 * 2 });
    const galleryNotes = [...(ctx.privateState<CelebState>().galleryNotes ?? []), `Only ${single.length} photo(s) for the ${featuredNeeds}-photo featured design: ChatGPT image search once more (new chat): ${g.assets.length} usable photo(s).`, ...g.notes.slice(0, 6)];
    await ctx.setPrivateState({ galleryIds: [...galleryIds, ...g.assets.map((a) => a.id)], galleryNotes, moreSearched: true });
    return celebrityImages(ctx);
  }
  const featuredPlaces = placeSizes(siteSettings.featured);
  const bodyPlace = placeSizes(siteSettings.body)[0] ?? { width: CANVAS.width, height: CANVAS.height };
  // Owner report (a group photo in the narrow half of the featured design had the faces at both edges cut): each place
  // takes, of the photos just as good as the next one, one whose faces fit it whole; a wide group photo moves on to a
  // wider place (the body image). Your uploads keep their places.
  const tier = (a: MediaAsset) => `${flag.get(a.id) ?? 0}:${rank(a)}`;
  const fits = (a: MediaAsset, place: { width: number; height: number }) => a.origin === 'UPLOADED' || fitsPlace(facts[a.id], place);
  const featuredSlots = Array.from({ length: featuredNeeds }, (_, i) => featuredPlaces[i] ?? featuredPlaces[0] ?? { width: CANVAS.width, height: CANVAS.height });
  const people = (a: MediaAsset) => facts[a.id]?.faces?.length;
  const forFeatured = single.length ? chooseFeatured(single, featuredSlots, { fits, tier, people, upload: (a) => a.origin === 'UPLOADED' }) : { picked: usable.slice(0, 1), rest: [], moved: 0, mostPeople: 0, skippedGroups: 0 };
  const featuredPhotos = forFeatured.picked;
  if (!single.length && featuredPhotos.length) notes.push('Every photo found is a collage of another site; the featured image uses one of them. Upload photos on the Images tab to replace it.');
  if (featuredSlots.length >= 2 && forFeatured.mostPeople > 2) notes.push(`Not enough photos with at most 2 people for the ${featuredSlots.length}-photo featured design; it uses one with ${forFeatured.mostPeople} people.`);
  if (forFeatured.skippedGroups) notes.push(`The ${featuredSlots.length}-photo featured design uses photos with at most ${Math.max(2, forFeatured.mostPeople)} people; ${forFeatured.skippedGroups} photo(s) with more people went to the body images.`);
  const forBody = photosForPlaces(forFeatured.rest, [bodyPlace, bodyPlace], fits, tier);
  const rest = [...forBody.picked, ...forBody.rest];
  if (forFeatured.moved + forBody.moved) notes.push(`${forFeatured.moved + forBody.moved} photo(s) chosen for a place their faces fit whole; a group photo too wide for its place was used further down.`);
  if (rest.length < 2) notes.push(`${usable.length} usable photo(s): the featured design took ${featuredPhotos.length}, ${rest.length} left for the body image(s); none is used twice.`);
  // The earlier tool's alt text: the name, then what the photo shows.
  const properName = name === name.toLowerCase() ? name.replace(/(^|[\s-])(\p{L})/gu, (_m, gap: string, letter: string) => gap + letter.toUpperCase()) : name;
  const alt = (a: MediaAsset, fallback: string) => (alts.get(a.id) ? `${properName} – ${alts.get(a.id)}`.slice(0, 125) : fallback);
  const lang = ctx.task.language;
  const enhance = settings.seo.enhanceCelebrityImages;
  const focusOf = (a: MediaAsset): PhotoFocus => {
    const area = facts[a.id]?.area;
    return area ? { x: (area.left + area.right) / 2, y: (area.top + area.bottom) / 2, area, faces: facts[a.id]?.faces } : null;
  };
  // A photo its place would stretch, or a soft one, is enhanced first (Upscayl remacri-4x, when installed and on).
  const prep = async (a: MediaAsset, place: { width: number; height: number }) => {
    if (!enhance) return { asset: a, focus: focusOf(a) };
    const r = await enhancePhoto(await readAsset(a), place, soft(a));
    if (r.note && !notes.includes(r.note)) notes.push(r.note);
    return { asset: a, focus: focusOf(a), buffer: r.buffer ?? undefined };
  };
  const slots = await renderAll(
    ctx,
    {
      featuredPhotos: await Promise.all(featuredPhotos.map((a, i) => prep(a, featuredPlaces[i] ?? featuredPlaces[0] ?? { width: CANVAS.width, height: CANVAS.height }))),
      featuredAlt: alts.get(featuredPhotos[0]?.id ?? '') ? alt(featuredPhotos[0], '') : (ctx.task.selectedTitle ?? ctx.task.keyword),
      body1: rest[0] ? { ...(await prep(rest[0], bodyPlace)), alt: alt(rest[0], lang === 'de' ? `Foto von ${name}` : `Photo of ${name}`) } : undefined,
      body2: rest[1] ? { ...(await prep(rest[1], bodyPlace)), alt: alt(rest[1], lang === 'de' ? `Weiteres Foto von ${name}` : `Another photo of ${name}`) } : undefined,
    },
    notes,
  );
  const used = new Set(slots.flatMap((s) => s.sourceAssetIds));
  return finish(ctx, { slots, gallery: gallery.map((g) => ({ id: g.id, source: sourceLabel(g.origin), sourceUrl: g.sourceUrl, title: g.notes ?? '', used: used.has(g.id) })), notes, warnings: [] });
}

function sourceLabel(origin: string): string {
  return origin === 'UPLOADED' ? 'your upload' : origin === 'WIKIMEDIA' ? 'Wikimedia Commons' : origin === 'CHATGPT' ? 'ChatGPT image search' : origin;
}

export function imagesStage(manifest: StageManifest): PipelineStage {
  return bind(manifest, {
    shouldRun: (ctx) => ctx.config.images,
    run: (ctx) => (ctx.task.moduleKey === 'tigram-writer' ? generalImages(ctx) : celebrityImages(ctx)),
  });
}
