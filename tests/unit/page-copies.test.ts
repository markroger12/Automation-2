import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { listPageCopies, readPageCopy, savePageCopy } from '@/lib/page-copies';

/** Owner request: the page's structure, for the developer, when the gallery or Search Console went wrong. */
describe('page structure copies (data/page-copies)', () => {
  beforeEach(() => {
    process.env.BAS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-copies-'));
  });

  it('keeps only JSON copies of the expected kind, newest first, and gives them back by name only', () => {
    expect(savePageCopy('chatgpt-gallery', 'not json')).toBeNull();
    expect(savePageCopy('chatgpt-gallery', JSON.stringify({ kind: 'search-console' }))).toBeNull();
    expect(savePageCopy('chatgpt-gallery', JSON.stringify([1, 2]))).toBeNull();
    const a = savePageCopy('chatgpt-gallery', JSON.stringify({ kind: 'chatgpt-gallery', said: 5 }), new Date('2026-10-30T10:00:00Z'))!;
    const b = savePageCopy('search-console', JSON.stringify({ kind: 'search-console', shown: 'not on screen' }), new Date('2026-10-30T11:00:00Z'))!;
    expect(a).toMatch(/^chatgpt-gallery-20261030-100000-[0-9a-f]{6}\.json$/);
    expect(listPageCopies().map((c) => [c.name, c.kind])).toEqual([
      [b, 'search-console'],
      [a, 'chatgpt-gallery'],
    ]);
    expect(JSON.parse(readPageCopy(a)!.toString())).toMatchObject({ kind: 'chatgpt-gallery', said: 5, savedAt: '2026-10-30T10:00:00.000Z' });
    // Nothing else can be read through it.
    expect(readPageCopy('../app.db')).toBeNull();
    expect(readPageCopy('chatgpt-gallery-20261030-100000-zzzzzz.json')).toBeNull();
    expect(readPageCopy('chatgpt-gallery-20261030-100000-abcdef.json')).toBeNull();
  });

  it('keeps the newest 40', () => {
    for (let i = 0; i < 43; i++) savePageCopy('chatgpt-gallery', JSON.stringify({ kind: 'chatgpt-gallery', i }), new Date(Date.UTC(2026, 9, 30, 10, i)));
    const copies = listPageCopies();
    expect(copies).toHaveLength(40);
    expect(JSON.parse(readPageCopy(copies[0].name)!.toString()).i).toBe(42);
    expect(JSON.parse(readPageCopy(copies[39].name)!.toString()).i).toBe(3);
  });
});
