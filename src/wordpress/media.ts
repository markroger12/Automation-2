import fs from 'node:fs';
import { load } from 'cheerio';
import type { MediaAsset } from '@prisma/client';
import { db } from '@/lib/db';
import { fromDataRelative } from '@/lib/paths';
import { LoginRequiredError } from '@/lib/pipeline-errors';
import type { WpClient } from './client';

/** German letters as WordPress writes them in German file names and slugs (ä → ae, ö → oe, ü → ue, ß → ss). */
const GERMAN: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss' };

/**
 * The article's keyword as an image file name (owner request 2026-11-07: “image ka name keyword hi hona chahiye:
 * example-keyword.png”): lower case, words joined by “-”, accents removed (German umlauts as ae/oe/ue). Null when
 * nothing usable is left (a keyword in another script).
 */
export function keywordFileStem(keyword: string, language = 'en'): string | null {
  const text = language === 'de' ? keyword.replace(/[äöüÄÖÜß]/g, (c) => GERMAN[c]) : keyword;
  const stem = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return stem || null;
}

/** How an article's image is named: its keyword, and its place (1: the featured image; 2, 3 …: the article's images in order). */
export interface UploadNaming {
  keyword: string;
  language: string;
  index: number;
}

/**
 * The name an image is uploaded under, and the attachment slug it is given.
 * - With the article's keyword: `example-keyword.webp` for the featured image, `example-keyword-2.webp`,
 *   `example-keyword-3.webp` … for the images in the article (WordPress adds “-1” itself when the file exists).
 * - Without it: the local file name plus a tag from the asset ID.
 * The slug always ends with the tag and is sent with the upload, so it is known before uploading: an upload whose
 * answer was lost is found again by it instead of being uploaded a second time.
 */
export function wpUploadName(asset: Pick<MediaAsset, 'id' | 'filePath' | 'mime'>, naming?: UploadNaming | null): { filename: string; slug: string } {
  const base = asset.filePath.split('/').pop() ?? 'image';
  const ext = (/\.([a-z0-9]+)$/i.exec(base)?.[1] ?? (asset.mime === 'image/jpeg' ? 'jpg' : asset.mime === 'image/png' ? 'png' : 'webp')).toLowerCase();
  const tag = asset.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10);
  const keyword = naming ? keywordFileStem(naming.keyword, naming.language) : null;
  if (keyword) {
    const name = naming && naming.index > 1 ? `${keyword}-${naming.index}` : keyword;
    return { filename: `${name}.${ext}`, slug: `${keyword}-${tag}` };
  }
  const stem =
    base
      .replace(/\.[a-z0-9]+$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'image';
  const slug = `${stem}-${tag}`;
  return { filename: `${slug}.${ext}`, slug };
}

export type UploadHow = 'reused' | 'adopted' | 'uploaded';

/**
 * Upload one asset to the Media Library at most once:
 * - a stored media ID that still exists is reused;
 * - if an earlier upload got no answer (`uploadStartedAt` still set), the
 *   library is searched for the upload's slug and a hit is adopted;
 * - otherwise the file is uploaded and its ID stored.
 * Missing alt text on the WordPress item is filled in; existing alt text there is left alone.
 */
export interface UploadOptions {
  altText?: string | null;
  title?: string | null;
  /** Name the file after the article's keyword (else: the local file name). */
  naming?: UploadNaming | null;
}

