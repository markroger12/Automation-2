import { beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb } from '../helpers/test-db';

/** Owner request (2026-11-05): “Use in featured / Use in body” on a photo — general writers (Tigram and the owner's general writers). */
let assignOwnedSlots: typeof import('@/worker/pipelines/images').assignOwnedSlots;
beforeAll(async () => {
  await setupTestDb();
  ({ assignOwnedSlots } = await import('@/worker/pipelines/images'));
});

const up = (id: string, usePlace: string | null = null) => ({ id, role: 'UPLOAD', usePlace });
const made = (id: string, usePlace: string | null = null) => ({ id, role: 'GALLERY', usePlace });
const ids = (m: Map<string, { id: string }>) => Object.fromEntries([...m].map(([k, v]) => [k, v.id]));

describe('general writers: the places your images take', () => {
  it('without a choice: uploads in upload order (featured, body 1, body 2); ChatGPT’s earlier pictures are made again', () => {
    expect(ids(assignOwnedSlots([up('a'), up('b')]))).toEqual({ FEATURED: 'a', BODY1: 'b' });
    expect(ids(assignOwnedSlots([up('a'), up('b'), up('c'), up('d')]))).toEqual({ FEATURED: 'a', BODY1: 'b', BODY2: 'c' });
  });

  it('“Use in featured” / “Use in body” first, also a picture ChatGPT made earlier; the other uploads fill what is left', () => {
    expect(ids(assignOwnedSlots([up('a', 'BODY'), up('b')]))).toEqual({ BODY1: 'a', FEATURED: 'b' });
    expect(ids(assignOwnedSlots([up('a'), up('b'), made('g', 'FEATURED')]))).toEqual({ FEATURED: 'g', BODY1: 'a', BODY2: 'b' });
    // Two chosen for the featured image (it has one picture): the second goes to the body.
    expect(ids(assignOwnedSlots([up('a', 'FEATURED'), made('g', 'FEATURED')]))).toEqual({ FEATURED: 'a', BODY1: 'g' });
  });
});
