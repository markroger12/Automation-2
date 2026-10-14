import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { db } from '@/lib/db';
import { dataPaths, toDataRelative } from '@/lib/paths';

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/** Detect real image type from magic bytes (never trust the declared MIME). */
export function sniffImage(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && (buf.subarray(0, 6).toString('ascii') === 'GIF87a' || buf.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif';
  return null;
}

export function sha256Buffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** 64-bit difference hash (dHash) as 16 hex chars, for near-duplicate detection. */
export async function dHash(buf: Buffer): Promise<string> {
  const { data } = await sharp(buf).greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer({ resolveWithObject: true });
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[y * 9 + x];
      const right = data[y * 9 + x + 1];
      bits = (bits << 1n) | (left > right ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

export interface StoreImageInput {
  buffer: Buffer;
  taskId?: string | null;
  websiteId?: string | null;
  role: string;
  origin: string;
  sourceUrl?: string | null;
  responseId?: string | null;
  altText?: string | null;
  notes?: string | null;
}

/**
 * Normalize an image through sharp buffers (strips metadata, avoids Windows
 * file locks), store under data/media, de-duplicate by SHA-256 per task.
 */
export async function storeImage(input: StoreImageInput) {
  if (input.buffer.length > MAX_IMAGE_BYTES) throw new Error(`Image is larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.`);
  const sniffed = sniffImage(input.buffer);
  if (!sniffed) throw new Error('Not a supported image (PNG, JPEG, WebP or GIF).');
  const normalized = await sharp(input.buffer, { failOn: 'error', limitInputPixels: 60_000_000 }).rotate().webp({ quality: 90 }).toBuffer();
  const sha256 = sha256Buffer(normalized);
  if (input.taskId) {
    const existing = await db.mediaAsset.findFirst({ where: { taskId: input.taskId, sha256 } });
    if (existing) return { asset: existing, duplicate: true };
  }
  const meta = await sharp(normalized).metadata();
  const dir = path.join(dataPaths.media(), input.taskId ?? 'shared');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${randomUUID()}.webp`);
  fs.writeFileSync(file, normalized);
  const asset = await db.mediaAsset.create({
    data: {
      taskId: input.taskId ?? null,
      websiteId: input.websiteId ?? null,
      role: input.role,
      origin: input.origin,
      sourceUrl: input.sourceUrl ?? null,
      responseId: input.responseId ?? null,
      filePath: toDataRelative(file),
      sha256,
      phash: await dHash(normalized),
      width: meta.width ?? null,
      height: meta.height ?? null,
      bytes: normalized.length,
      mime: 'image/webp',
      altText: input.altText ?? null,
      notes: input.notes ?? null,
    },
  });
  return { asset, duplicate: false };
}

/** Store an already-encoded rendered image (featured/body) without re-encoding it. */
export async function storeRendered(input: { buffer: Buffer; mime: 'image/webp' | 'image/jpeg'; taskId: string; websiteId: string; role: string; altText: string; sourceUrl?: string | null; notes?: string | null; slug?: string | null }) {
  const sha256 = sha256Buffer(input.buffer);
  const meta = await sharp(input.buffer).metadata();
  const dir = path.join(dataPaths.media(), input.taskId);
  fs.mkdirSync(dir, { recursive: true });
  const ext = input.mime === 'image/jpeg' ? 'jpg' : 'webp';
  // File name from the slug with a numbered suffix (e.g. tom-kaulitz-heidi-klum-1.webp), made unique on disk.
  const stem = (input.slug ?? 'image').replace(/[^a-z0-9-]+/gi, '-').slice(0, 60) || 'image';
  const n = input.role === 'FEATURED' ? 0 : input.role === 'BODY1' ? 1 : input.role === 'BODY2' ? 2 : 9;
  let file = path.join(dir, `${stem}${n ? `-${n}` : ''}.${ext}`);
  if (fs.existsSync(file)) file = path.join(dir, `${stem}${n ? `-${n}` : ''}-${randomUUID().slice(0, 6)}.${ext}`);
  fs.writeFileSync(file, input.buffer);
  return db.mediaAsset.create({
    data: {
      taskId: input.taskId,
      websiteId: input.websiteId,
      role: input.role,
      origin: 'RENDERED',
      sourceUrl: input.sourceUrl ?? null,
      filePath: toDataRelative(file),
      sha256,
      width: meta.width ?? null,
      height: meta.height ?? null,
      bytes: input.buffer.length,
      mime: input.mime,
      altText: input.altText,
      notes: input.notes ?? null,
    },
  });
}
