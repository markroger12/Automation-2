import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { CANVAS, importForeignTemplate, presetSingle, presetSplit, sanitizeSvg, templateSchema, type Layer } from '@/lib/image-template';
import { encodeWithinBudget, renderCanvas, renderTemplate, wrapText } from '@/images/render';
import {
  anchorRotatedResize,
  commit,
  commitFrom,
  createLayer,
  duplicateLayer,
  HISTORY_LIMIT,
  initHistory,
  redo,
  reorderLayer,
  replacePresent,
  resizeRect,
  rotationFromPointer,
  snapMove,
  snapResize,
  toLocal,
  undo,
} from '@/lib/template-editor';

const photo = (r: number, g: number, b: number) => sharp({ create: { width: 1600, height: 900, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();

async function pixel(png: Buffer, x: number, y: number) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

/** JPEG sources drift by a unit or two per channel. */
async function expectColor(png: Buffer, x: number, y: number, rgb: number[]) {
  const got = await pixel(png, x, y);
  expect(got.every((v, i) => Math.abs(v - rgb[i]) <= 4), `pixel ${x},${y} = ${got} (expected ${rgb})`).toBe(true);
}

describe('SVG sanitizer', () => {
  it('keeps plain shapes and drops scripts, handlers, embedded images and external references', () => {
    const dirty = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10" fill="url(https://evil.example/x)" onclick="x()"/><circle cx="5" cy="5" r="3" fill="#fff"/><image href="https://evil.example/a.png"/><foreignObject><div>hi</div></foreignObject><a href="javascript:alert(3)"><path d="M0 0L1 1"/></a></svg>`;
    const clean = sanitizeSvg(dirty)!;
    expect(clean).toMatch(/^<svg /);
    expect(clean).toContain('<circle cx="5" cy="5" r="3" fill="#fff"/>');
    expect(clean).not.toMatch(/script|onload|onclick|evil\.example|foreignObject|<image|javascript:|<a\b/i);
    expect(clean).not.toContain('alert');
    expect(sanitizeSvg('<div>no svg</div>')).toBeNull();
    expect(sanitizeSvg('<svg>' + 'x'.repeat(60_000) + '</svg>')).toBeNull();
  });
});

describe('Polotno-like import', () => {
  it('scales pages proportionally, keeps transforms, turns images into photo slots without fetching, sanitizes SVG', () => {
    const { template, notes } = importForeignTemplate({
      width: 1080,
      height: 1080,
      pages: [
        {
          background: '#ff0000',
          children: [
            { type: 'image', name: 'Hero', x: 0, y: 0, width: 1080, height: 540, rotation: 5, src: 'https://cdn.example/a.jpg' },
            { type: 'text', text: 'Hello', x: 100, y: 600, width: 880, height: 200, fontSize: 60, fontWeight: 'bold', fill: '#00ff00', align: 'center' },
            { type: 'svg', svg: '<svg viewBox="0 0 1 1"><script>x</script><rect width="1" height="1"/></svg>', x: 10, y: 10, width: 50, height: 50 },
            { type: 'video', x: 0, y: 0 },
            { type: 'figure', fill: 'javascript:alert(1)', x: 0, y: 1000, width: 1080, height: 80 },
          ],
        },
        { children: [] },
      ],
    });
    const scale = CANVAS.height / 1080;
    const off = (CANVAS.width - 1080 * scale) / 2;
    const [img, text, svg, rect] = template.layers;
    expect(img).toMatchObject({ type: 'photo', slot: 0, x: off, y: 0, width: 1080 * scale, rotation: 5 });
    expect(text).toMatchObject({ type: 'text', text: 'Hello', fontWeight: 700, color: '#00ff00', align: 'center', fontSize: 60 * scale });
    expect(svg.type === 'svg' && svg.svg).not.toContain('script');
    expect(rect).toMatchObject({ type: 'rect', fill: 'accent' }); // unsafe color replaced
    expect(template.background).toBe('#ff0000');
    expect(notes.join(' ')).toMatch(/not 16:9/);
    expect(notes.join(' ')).toMatch(/URL was not fetched/);
    expect(notes.join(' ')).toMatch(/“video” is not supported/);
    expect(notes.join(' ')).toMatch(/Only the first page/);
  });

  it('falls back to the default preset for an empty document', () => {
    expect(importForeignTemplate({}).template.layers.length).toBeGreaterThan(0);
    expect(importForeignTemplate(null).notes[0]).toMatch(/No page/);
  });
});

describe('production renderer', () => {
  it('draws layers at their canvas coordinates (rect, accent, photo slots) at 1920×1080', async () => {
    const t = templateSchema.parse({
      background: '#000000',
      accent: '#00ff00',
      layers: [
        { id: 'p', type: 'photo', slot: 1, x: 0, y: 0, width: 960, height: 1080 },
        { id: 'r', type: 'rect', x: 1000, y: 100, width: 200, height: 200, fill: '#ff0000' },
        { id: 'a', type: 'rect', x: 1300, y: 100, width: 200, height: 200, fill: 'accent' },
        { id: 'h', type: 'rect', x: 1600, y: 100, width: 200, height: 200, fill: '#ffffff', visible: false },
      ],
    });
    const png = await renderCanvas({ template: t, photos: [await photo(255, 0, 0), await photo(0, 0, 255)] });
    const meta = await sharp(png).metadata();
    expect([meta.width, meta.height]).toEqual([1920, 1080]);
    await expectColor(png, 400, 500, [0, 0, 255]); // slot 2 photo
    await expectColor(png, 1100, 200, [255, 0, 0]);
    await expectColor(png, 1400, 200, [0, 255, 0]);
    await expectColor(png, 1700, 200, [0, 0, 0]); // hidden layer not drawn
  });

  it('clips rotated and off-canvas layers instead of failing, and draws fixed photos and the logo plate', async () => {
    const t = templateSchema.parse({
      layers: [
        { id: 'big', type: 'rect', x: -400, y: -300, width: 3000, height: 2000, rotation: 33, fill: '#123456', opacity: 0.5 },
        { id: 'fx', type: 'fixed-photo', assetId: 'fixed1', x: 0, y: 0, width: 100, height: 100 },
        { id: 'lg', type: 'logo', x: 1700, y: 900, width: 200, height: 160, plate: true, plateColor: '#ffffff' },
        { id: 'gone', type: 'circle', x: 5000 - 3000, y: 3000 - 1000, width: 10, height: 10 },
      ],
    });
    const logo = await sharp({ create: { width: 100, height: 40, channels: 4, background: { r: 255, g: 0, b: 255, alpha: 1 } } }).png().toBuffer();
    const png = await renderCanvas({ template: t, photos: [], logo, fixedPhotos: { fixed1: await photo(0, 255, 0) } });
    await expectColor(png, 50, 50, [0, 255, 0]);
    await expectColor(png, 1705, 905, [255, 255, 255]); // plate corner
    await expectColor(png, 1800, 980, [255, 0, 255]); // logo centered on the plate
  });

  it('fits long titles (shrinks, then truncates with an ellipsis) and wraps by width', () => {
    const lines = wrapText('A very long headline that will certainly need more than one line at this size', 80, 800, 2);
    expect(lines.length).toBe(2);
    expect(lines[1].endsWith('…')).toBe(true);
    expect(wrapText('Short', 80, 800, 3)).toEqual(['Short']);
  });

  it('encodes presets within the byte budget at the output size', async () => {
    for (const t of [presetSingle('#ff6600'), presetSplit('#0066ff')]) {
      const r = await renderTemplate({ template: t, photos: [await photo(200, 120, 80), await photo(30, 90, 200)], vars: { title: 'Tom Kaulitz and Heidi Klum: a long title that wraps over two lines' } }, { width: 1200, height: 675, maxBytes: 120_000 });
      expect([r.width, r.height]).toEqual([1200, 675]);
      expect(r.buffer.length).toBeLessThanOrEqual(120_000);
      expect(r.mime).toBe('image/webp');
    }
  });

  it('reduces quality, then size, for a tight budget', async () => {
    const noisy = await sharp(Buffer.from(Array.from({ length: 1920 * 1080 * 3 }, (_, i) => (i * 7919) % 251)), { raw: { width: 1920, height: 1080, channels: 3 } }).png().toBuffer();
    const r = await encodeWithinBudget(noisy, { width: 1920, height: 1080, maxBytes: 60_000 });
    expect(r.quality).toBeLessThan(82);
    expect(r.width).toBeLessThanOrEqual(1920);
  });
});

describe('template editor logic', () => {
  it('snaps moves to canvas center/edges and other layers, and resize edges to targets', () => {
    const s = snapMove({ x: 857, y: 10, width: 200, height: 100 }, [], 6);
    expect(s.x).toBe(860); // center 960
    expect(s.guides).toContainEqual({ axis: 'x', at: 960 });
    expect(s.y).toBe(10); // nothing within 6
    const other = { x: 1200, y: 400, width: 300, height: 300 };
    expect(snapMove({ x: 1004, y: 396, width: 200, height: 100 }, [other], 6)).toMatchObject({ x: 1000, y: 400 });
    const r = snapResize({ x: 100, y: 100, width: 1096, height: 50 }, 'e', [other], 6);
    expect(r.rect.width).toBe(1100);
    expect(snapResize({ x: 950, y: 100, width: 15, height: 50 }, 'w', [], 15).rect).toMatchObject({ x: 950, width: 15 }); // snapping to 960 would collapse it: refused
  });

  it('resizes from every handle with a fixed opposite edge, minimum size and kept ratio', () => {
    const start = { x: 100, y: 100, width: 400, height: 200 };
    expect(resizeRect(start, 'se', 100, 50)).toEqual({ x: 100, y: 100, width: 500, height: 250 });
    expect(resizeRect(start, 'nw', 100, 50)).toEqual({ x: 200, y: 150, width: 300, height: 150 });
    expect(resizeRect(start, 'w', 1000, 0)).toEqual({ x: 492, y: 100, width: 8, height: 200 });
    const kept = resizeRect(start, 'se', 200, 0, true);
    expect(kept.width / kept.height).toBeCloseTo(2);
  });

  it('handles rotated layers: local deltas, anchored resize and rotation from the pointer', () => {
    const d = toLocal(0, 10, 90);
    expect(d.dx).toBeCloseTo(10);
    expect(d.dy).toBeCloseTo(0);
    // A layer rotated 90°: growing its local width by 100 moves the center 50 down in canvas space.
    const start = { x: 0, y: 0, width: 200, height: 100 };
    const next = anchorRotatedResize(start, { ...start, width: 300 }, 90);
    expect(next.x + next.width / 2).toBeCloseTo(100);
    expect(next.y + next.height / 2).toBeCloseTo(100);
    expect(rotationFromPointer({ x: 0, y: 0 }, { x: 0, y: -10 })).toBe(0);
    expect(rotationFromPointer({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(90);
    expect(rotationFromPointer({ x: 0, y: 0 }, { x: 10, y: -9 }, true)).toBe(45);
  });

  it('orders, creates and duplicates valid layers', () => {
    const types: Layer['type'][] = ['photo', 'fixed-photo', 'logo', 'text', 'rect', 'circle', 'svg'];
    const layers = types.map((t) => createLayer(t, { assetId: 'a1' }));
    expect(templateSchema.safeParse({ layers }).success).toBe(true);
    expect(new Set(layers.map((l) => l.id)).size).toBe(layers.length);
    const ids = layers.map((l) => l.id);
    expect(reorderLayer(layers, ids[0], 'front').map((l) => l.id).at(-1)).toBe(ids[0]);
    expect(reorderLayer(layers, ids[6], 'back')[0].id).toBe(ids[6]);
    expect(reorderLayer(layers, ids[2], 'up')[3].id).toBe(ids[2]);
    expect(reorderLayer(layers, ids[2], 'down')[1].id).toBe(ids[2]);
    const copy = duplicateLayer(layers[3]);
    expect(copy.id).not.toBe(layers[3].id);
    expect(copy.x).toBe(layers[3].x + 40);
  });

  it('keeps an undo history with coalesced typing, live drags as one step, and a limit', () => {
    let h = initHistory('a');
    h = commit(h, 'ab', 'name', 1000);
    h = commit(h, 'abc', 'name', 1500); // same field within the window → one step
    h = commit(h, 'abcd', 'other', 1600);
    expect(h.past).toEqual(['a', 'abc']);
    h = undo(h);
    expect(h.present).toBe('abc');
    h = undo(h);
    expect(h.present).toBe('a');
    h = redo(h);
    expect(h.present).toBe('abc');
    const before = h.present;
    h = replacePresent(h, 'drag1');
    h = replacePresent(h, 'drag2');
    h = commitFrom(h, before);
    expect(h.present).toBe('drag2');
    expect(undo(h).present).toBe('abc');
    expect(h.future).toEqual([]);
    let big = initHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 20; i++) big = commit(big, i);
    expect(big.past.length).toBe(HISTORY_LIMIT);
  });
});
