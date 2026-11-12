import { db } from '@/lib/db';
import { audit } from '@/lib/audit';
import { AppError, badRequest, notFound } from '@/lib/errors';
import { storeImage } from '@/images/store';

/**
 * Owner images for one article: uploads (used before any searched or
 * generated image on the next Images run) and removing a source photo so the
 * pipeline never uses it. Files are kept on disk; nothing is deleted.
 */
export const MAX_OWNER_UPLOADS = 8;

export async function addOwnerImages(taskId: string, files: { name: string; bytes: Buffer }[]) {
  const task = await db.articleTask.findUnique({ where: { id: taskId } });
  if (!task) throw notFound('Article');
  if (!files.length) throw badRequest('Choose at least one image.');
  const existing = await db.mediaAsset.count({ where: { taskId, role: 'UPLOAD', status: { not: 'REJECTED' } } });
  if (existing + files.length > MAX_OWNER_UPLOADS) throw badRequest(`An article can hold at most ${MAX_OWNER_UPLOADS} uploaded photos (${existing} already).`);
  const added: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    try {
      const { asset, duplicate } = await storeImage({ buffer: f.bytes, taskId, websiteId: task.websiteId, role: 'UPLOAD', origin: 'UPLOADED', notes: f.name.slice(0, 180) });
      if (duplicate) {
        // Re-uploading a photo that was removed earlier brings it back as an owner upload.
        if (['UPLOAD', 'GALLERY'].includes(asset.role) && (asset.status === 'REJECTED' || asset.role !== 'UPLOAD')) {
          await db.mediaAsset.update({ where: { id: asset.id }, data: { status: 'READY', role: 'UPLOAD' } });
          added.push(asset.id);
        } else skipped.push(`${f.name}: already in this article`);
      } else added.push(asset.id);
    } catch (error) {
      skipped.push(`${f.name}: ${(error as Error).message}`);
    }
  }
  await audit('task.images.upload', 'ArticleTask', taskId, { added: added.length, skipped });
  return { added, skipped };
}

/** Never use this source photo again for the article (owner upload or gallery photo). */
export async function removeTaskImage(taskId: string, assetId: string) {
  const asset = await db.mediaAsset.findFirst({ where: { id: assetId, taskId } });
  if (!asset) throw notFound('Image');
  if (!['UPLOAD', 'GALLERY'].includes(asset.role)) throw new AppError(400, 'VALIDATION', 'Rendered images are replaced by regenerating Images; remove the source photo instead.');
  await db.mediaAsset.update({ where: { id: asset.id }, data: { status: 'REJECTED' } });
  await audit('task.images.remove', 'ArticleTask', taskId, { assetId, role: asset.role });
  return { ok: true };
}

export const IMAGE_PLACES = ['FEATURED', 'BODY'] as const;
export type ImagePlace = (typeof IMAGE_PLACES)[number];

/**
 * Owner request (2026-11-05): “Use in featured / Use in body” on a source photo (an upload or a collected ChatGPT
 * photo). The next Images run puts it there before choosing the rest itself; null gives the choice back to the app.
 */
export async function setTaskImagePlace(taskId: string, assetId: string, place: ImagePlace | null) {
  const asset = await db.mediaAsset.findFirst({ where: { id: assetId, taskId } });
  if (!asset) throw notFound('Image');
  if (!['UPLOAD', 'GALLERY'].includes(asset.role) || asset.status === 'REJECTED') throw new AppError(400, 'VALIDATION', 'Only a photo the article may use (an upload or a collected photo) can be given a place.');
  await db.mediaAsset.update({ where: { id: asset.id }, data: { usePlace: place } });
  await audit('task.images.place', 'ArticleTask', taskId, { assetId, place });
  return { ok: true, place };
}
