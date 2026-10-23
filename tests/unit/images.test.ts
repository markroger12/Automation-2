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
    // Polotno rotates around the top-left corner; the layer (rotating around its centre) is moved to the same place.
    const [hw, hh, rad] = [(1080 * scale) / 2, (540 * scale) / 2, (5 * Math.PI) / 180];
    expect(img).toMatchObject({ type: 'photo', slot: 0, width: 1080 * scale, rotation: 5 });
    expect(img.x).toBeCloseTo(off + hw * Math.cos(rad) - hh * Math.sin(rad) - hw, 6);
    expect(img.y).toBeCloseTo(hw * Math.sin(rad) + hh * Math.cos(rad) - hh, 6);
    expect(text).toMatchObject({ type: 'text', text: 'Hello', fontWeight: 700, color: '#00ff00', align: 'center', fontSize: 60 * scale });
    expect(svg.type === 'svg' && svg.svg).not.toContain('script');
    expect(rect).toMatchObject({ type: 'rect', fill: 'accent' }); // unsafe color replaced
    expect(template.background).toBe('#ff0000');
    expect(notes.join(' ')).toMatch(/not 16:9/);
    expect(notes.join(' ')).toMatch(/URL was not fetched/);
    expect(notes.join(' ')).toMatch(/“video” is not supported/);
    expect(notes.join(' ')).toMatch(/Only the first page/);
  });

  it("imports the owner's Polotno design as Polotno shows it (white page, right triangles, rotation about the corner, embedded logo, photo slots beside the divider)", () => {
    const logo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const tri = { type: 'figure', subType: 'rightTriangle', fill: 'rgba(2,123,252,1)', width: 237.583793, height: 237.583793 };
    const { template, notes, embedded } = importForeignTemplate({
      width: 1920,
      height: 1080,
      pages: [
        {
          background: 'white',
          width: 'auto',
          height: 'auto',
          children: [
            { type: 'figure', subType: 'rect', name: 'figure-2', x: 928.247314, y: 0, width: 63.505372, height: 1080, fill: 'rgba(0,0,0,1)' },
            { type: 'figure', subType: 'rect', name: 'figure-1', x: 935.496454, y: 0, width: 49.007093, height: 1080, fill: 'rgba(2,123,252,1)' },
            { type: 'image', name: 'image-1', x: 0, y: 961.208103, width: 482.403639, height: 118.791897, src: logo, cropX: 0, cropY: 0, cropWidth: 0.999999996, cropHeight: 1 },
            { ...tri, name: 'figure-3', x: 0, y: 0, rotation: 0 },
            { ...tri, name: 'figure-3', x: 1920, y: 1080, rotation: 180 },
            { type: 'group', children: [{ type: 'figure', subType: 'circle', name: 'dot', x: 10, y: 10, width: 20, height: 20, fill: 'black' }] },
          ],
        },
      ],
    });
    expect(template.background).toBe('#ffffff'); // was the dark fallback: named colours were refused
    const byName = (n: string) => template.layers.filter((l) => l.name === n);
    // Two photo slots, behind everything, left and right of the divider.
    expect(template.layers.slice(0, 2)).toMatchObject([
      { type: 'photo', slot: 0, x: 0, width: 928.247314 },
      { type: 'photo', slot: 1, x: 928.247314 + 63.505372 },
    ]);
    // The embedded logo stays a picture (it was turned into “Photo 1”).
    expect(byName('image-1')[0]).toMatchObject({ type: 'fixed-photo', assetId: 'embedded-2' });
    expect(embedded).toEqual([{ ref: 'embedded-2', name: 'image-1', dataUrl: logo }]);
    // Right triangles keep their shape (they were rectangles); the one rotated about (1920,1080) lands in the corner.
    const [corner, opposite] = byName('figure-3');
    expect(corner).toMatchObject({ type: 'svg', x: 0, y: 0, rotation: 0 });
    expect(corner.type === 'svg' && corner.svg).toContain('d="M 0 0 L 237.583793 0 L 0 237.583793 Z"');
    expect(corner.type === 'svg' && corner.svg).toContain('preserveAspectRatio="none"');
    expect(opposite.x).toBeCloseTo(1920 - 237.583793, 6);
    expect(opposite.y).toBeCloseTo(1080 - 237.583793, 6);
    expect(opposite.rotation).toBe(180);
    expect(byName('dot')[0]).toMatchObject({ type: 'circle', fill: '#000000' }); // group flattened, circle kept
    expect(notes.join(' ')).toMatch(/two photo slots were added/);
    // An image named “photo…” is a photo slot even when the picture is embedded.
    const named = importForeignTemplate({ pages: [{ children: [{ type: 'image', name: 'Photo left', x: 0, y: 0, width: 960, height: 1080, src: logo }] }] });
    expect(named.template.layers).toMatchObject([{ type: 'photo', slot: 0 }]);
    expect(named.embedded).toEqual([]);
  });

  it('decodes Polotno SVG elements (data: URL) and keeps SVG names in their case', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient><path d="M0 0H10V10Z" fill="#000000"/></svg>';
    const { template } = importForeignTemplate({ pages: [{ children: [{ type: 'svg', name: 'icon', x: 0, y: 0, width: 100, height: 100, src: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, colorsReplace: { '#000000': '#ff0000' } }] }] });
    const layer = template.layers.find((l) => l.name === 'icon');
    expect(layer?.type).toBe('svg');
    const out = layer?.type === 'svg' ? layer.svg : '';
    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).toContain('<linearGradient id="g">');
    expect(out).toContain('fill="#ff0000"');
    expect(sanitizeSvg('<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>')).toBe('<svg viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
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

  it('owner request: a circle photo place cuts the photo to a circle with a ring; the preset puts the second photo there', async () => {
    const t = templateSchema.parse({
      background: '#000000',
      accent: '#3b48ff',
      layers: [
        { id: 'bg', type: 'photo', slot: 0, x: 0, y: 0, width: 1920, height: 1080 },
        { id: 'c', type: 'photo', slot: 1, x: 1000, y: 100, width: 800, height: 800, shape: 'circle', stroke: 'accent', strokeWidth: 20 },
      ],
    });
    const png = await renderCanvas({ template: t, photos: [await photo(255, 255, 255), await photo(255, 0, 0)] });
    await expectColor(png, 1400, 500, [255, 0, 0]); // inside the circle: the second photo
    await expectColor(png, 1030, 130, [255, 255, 255]); // the box's corner, outside the circle: the main photo shows
    await expectColor(png, 1400, 108, [59, 72, 255]); // the ring at the top edge, in the accent colour
    // The preset: main photo across the canvas, the second photo in the circle.
    const { presetPhotoCircle } = await import('@/lib/image-template');
    const preset = presetPhotoCircle('#3b48ff');
    expect(preset.layers.filter((l) => l.type === 'photo').map((l) => (l.type === 'photo' ? [l.slot, l.shape] : null))).toEqual([[0, 'rect'], [1, 'circle']]);
    const p2 = await renderCanvas({ template: preset, photos: [await photo(255, 255, 255), await photo(255, 0, 0)] });
    await expectColor(p2, 1450, 540, [255, 0, 0]);
    await expectColor(p2, 400, 540, [255, 255, 255]);
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

describe('earlier tool (automation-old): Tigram plan lines, featured title, tall photos', () => {
  it('reads “IMAGE n PROMPT / ALT” lines and the edited “FEATURED: … | ALT: …” form', async () => {
    const { parseImagePlan } = await import('@/worker/pipelines/images');
    const old = parseImagePlan('**IMAGE 1 PROMPT:** A header with the text "Install WordPress"\nIMAGE 1 ALT: Install WordPress header\n- IMAGE 2 PROMPT: A flat laptop\nIMAGE 2 ALT: Laptop illustration\nIMAGE 3 PROMPT: A flat checklist');
    expect(old).toEqual([
      { slot: 'FEATURED', direction: 'A header with the text "Install WordPress"', alt: 'Install WordPress header' },
      { slot: 'BODY1', direction: 'A flat laptop', alt: 'Laptop illustration' },
      { slot: 'BODY2', direction: 'A flat checklist', alt: '' },
    ]);
    expect(parseImagePlan('FEATURED: Desk | ALT: A tidy desk')[0]).toEqual({ slot: 'FEATURED', direction: 'Desk', alt: 'A tidy desk' });
  });

  it('short featured title: the head before “:”, at most ~45 characters, never ending on a small word', async () => {
    const { featuredImageTitle } = await import('@/worker/pipelines/images');
    expect(featuredImageTitle('How to Install WordPress: The Complete Guide')).toBe('How to Install WordPress');
    expect(featuredImageTitle('The Ultimate Comparison of Project Management Software Cost in 2026')).toBe('The Ultimate Comparison of Project Management');
  });

  it('a photo much taller than its place is shown whole on a blurred copy of itself (not cropped to its middle)', async () => {
    const { renderCleanImage } = await import('@/images/render');
    // Top half red, bottom half blue: cropping to 16:9 would keep only the middle (both colours, no ends).
    const tall = await sharp({ create: { width: 400, height: 1000, channels: 3, background: '#ff0000' } }).composite([{ input: await sharp({ create: { width: 400, height: 500, channels: 3, background: '#0000ff' } }).png().toBuffer(), top: 500, left: 0 }]).png().toBuffer();
    const r = await renderCleanImage(tall, { width: 1200, height: 675, maxBytes: 500_000 });
    const { data, info } = await sharp(r.buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => { const i = (y * info.width + x) * 3; return [data[i], data[i + 1], data[i + 2]]; };
    const top = at(600, 15);
    const bottom = at(600, 660);
    expect(top[0]).toBeGreaterThan(200); // the very top of the photo is still there (red)
    expect(bottom[2]).toBeGreaterThan(200); // and its bottom (blue)
  });
});

describe('owner request: a Celebrity and a Tigram image template', () => {
  it('saved settings without Tigram templates read as before; Tigram then uses the Celebrity designs with the featured design on', async () => {
    const { parseSiteImageSettings, templateSet, withTemplateSet, presetSplit } = await import('@/lib/image-template');
    const old = parseSiteImageSettings(JSON.stringify({ featured: presetSplit('#123456'), body: null, logoAssetId: null }));
    expect(old.tigram).toBeNull();
    expect(templateSet(old, 'tigram')).toEqual({ featured: old.featured, body: null, useFeatured: true });
    // Editing Tigram creates its own set; the Celebrity designs stay as they were.
    const own = withTemplateSet(old, 'tigram', { ...templateSet(old, 'tigram'), featured: presetSingle('#123456'), useFeatured: false });
    expect(own.featured).toEqual(old.featured);
    expect(templateSet(own, 'tigram')).toMatchObject({ featured: { name: 'Single photo · corner logo' }, useFeatured: false });
    expect(templateSet(own, 'celebrity').featured.name).toBe(old.featured.name);
  });

  it('the plan’s featured description loses what it says about written title text (the design writes the title)', async () => {
    const { withoutTitleText } = await import('@/worker/pipelines/images');
    const out = withoutTitleText('Modern blog header illustration featuring the exact title text "Pulsamento" in large, bold letters. A drummer on a stage with warm lights and a rhythmic pattern in the background.', 'FALLBACK');
    expect(out).not.toMatch(/title text|Pulsamento/);
    expect(out).toMatch(/^A drummer on a stage/);
    expect(out).toMatch(/No text, letters, words or numbers anywhere in the picture/);
    expect(withoutTitleText('Large bold title text: "How to Install WordPress".', 'FALLBACK')).toBe('FALLBACK');
  });
});

describe('owner request: more fonts for text (Helvetica-like and others), the same on every computer', () => {
  it('every bundled font weight is shipped with its license, and the nearest weight stands in for a missing one', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { FONT_CHOICES, fontChoice, nearestWeight } = await import('@/lib/fonts');
    const { loadFont } = await import('@/images/fonts');
    const bundled = FONT_CHOICES.filter((f) => f.bundled);
    expect(bundled.length).toBeGreaterThanOrEqual(20);
    for (const f of bundled) {
      expect(fs.existsSync(path.join('public', 'fonts', f.id, 'LICENSE.txt')), `${f.id} license`).toBe(true);
      for (const w of f.weights) expect(loadFont(f.id, w), `${f.id} ${w}`).not.toBeNull();
    }
    expect(nearestWeight(fontChoice('bebas-neue'), 700)).toBe(400);
    expect(nearestWeight(fontChoice('lato'), 600)).toBe(700);
    expect(nearestWeight(fontChoice('arimo'), 800)).toBe(700);
    expect(loadFont('sans', 700)).toBeNull(); // the system fonts stay system fonts
    expect(templateSchema.parse({ layers: [{ id: 't', type: 'text', text: 'x', fontFamily: 'montserrat', x: 0, y: 0, width: 100, height: 100 }] }).layers[0]).toMatchObject({ fontFamily: 'montserrat' });
    expect(() => templateSchema.parse({ layers: [{ id: 't', type: 'text', text: 'x', fontFamily: 'comic-sans', x: 0, y: 0, width: 100, height: 100 }] })).toThrow();
  });

  it('a bundled font is drawn from its file and lines break by its real letter widths; a missing letter falls back to system fonts', async () => {
    const { loadFont, wrapMeasured, covers } = await import('@/images/fonts');
    const mont = loadFont('montserrat', 700)!;
    // Same number of letters, very different widths: only real widths tell them apart.
    expect(wrapMeasured(mont, 'iiiiiiii iiiiiiii', 80, 700, 3)).toHaveLength(1);
    expect(wrapMeasured(mont, 'WWWWWWWW WWWWWWWW', 80, 700, 3)).toHaveLength(2);
    expect(wrapMeasured(mont, 'one two three four five six seven eight nine ten eleven twelve', 80, 700, 2)[1].endsWith('…')).toBe(true);
    expect(covers(mont, 'Größe Malaak Compton-Rock')).toBe(true);
    expect(covers(mont, 'Beijing 北京')).toBe(false);

    const inkWidth = async (fontFamily: string, text = 'MALAAK COMPTON-ROCK') => {
      const t = templateSchema.parse({ background: '#000000', layers: [{ id: 't', type: 'text', text, fontFamily, fontWeight: 700, fontSize: 120, maxLines: 1, x: 0, y: 0, width: 1920, height: 300, color: '#ffffff' }] });
      const png = await renderCanvas({ template: t, photos: [] });
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      let left = info.width;
      let right = -1;
      for (let y = 0; y < 300; y++)
        for (let x = 0; x < info.width; x++)
          if (data[(y * info.width + x) * info.channels] > 128) {
            left = Math.min(left, x);
            right = Math.max(right, x);
          }
      return right - left;
    };
    const montserrat = await inkWidth('montserrat');
    const bebas = await inkWidth('bebas-neue');
    expect(montserrat).toBeGreaterThan(1000);
    expect(bebas).toBeGreaterThan(300);
    expect(bebas).toBeLessThan(montserrat * 0.75); // a condensed display font really is narrower
    // A letter the font lacks: drawn with system fonts instead, never a box or an error.
    expect(await inkWidth('montserrat', 'Beijing 北京')).toBeGreaterThan(100);
  });
});

describe('owner report: in a group photo the faces at both edges were cut in half (Michael Joseph Consuelos, featured image)', () => {
  // Four people side by side in a wide photo (1500×1000), each face a colour; the place is the split design's half (952×1080).
  const FACES = [
    { colour: [230, 30, 30], x: 180 },
    { colour: [30, 200, 30], x: 530 },
    { colour: [30, 30, 230], x: 830 },
    { colour: [230, 210, 30], x: 1180 },
  ];
  const group = () =>
    sharp({ create: { width: 1500, height: 1000, channels: 3, background: { r: 128, g: 128, b: 128 } } })
      .composite(FACES.map((f) => ({ input: { create: { width: 140, height: 150, channels: 3 as const, background: { r: f.colour[0], g: f.colour[1], b: f.colour[2] } } }, left: f.x, top: 300 })))
      .png()
      .toBuffer();
  const fr = (f: { x: number }) => ({ left: f.x / 1500, right: (f.x + 140) / 1500, top: 0.3, bottom: 0.45 });
  const focus = { x: 0.5, y: 0.375, area: { left: 180 / 1500, right: 1320 / 1500, top: 0.3, bottom: 0.45 }, faces: FACES.map(fr) };

  /** How much of each face shows in the left place (1 = whole, 0 = not there), at the scale the photo is shown. */
  async function shown(png: Buffer, scale: number) {
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const full = 140 * 150 * scale ** 2;
    return FACES.map((f) => {
      let n = 0;
      for (let y = 0; y < 1080; y++)
        for (let x = 0; x < 952; x++) {
          const i = (y * info.width + x) * 3;
          if (Math.abs(data[i] - f.colour[0]) < 12 && Math.abs(data[i + 1] - f.colour[1]) < 12 && Math.abs(data[i + 2] - f.colour[2]) < 12) n++;
        }
      return Math.round((n / full) * 100) / 100;
    });
  }

  it('faces too wide for the place: the whole photo is shown on a blurred copy, every face whole (before: both edge faces cut)', async () => {
    const t = presetSplit('#0066ff');
    t.layers = t.layers.filter((l) => l.type === 'photo');
    const png = await renderCanvas({ template: t, photos: [await group(), await photo(10, 10, 10)], focus: [focus, null] });
    // Shown whole across the place's width: 1500 → 952 px.
    const parts = await shown(png, 952 / 1500);
    for (const p of parts) expect(p, `face shares in the place: ${parts.join(', ')}`).toBeGreaterThan(0.9);
    // Without face positions (older stage results, no detector) the crop is as before: a cover crop, no blurred band.
    const plain = await renderCanvas({ template: t, photos: [await group(), await photo(10, 10, 10)], focus: [{ x: 0.5, y: 0.375, area: focus.area }, null] });
    const cut = await shown(plain, 1080 / 1000);
    expect(cut[0]).toBeLessThan(0.5);
  });

  it('crop box: the 16:9 place keeps all four faces; the narrow place has no good crop; without face boxes as before', async () => {
    const { cropBox } = await import('@/images/render');
    expect(cropBox(1500, 1000, 1920, 1080, focus)).toMatchObject({ left: 0 });
    expect(cropBox(1500, 1000, 952, 1080, focus)).toBeNull();
    // Two of the faces fit the narrow place: cropped around them, both whole.
    const pair = { ...focus, faces: [fr(FACES[1]), fr(FACES[2])], area: { left: 530 / 1500, right: 970 / 1500, top: 0.3, bottom: 0.45 } };
    const box = cropBox(1500, 1000, 952, 1080, pair)!;
    const s = box.rw / 1500;
    for (const f of [FACES[1], FACES[2]]) expect((f.x - 28) * s >= box.left && (f.x + 168) * s <= box.left + 952).toBe(true);
    // Stage results saved before face boxes were stored: centred on the area, as before.
    expect(cropBox(1500, 1000, 952, 1080, { ...focus, faces: undefined })).toMatchObject({ left: Math.round(0.5 * Math.ceil(1500 * 1.08) - 476) });
  });

  it('each place takes, of equally good photos, one whose faces fit it whole; the wide group photo moves to the 16:9 body place', async () => {
    const { fitsPlace, photosForPlaces } = await import('@/worker/pipelines/images');
    const half = { width: 952, height: 1080 };
    const body = { width: 1920, height: 1080 };
    const groupFacts = { faces: FACES.map(fr), aspect: 1.5 };
    const pairFacts = { faces: [fr({ x: 600 }), fr({ x: 800 })], aspect: 1.5 };
    expect(fitsPlace(groupFacts, half)).toBe(false);
    expect(fitsPlace(groupFacts, body)).toBe(true);
    expect(fitsPlace(pairFacts, half)).toBe(true);
    expect(fitsPlace(undefined, half)).toBe(true); // no face boxes (older run, or no detector): as before
    const facts: Record<string, { faces: ReturnType<typeof fr>[]; aspect: number }> = { group: groupFacts, pair: pairFacts, solo: { faces: [fr({ x: 700 })], aspect: 1.5 } };
    const fits = (id: string, place: { width: number; height: number }) => fitsPlace(facts[id], place);
    // The group photo has the biggest faces and comes first; the featured halves take the two that fit.
    const featured = photosForPlaces(['group', 'pair', 'solo'], [half, half], fits, () => 'face');
    expect(featured).toEqual({ picked: ['pair', 'solo'], rest: ['group'], moved: 2 });
    expect(photosForPlaces(featured.rest, [body, body], fits, () => 'face').picked).toEqual(['group']);
    // A worse photo (another tier: soft, watermark, no face) is never taken over a better one just because it fits.
    expect(photosForPlaces(['group', 'pair'], [half], fits, (id) => (id === 'group' ? 'sharp' : 'soft')).picked).toEqual(['group']);
  });
});

describe('owner request: a pen tool (like Illustrator) for custom photo places and shapes', () => {
  it('drawn points become a layer box and fractions; curves count in the box; the template keeps them', async () => {
    const { canvasPoints, cornerPoint, penBounds, penGeometry, penLayer } = await import('@/lib/template-editor');
    const tri = [cornerPoint(100, 100), cornerPoint(500, 100), cornerPoint(300, 400)];
    expect(penGeometry(tri, true)).toMatchObject({ x: 100, y: 100, width: 400, height: 300, points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }] });
    // A curve bulging below its points: the box holds the curve, not just the points.
    const arc = [{ ...cornerPoint(100, 100), ox: 0, oy: 200 }, { ...cornerPoint(500, 100), ix: 0, iy: 200 }];
    expect(penBounds(arc, false).height).toBeGreaterThan(140);
    // Back to the canvas, exactly.
    const g = penGeometry(arc, false);
    const back = canvasPoints({ ...g, points: g.points });
    expect(back[1]).toMatchObject({ x: 500, y: 100, iy: expect.closeTo(200, 1) });
    // A photo place (always closed) and a shape; both pass the template schema.
    const photo = penLayer(tri, 'photo', { closed: false, slot: 1 });
    expect(photo).toMatchObject({ type: 'photo', slot: 1, shape: 'path', x: 100, width: 400 });
    const line = penLayer(arc, 'shape', { closed: false });
    expect(line).toMatchObject({ type: 'path', closed: false, fill: 'transparent', stroke: 'accent', strokeWidth: 8 });
    expect(() => templateSchema.parse({ layers: [photo, line] })).not.toThrow();
  });

  it('a point added on a curve keeps its shape; double-click turns a corner into a smooth point and back', async () => {
    const { cornerPoint, insertPoint, nearestOnPath, toggleSmooth } = await import('@/lib/template-editor');
    const curve = [{ ...cornerPoint(0, 0), ox: 0, oy: 300 }, { ...cornerPoint(600, 0), ix: 0, iy: 300 }];
    const hit = nearestOnPath(curve, false, { x: 300, y: 225 }, 20)!;
    expect(hit.index).toBe(0);
    const three = insertPoint(curve, false, hit.index, hit.t);
    expect(three).toHaveLength(3);
    expect(three[1].x).toBeCloseTo(300, 0);
    expect(three[1].y).toBeCloseTo(225, 0); // the middle of that curve, where it was
    expect(Math.abs(three[1].ox)).toBeGreaterThan(0);
    const sq = [cornerPoint(0, 0), cornerPoint(100, 0), cornerPoint(100, 100), cornerPoint(0, 100)];
    const smooth = toggleSmooth(sq, true, 1);
    expect(smooth[1].ox).not.toBe(0);
    expect(toggleSmooth(smooth, true, 1)[1]).toMatchObject({ ix: 0, iy: 0, ox: 0, oy: 0 });
  });

  it('the renderer cuts the photo to the drawn shape, and draws pen shapes with fill and a border that is not cut off', async () => {
    const { cornerPoint, penLayer } = await import('@/lib/template-editor');
    // A triangle photo place over the whole canvas: inside it the (red) photo, outside it the background (navy).
    const tri = [cornerPoint(0, 0), cornerPoint(1920, 0), cornerPoint(960, 1080)];
    const place = penLayer(tri, 'photo', { closed: true, slot: 0 });
    const t = templateSchema.parse({ background: '#000080', layers: [place] });
    const png = await renderCanvas({ template: t, photos: [await photo(220, 20, 20)] });
    await expectColor(png, 960, 300, [220, 20, 20]);
    await expectColor(png, 100, 1000, [0, 0, 128]);
    await expectColor(png, 1820, 1000, [0, 0, 128]);
    // A pen line along the top edge of its box: its border is drawn whole (half of it is above the box).
    const line = penLayer([cornerPoint(200, 500), cornerPoint(1700, 500)], 'shape', { closed: false });
    const s = templateSchema.parse({ background: '#ffffff', accent: '#00aa00', layers: [{ ...line, strokeWidth: 40 }] });
    const lp = await renderCanvas({ template: s, photos: [] });
    await expectColor(lp, 900, 484, [0, 170, 0]); // above the line's centre, outside its (8 px) box
    await expectColor(lp, 900, 470, [255, 255, 255]);
  });
});

describe('people whose face was not found count for the crop (real photos: a panel guest and a B/W group were cut)', () => {
  it('a person without a found face gets a head box at the top of their box; with a face, or far in the background, none', async () => {
    const { headsOfPeople } = await import('@/images/faces');
    const face = { x: 1300, y: 500, w: 80, h: 80, score: 0.9 };
    // A panel: seated guests (upper bodies), one whose face was not found.
    const panel = [
      { x: 1256, y: 485, w: 290, h: 233, score: 0.83 }, // has the face above
      { x: 511, y: 417, w: 210, h: 241, score: 0.8 }, // face not found (glasses, turned)
      { x: 1400, y: 300, w: 40, h: 60, score: 0.6 }, // far in the background
    ];
    const heads = headsOfPeople(panel, [face]);
    expect(heads).toHaveLength(1);
    // Seated (upper body): a head about a third of the box's height, centred at its top.
    expect(heads[0]).toMatchObject({ y: 417 });
    expect(heads[0].w).toBeCloseTo(84.35, 1);
    expect(heads[0].x + heads[0].w / 2).toBeCloseTo(616, 0);
    // Standing people (tall boxes): about a seventh of the height.
    const standing = headsOfPeople([{ x: 95, y: 408, w: 351, h: 848, score: 0.7 }, { x: 1200, y: 459, w: 325, h: 823, score: 0.81 }], []);
    expect(standing).toHaveLength(2);
    expect(standing[0].w).toBeCloseTo(848 * 0.14, 1);
    // A single portrait: the person is as wide as the photo, but the found face is what counts (no head box).
    expect(headsOfPeople([{ x: 62, y: 110, w: 1445, h: 954, score: 0.93 }], [{ x: 220, y: 300, w: 200, h: 200, score: 0.9 }])).toEqual([]);
  });
});
