/**
 * Photos the owner adds on the Images tab by button, drag and drop, or paste (owner request: “add drag and drop, and
 * when I paste an image it should come too”): only pictures the app takes, in the order given, at most 8 at a time.
 */
export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const MAX_PHOTOS_AT_ONCE = 8;

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export function pickPhotos(files: File[], how: 'chosen' | 'dropped' | 'pasted', now = new Date()): { photos: File[]; skipped: string[] } {
  const skipped: string[] = [];
  const photos: File[] = [];
  for (const f of files) {
    if (!(PHOTO_TYPES as readonly string[]).includes(f.type)) {
      skipped.push(`${f.name || 'a file'} (not a PNG, JPEG, WebP or GIF picture)`);
      continue;
    }
    if (photos.length >= MAX_PHOTOS_AT_ONCE) {
      skipped.push(`${f.name || 'a picture'} (${MAX_PHOTOS_AT_ONCE} at a time)`);
      continue;
    }
    // A pasted picture is called “image.png” by the browser: it gets a name that says when it was pasted.
    const generic = !f.name || /^image\.(png|jpe?g|webp|gif)$/i.test(f.name);
    if (how === 'pasted' && generic) {
      const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
      photos.push(new File([f], `pasted-${stamp}${photos.length ? `-${photos.length + 1}` : ''}.${EXT[f.type]}`, { type: f.type, lastModified: f.lastModified }));
    } else photos.push(f);
  }
  return { photos, skipped };
}
