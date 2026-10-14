import fs from 'node:fs';
import { load } from 'cheerio';
import { db } from '@/lib/db';
import { fromDataRelative } from '@/lib/paths';
import type { WpClient } from './client';

/**
 * Body images live in the article as local previews
 * (`<img src="/api/media/ID" data-bas-media="ID">`). Before saving to
 * WordPress each one is uploaded to the Media Library ONCE (the media ID is
 * persisted, so retries reuse it) and the tag is rewritten to the WordPress
 * URL with the `wp-image-N` class the editors expect.
 */
export async function prepareArticleMedia(client: WpClient, html: string, taskId: string): Promise<{ html: string; uploaded: number; reused: number; warnings: string[] }> {
  const $ = load(`<body>${html}</body>`);
  const warnings: string[] = [];
  let uploaded = 0;
  let reused = 0;
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
    let wpId = asset.wpMediaId;
    let wpUrl = asset.wpUrl;
    if (wpId && !(await client.getMedia(wpId))) {
      wpId = null;
      wpUrl = null;
    }
    if (wpId && wpUrl) reused++;
    else {
      try {
        const bytes = await fs.promises.readFile(fromDataRelative(asset.filePath));
        const name = asset.filePath.split('/').pop() ?? `${id}.webp`;
        const res = await client.uploadMedia({ bytes, filename: name, mime: asset.mime ?? 'image/webp', altText: asset.altText ?? img.attr('alt') ?? null });
        wpId = res.id;
        wpUrl = res.url;
        await db.mediaAsset.update({ where: { id }, data: { wpMediaId: wpId, wpUrl, status: 'UPLOADED' } });
        uploaded++;
      } catch (error) {
        warnings.push(`Image “${asset.altText ?? id}” could not be uploaded (${(error as Error).message}); it was left out of the draft.`);
        figure.remove();
        continue;
      }
    }
    img.attr('src', wpUrl!);
    img.attr('class', `wp-image-${wpId}`);
    img.attr('data-wp-id', String(wpId));
    img.removeAttr('loading');
  }
  return { html: $('body').html() ?? html, uploaded, reused, warnings };
}
