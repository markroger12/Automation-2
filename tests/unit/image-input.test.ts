import { describe, expect, it } from 'vitest';
import { pickPhotos } from '@/lib/client/image-input';

/** Owner request: the Images tab's “Your photos” also takes dropped and pasted pictures, not only the button. */
describe('photos added by drag and drop or paste', () => {
  const file = (name: string, type: string) => new File([new Uint8Array([1, 2, 3])], name, { type });
  const now = new Date('2026-10-30T11:05:09Z');

  it('keeps pictures in the order given and leaves out other files, saying why', () => {
    const r = pickPhotos([file('a.jpg', 'image/jpeg'), file('notes.txt', 'text/plain'), file('b.webp', 'image/webp'), file('c.png', 'image/png')], 'dropped', now);
    expect(r.photos.map((f) => f.name)).toEqual(['a.jpg', 'b.webp', 'c.png']);
    expect(r.skipped).toEqual(['notes.txt (not a PNG, JPEG, WebP or GIF picture)']);
  });

  it('a pasted picture (“image.png”) gets a name with the time it was pasted; a named one keeps its name', () => {
    const r = pickPhotos([file('image.png', 'image/png'), file('image.png', 'image/png'), file('Getty-123.jpg', 'image/jpeg')], 'pasted', now);
    expect(r.photos.map((f) => f.name)).toEqual(['pasted-20261030-110509.png', 'pasted-20261030-110509-2.png', 'Getty-123.jpg']);
    expect(r.photos[0].type).toBe('image/png');
  });

  it('at most 8 at a time (the server takes 8 per upload)', () => {
    const r = pickPhotos(Array.from({ length: 10 }, (_, i) => file(`p${i + 1}.jpg`, 'image/jpeg')), 'dropped', now);
    expect(r.photos).toHaveLength(8);
    expect(r.skipped).toEqual(['p9.jpg (8 at a time)', 'p10.jpg (8 at a time)']);
  });

  it('a chosen file named image.png keeps its name', () => {
    expect(pickPhotos([file('image.png', 'image/png')], 'chosen', now).photos[0].name).toBe('image.png');
  });
});