export async function uploadAssetOnce(client: WpClient, asset: MediaAsset, opts: UploadOptions = {}): Promise<{ id: number; url: string; how: UploadHow }> {
  const alt = (opts.altText ?? asset.altText ?? '').trim() || null;
  const fillAlt = async (item: { id: number; alt_text: string }) => {
    if (alt && !(item.alt_text ?? '').trim()) await client.updateMediaAlt(item.id, alt).catch(() => {});
  };
  if (asset.wpMediaId) {
    const existing = await client.getMedia(asset.wpMediaId);
    if (existing) {
      await fillAlt(existing);
      return { id: existing.id, url: existing.source_url, how: 'reused' };
    }
  }
  const { filename, slug } = wpUploadName(asset, opts.naming);
  if (asset.uploadStartedAt) {
    // An upload started before the keyword names (or without the keyword) has the older slug.
    const older = wpUploadName(asset).slug;
    let found = await client.findMediaBySlug(slug);
    if (!found && older !== slug) found = await client.findMediaBySlug(older);
    if (found) {
      await fillAlt(found);
      await db.mediaAsset.update({ where: { id: asset.id }, data: { wpMediaId: found.id, wpUrl: found.source_url, status: 'UPLOADED', uploadStartedAt: null } });
      return { id: found.id, url: found.source_url, how: 'adopted' };
    }
  }
  const bytes = await fs.promises.readFile(fromDataRelative(asset.filePath));
  await db.mediaAsset.update({ where: { id: asset.id }, data: { uploadStartedAt: new Date() } });
  const res = await client.uploadMedia({ bytes, filename, slug, mime: asset.mime ?? 'image/webp', altText: alt, title: opts.title ?? null });
  await db.mediaAsset.update({ where: { id: asset.id }, data: { wpMediaId: res.id, wpUrl: res.url, status: 'UPLOADED', uploadStartedAt: null } });
  return { id: res.id, url: res.url, how: 'uploaded' };
}

/** One immediate second attempt; it re-reads the asset, so an upload that landed without an answer is adopted. */
export async function uploadAssetWithRetry(client: WpClient, asset: MediaAsset, opts: UploadOptions = {}) {
  try {
    return await uploadAssetOnce(client, asset, opts);
  } catch (first) {
    if (first instanceof LoginRequiredError) throw first;
    const fresh = await db.mediaAsset.findUnique({ where: { id: asset.id } });
    if (!fresh) throw first;
    await new Promise((r) => setTimeout(r, 1500));
    return uploadAssetOnce(client, fresh, opts);
  }
}

/**
 * Body images live in the article as local previews
 * (`<img src="/api/media/ID" data-bas-media="ID">`). Before saving to
 * WordPress each one is uploaded to the Media Library ONCE (see
 * uploadAssetOnce) and the tag is rewritten to the WordPress URL with the
 * `wp-image-N` class the editors expect. An image that cannot be uploaded is
 * left out of the draft with a warning; the article itself still saves.
 */
export async function prepareArticleMedia(client: WpClient, html: string, taskId: string): Promise<{ html: string; uploaded: number; reused: number; adopted: number; failed: number; warnings: string[] }> {
  const $ = load(`<body>${html}</body>`);
  const warnings: string[] = [];
  const counts = { uploaded: 0, reused: 0, adopted: 0, failed: 0 };
  // New uploads are named after the keyword: the featured image is 1, the article's images 2, 3 … in their order
  // (1, 2 … when the article has no featured image).
  const task = await db.articleTask.findUnique({ where: { id: taskId }, select: { keyword: true, language: true } });
  const hasFeatured = (await db.mediaAsset.count({ where: { taskId, role: 'FEATURED', status: { in: ['READY', 'UPLOADED'] } } })) > 0;
  let index = hasFeatured ? 1 : 0;
  for (const el of $('img[data-bas-media]').toArray()) {
    const img = $(el);
    const id = img.attr('data-bas-media')!;
    const asset = await db.mediaAsset.findUnique({ where: { id } });
    const figure = img.closest('figure').length ? img.closest('figure') : img;
    if (!asset || asset.taskId !== taskId) {
      warnings.push(`An image in the article is no longer available (${id}); it was left out of the draft.`);
      figure.remove();
      continue;
    }
    // The alt text in the article wins (the owner may have edited it); the stored one fills an empty attribute.
    const alt = (img.attr('alt') ?? '').trim() || asset.altText || '';
    if (alt) img.attr('alt', alt);
    const place = asset.role === 'FEATURED' ? 1 : ++index;
    try {
      const r = await uploadAssetWithRetry(client, asset, { altText: alt || null, naming: task ? { keyword: task.keyword, language: task.language, index: place } : null });
      counts[r.how]++;
      img.attr('src', r.url);
      img.attr('class', `wp-image-${r.id}`);
      img.attr('data-wp-id', String(r.id));
      img.removeAttr('loading');
    } catch (error) {
      if (error instanceof LoginRequiredError) throw error;
      counts.failed++;
      warnings.push(`Image “${alt || id}” could not be uploaded (${(error as Error).message}); it was left out of the draft.`);
      figure.remove();
    }
  }
  return { html: $('body').html() ?? html, ...counts, warnings };
}
