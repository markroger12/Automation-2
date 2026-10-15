import fs from 'node:fs';
import { load } from 'cheerio';
import type { MediaAsset } from '@prisma/client';
import { db } from '@/lib/db';
import { fromDataRelative } from '@/lib/paths';
import { LoginRequiredError } from '@/lib/pipeline-errors';
import type { WpClient } from './client';

/**
 * The name a rendered image is uploaded under: its local file name plus a
 * tag from the asset ID. WordPress turns the name into the attachment slug,
 * so the slug is known before uploading and an upload whose answer was lost
 * can be found again instead of being uploaded a second time.
 */
export function wpUploadName(asset: Pick<MediaAsset, 'id' | 'filePath' | 'mime'>): { filename: string; slug: string } {
  const base = asset.filePath.split('/').pop() ?? 'image';
  const ext = (/\.([a-z0-9]+)$/i.exec(base)?.[1] ?? (asset.mime === 'image/jpeg' ? 'jpg' : 'webp')).toLowerCase();
  const stem =
    base
      .replace(/\.[a-z0-9]+$/i, '')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'image';
  const tag = asset.id.toLowerCase().replace(/[^a-z0-9]/g, '').slice(-10);
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
export async function uploadAssetOnce(client: WpClient, asset: MediaAsset, opts: { altText?: string | null; title?: string | null } = {}): Promise<{ id: number; url: string; how: UploadHow }> {
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
  const { filename, slug } = wpUploadName(asset);
  if (asset.uploadStartedAt) {
    const found = await client.findMediaBySlug(slug);
    if (found) {
      await fillAlt(found);
      await db.mediaAsset.update({ where: { id: asset.id }, data: { wpMediaId: found.id, wpUrl: found.source_url, status: 'UPLOADED', uploadStartedAt: null } });
      return { id: found.id, url: found.source_url, how: 'adopted' };
    }
  }
  const bytes = await fs.promises.readFile(fromDataRelative(asset.filePath));
  await db.mediaAsset.update({ where: { id: asset.id }, data: { uploadStartedAt: new Date() } });
  const res = await client.uploadMedia({ bytes, filename, mime: asset.mime ?? 'image/webp', altText: alt, title: opts.title ?? null });
  await db.mediaAsset.update({ where: { id: asset.id }, data: { wpMediaId: res.id, wpUrl: res.url, status: 'UPLOADED', uploadStartedAt: null } });
  return { id: res.id, url: res.url, how: 'uploaded' };
}

/** One immediate second attempt; it re-reads the asset, so an upload that landed without an answer is adopted. */
export async function uploadAssetWithRetry(client: WpClient, asset: MediaAsset, opts: { altText?: string | null; title?: string | null } = {}) {
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
    try {
      const r = await uploadAssetWithRetry(client, asset, { altText: alt || null });
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
