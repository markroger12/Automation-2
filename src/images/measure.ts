import sharp, { type Sharp } from 'sharp';

/**
 * Two measures of a gallery photo, from the owner's earlier tool (markroger12/automation-old, images/similar.ts):
 * the fingerprint of the area around the main faces finds a cropped copy of the same photo (one site shows three
 * people whole, another only to their waists), and sharpness finds soft photos (blurred, recompressed, enlarged from
 * a thumbnail). Buffers only: on Windows sharp keeps a file it opened by path.
 */

/** Copies of one photo: face areas at most this many bits apart (of 64) — stricter with one face, as faces look alike. */
export const SAME_FACES_BITS = { one: 6, several: 12 };
/** A photo is soft when its sharpness is below this share of the gallery's middle one (with 3+ photos). */
export const SOFT_SHARE = 0.4;

async function differenceHash(image: Sharp): Promise<string> {
  const pixels = await image.greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let row = 0; row < 8; row++) for (let column = 0; column < 8; column++) bits += pixels[row * 9 + column] > pixels[row * 9 + column + 1] ? '1' : '0';
  return BigInt(`0b${bits}`).toString(16).padStart(16, '0');
}

export function fingerprintDistance(a: string, b: string): number {
  let rest = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (rest) {
    count += Number(rest & 1n);
    rest >>= 1n;
  }
  return count;
}

/** dHash of only the area around the main faces (fractions of the upright picture). */
export async function faceFingerprint(buf: Buffer, area: { left: number; right: number; top: number; bottom: number }): Promise<string> {
  const upright = await sharp(buf).rotate().toBuffer();
  const { width = 0, height = 0 } = await sharp(upright).metadata();
  const left = Math.max(0, Math.round(area.left * width));
  const top = Math.max(0, Math.round(area.top * height));
  return differenceHash(
    sharp(upright).extract({
      left,
      top,
      width: Math.max(1, Math.min(width - left, Math.round((area.right - area.left) * width))),
      height: Math.max(1, Math.min(height - top, Math.round((area.bottom - area.top) * height))),
    }),
  );
}

/** Variance of the Laplacian (edges) at up to 512 px. Only comparable between the photos of one gallery. */
export async function pictureSharpness(buf: Buffer): Promise<number> {
  const { data, info } = await sharp(buf).rotate().greyscale().resize(512, 512, { fit: 'inside', withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  let sum = 0;
  let squares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const at = y * width + x;
      const edge = 4 * data[at] - data[at - 1] - data[at + 1] - data[at - width] - data[at + width];
      sum += edge;
      squares += edge * edge;
      count++;
    }
  }
  return count ? Math.round(squares / count - (sum / count) ** 2) : 0;
}

/**
 * How much a photo is stretched in its place. Same rule as the renderer: a photo much taller than its place is shown
 * whole (contain) on a blurred copy of itself, otherwise it fills the place (cover).
 */
export function displayScale(photo: { width: number; height: number }, place: { width: number; height: number }): number {
  const tall = photo.width / photo.height < (place.width / place.height) * 0.8;
  const x = place.width / photo.width;
  const y = place.height / photo.height;
  return tall ? Math.min(x, y) : Math.max(x, y);
}
