import fs from 'node:fs';
import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { fromDataRelative } from '@/lib/paths';

/** Serve a stored media asset for previews (data/ only; path validated). */
export const GET = route({}, async ({ params }) => {
  const asset = await db.mediaAsset.findUnique({ where: { id: params.id } });
  if (!asset) throw new AppError(404, 'NOT_FOUND', 'Image not found.');
  let file: string;
  try {
    file = fromDataRelative(asset.filePath);
  } catch {
    throw new AppError(400, 'BAD_PATH', 'Invalid media path.');
  }
  if (!fs.existsSync(file)) throw new AppError(404, 'NOT_FOUND', 'Image file is missing on disk.');
  return new Response(new Uint8Array(fs.readFileSync(file)), { headers: { 'Content-Type': asset.mime ?? 'application/octet-stream', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
});
