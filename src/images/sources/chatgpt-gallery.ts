import type { MediaAsset } from '@prisma/client';
import { db } from '@/lib/db';
import { safeFetch } from '@/lib/links/net';
import { hammingDistance, MAX_IMAGE_BYTES, storeImage } from '../store';

/**
 * Celebrity photos from ChatGPT's image-search gallery (as in the owner's earlier tool): the IMAGE_SEARCH prompt asks
 * ChatGPT to search the web and show a picture gallery; the extension saves the pictures it can read in the page and
 * reports the rest as links, which are downloaded here through the SSRF-safe fetcher (12 MB cap, images only).
 * Pictures smaller than MIN_SIDE on their short side, exact duplicates and near-duplicates are skipped; the rest are
 * ordered largest first. No image-rights checks (owner decision); the source URL is kept for reference only.
 */

export const GALLERY_MIN_SIDE = 250;

export interface GalleryLink {
  url: string;
  width?: number;
  height?: number;
}

export interface ChatGPTGalleryResult {
  assets: MediaAsset[];
  notes: string[];
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

export async function collectChatGPTGallery(input: {
  /** Pictures the extension already uploaded for the image-search answer. */
  uploadedIds: string[];
  links: GalleryLink[];
  taskId: string;
  websiteId: string;
  responseId: string | null;
  max: number;
  timeoutMs: number;
  nearDuplicateDistance?: number;
}): Promise<ChatGPTGalleryResult> {
  const notes: string[] = [];
  const candidates: MediaAsset[] = input.uploadedIds.length ? await db.mediaAsset.findMany({ where: { id: { in: input.uploadedIds } } }) : [];
  const seenUrls = new Set(candidates.map((c) => c.sourceUrl).filter(Boolean) as string[]);
  let downloaded = 0;
  for (const link of input.links.slice(0, 12)) {
    if (seenUrls.has(link.url)) continue;
    seenUrls.add(link.url);
    try {
      const res = await safeFetch(link.url, { timeoutMs: input.timeoutMs, maxBytes: MAX_IMAGE_BYTES, userAgent: UA, accept: 'image/*' });
      if (res.status !== 200) {
        notes.push(`Picture link skipped (${hostOf(link.url)}): HTTP ${res.status}.`);
        continue;
      }
      const { asset } = await storeImage({ buffer: res.buffer, taskId: input.taskId, websiteId: input.websiteId, role: 'GALLERY', origin: 'CHATGPT', sourceUrl: link.url, responseId: input.responseId, notes: `gallery link: ${hostOf(link.url)}` });
      candidates.push(asset);
      downloaded++;
    } catch (error) {
      notes.push(`Picture link skipped (${hostOf(link.url)}): ${(error as Error).message.split('\n')[0]}`);
    }
  }
  if (downloaded) notes.push(`${downloaded} gallery picture(s) downloaded from their links.`);

  const assets: MediaAsset[] = [];
  const seenIds = new Set<string>();
  const received = candidates.length;
  let small = 0;
  let twins = 0;
  // Largest first: the gallery's thumbnails and full-size pictures of the same photo collapse to the bigger one.
  const ordered = [...candidates].sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
  for (const a of ordered) {
    if (seenIds.has(a.id) || a.status === 'REJECTED') continue;
    seenIds.add(a.id);
    if (Math.min(a.width ?? 0, a.height ?? 0) < GALLERY_MIN_SIDE) {
      small++;
      continue;
    }
    if (a.phash && assets.some((x) => x.phash && hammingDistance(x.phash, a.phash!) <= (input.nearDuplicateDistance ?? 6))) {
      twins++;
      continue;
    }
    assets.push(a);
    if (assets.length >= input.max) break;
  }
  // Owner report (ChatGPT showed about 6 photos, 2 were used): what came in and why the others were left out, before
  // the notes on links.
  const why = [`${received} gallery picture(s) received (${input.uploadedIds.length} saved by Automation Chrome, ${input.links.length} link(s)).`];
  if (small) why.push(`${small} gallery picture(s) smaller than ${GALLERY_MIN_SIDE} px were skipped (mostly the small thumbnails of the large ones).`);
  if (twins) why.push(`${twins} near-duplicate gallery picture(s) skipped (the same photo again; the larger copy is used).`);
  return { assets, notes: [...why, ...notes] };
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid URL';
  }
}
