import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient, Website } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { configureTestBrowser } from '../helpers/browser';
import { makeDriver, type ScriptedAnswer } from '../helpers/drive';
import { cannedAnswer } from '../helpers/fake-answers';

/**
 * The image tools from the owner's earlier tool (markroger12/automation): MediaPipe face locations and the Upscayl
 * upscaler. The upscaler here is a FAKE `upscayl-bin` (a script that enlarges with sharp) — the real Upscayl needs a
 * GPU and is not run in tests. The face test uses the REAL MediaPipe files when BAS_TEST_MEDIAPIPE_DIR points to a
 * folder filled by `npm run tools:install` (skipped otherwise).
 */
let client: PrismaClient;
let dataDir = '';
let create: typeof import('@/lib/tasks/create');
const MP_SRC = process.env.BAS_TEST_MEDIAPIPE_DIR;
const PORTRAIT = path.resolve(__dirname, '..', 'fixtures', 'images', 'portrait-public-domain.jpg');

// Different layouts per colour, so perceptual hashes see different pictures (not near-duplicates).
const plain = (r: number, g: number, b: number, w: number, h: number) => {
  const k = (r * 7 + g * 3 + b) % 7;
  const stripes = Array.from({ length: 3 + k }, (_, i) => `<rect x="${(i * w) / (3 + k)}" y="${((i + k) % 3) * (h / 4)}" width="${w / (6 + k)}" height="${h / 3}" fill="${i % 2 ? '#eee' : '#222'}"/>`).join('');
  return sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } })
    .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}">${stripes}<circle cx="${w * (0.2 + k / 10)}" cy="${h / 2}" r="${h / 6}" fill="#f1c27d"/></svg>`) }])
    .jpeg()
    .toBuffer();
};

async function site(name: string): Promise<Website> {
  const websites = await import('@/lib/websites');
  const created = await websites.createWebsite({ name, publicUrl: `https://${name.toLowerCase().replace(/\W+/g, '')}.example`, language: 'en', targetCountry: 'United States', timezone: 'UTC' });
  await client.category.create({ data: { websiteId: created.id, externalId: 7, name: 'Celebrities' } });
  return client.website.findUniqueOrThrow({ where: { id: created.id } });
}

const stageData = async (taskId: string, key: string) => JSON.parse((await client.articleStage.findFirstOrThrow({ where: { taskId, key } })).outputJson ?? 'null');

async function runCeleb(keyword: string, pictures: Buffer[], photoCheck?: string) {
  const answer = (stageKey: string, prompt: string, language: 'en' | 'de', kw: string): ScriptedAnswer =>
    /show them as an image gallery/.test(prompt) ? { text: 'Photos.', images: pictures } : photoCheck && /candidate editorial images/.test(prompt) ? photoCheck : cannedAnswer(stageKey, prompt, language, kw);
  const s = await site(`Tools ${keyword}`);
  const cat = await client.category.findFirstOrThrow({ where: { websiteId: s.id } });
  const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword, websiteId: s.id, categoryId: cat.id, options: { saveToWordPress: false }, idempotencyKey: `tools:${keyword}` }, { source: 'SINGLE' });
  const t = await makeDriver(client, answer).drive(task.id);
  return { t, data: await stageData(t.id, 'IMAGES') };
}

beforeAll(async () => {
  configureTestBrowser();
  let dir: string;
  ({ client, dir } = await setupTestDb());
  dataDir = dir;
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  create = await import('@/lib/tasks/create');
  const { registerBuiltInPipelines } = await import('@/worker/pipelines');
  registerBuiltInPipelines();
  const { updateSettings } = await import('@/lib/settings');
  await updateSettings({ seo: { celebrityPhotoSource: 'chatgpt' } });
});

describe('image tools from the earlier tool', () => {
  it('face focus: the largest face, or the middle of a group of similar faces', async () => {
    const { faceFocus } = await import('@/images/faces');
    expect(faceFocus([], 100, 100)).toBeNull();
    const one = faceFocus([{ x: 600, y: 100, w: 200, h: 200, score: 0.9 }, { x: 10, y: 10, w: 40, h: 40, score: 0.8 }], 1000, 1000)!;
    expect(one.x).toBeCloseTo(0.7);
    expect(one.y).toBeCloseTo(0.27);
    const pair = faceFocus([{ x: 100, y: 100, w: 100, h: 100, score: 0.9 }, { x: 700, y: 100, w: 90, h: 90, score: 0.9 }], 1000, 1000)!;
    expect(pair.x).toBeCloseTo(0.445);
  });

  it('a small photo is enlarged with Upscayl (fake binary) before cropping; without Upscayl the Images tab says so', async () => {
    const small = await plain(200, 120, 60, 420, 300);
    // Without the tool: named, never silent.
    let r = await runCeleb('Small Photo Person', [small]);
    expect(r.data.notes.join(' | ')).toMatch(/A 420×300 photo is stretched 3\.6×, but Upscayl \(remacri-4x\) is not installed/);
    // A fake upscayl-bin with the same arguments as the real one (-i in -o out -s 4 -m models -n remacri-4x -f png).
    const tool = path.join(dataDir, 'tools', 'upscayl');
    fs.mkdirSync(path.join(tool, 'models'), { recursive: true });
    fs.writeFileSync(path.join(tool, 'models', 'remacri-4x.param'), 'fake');
    fs.writeFileSync(path.join(tool, 'models', 'remacri-4x.bin'), 'fake');
    // As the earlier tool: the zip may unpack one folder below data/tools/upscayl — the tool is found there too.
    const calls = path.join(tool, 'calls.log');
    const sharpPath = require.resolve('sharp');
    fs.writeFileSync(
      path.join(tool, 'upscayl-bin'),
      `#!/usr/bin/env node
const a = process.argv.slice(2); const arg = (k) => a[a.indexOf(k) + 1];
require('fs').appendFileSync(${JSON.stringify(calls)}, a.join(' ') + '\\n');
const sharp = require(${JSON.stringify(sharpPath)});
sharp(arg('-i')).metadata().then((m) => sharp(arg('-i')).resize(m.width * 4, m.height * 4).png().toFile(arg('-o')));
`,
      { mode: 0o755 },
    );
    r = await runCeleb('Small Photo Again', [small]);
    expect(fs.readFileSync(calls, 'utf8')).toMatch(/-n remacri-4x -s 4 -m .* -f png/);
    expect(r.data.notes.join(' | ')).toMatch(/A 420×300 photo was enlarged 4× with Upscayl \(remacri-4x\) in \d+s \(its place stretched it 3\.6×\)/);
    expect(r.data.slots.find((s: { slot: string }) => s.slot === 'FEATURED')).toBeTruthy();
  });

  it('soft photos go last (sharpness against the gallery, as in the earlier tool)', async () => {
    const sharpA = await plain(200, 40, 40, 1600, 1000);
    const sharpB = await plain(40, 160, 60, 1600, 1000);
    const blurred = await sharp(await plain(40, 60, 200, 1600, 1000)).blur(18).jpeg().toBuffer();
    const { data } = await runCeleb('Soft Photo Person', [blurred, sharpA, sharpB]);
    expect(data.notes.join(' | ')).toMatch(/Photos ordered: 3 different, 1 soft \(used last\)/);
    const sources = await Promise.all(data.slots.map((s: { sourceAssetIds: string[] }) => client.mediaAsset.findUniqueOrThrow({ where: { id: s.sourceAssetIds[0] } })));
    // The blurred one (blue) is the last photo used: BODY2.
    expect(data.slots.map((s: { slot: string }) => s.slot)).toEqual(['FEATURED', 'BODY1', 'BODY2']);
    const last = await sharp(fs.readFileSync(path.join(dataDir, sources[2].filePath))).stats();
    expect(last.channels[2].mean).toBeGreaterThan(last.channels[0].mean);
  });

  it('photo check: watermarked photos go last, a collage never becomes a body image, alt text is “Name – what it shows”', async () => {
    const { updateSettings } = await import('@/lib/settings');
    await updateSettings({ seo: { celebrityPhotoReview: true } });
    try {
      const pics = [await plain(200, 40, 40, 1600, 1000), await plain(40, 160, 60, 1600, 1000), await plain(40, 60, 200, 1600, 1000)];
      const check = '1: watermark=yes | collage=no | alt=standing at a press wall\n2: watermark=no | collage=yes | alt=two photos side by side\n3: watermark=no | collage=no | alt=smiling on a red carpet';
      const { data } = await runCeleb('jane checker', pics, check);
      const notes = data.notes.join(' | ');
      expect(notes).toMatch(/Photo check: 3 of 3 described, 1 with a watermark or site name \(used last\), 1 collage\(s\) of other sites \(never a body image\)/);
      expect(data.slots.map((s: { slot: string }) => s.slot)).toEqual(['FEATURED', 'BODY1']);
      // The name is the Quick Bio's full name (the scripted answers describe Tom Kaulitz), then what the photo shows.
      expect(data.slots[0].alt).toBe('Tom Kaulitz – smiling on a red carpet');
      expect(data.slots[1].alt).toBe('Tom Kaulitz – standing at a press wall');
    } finally {
      await updateSettings({ seo: { celebrityPhotoReview: false } });
    }
  });

  it.skipIf(!MP_SRC)('real MediaPipe: finds the face in a portrait; photos with a face come first and the crop centres on it', async () => {
    const target = path.join(dataDir, 'tools', 'mediapipe');
    fs.cpSync(MP_SRC!, target, { recursive: true });
    const { detectFaces, faceToolAvailable } = await import('@/images/faces');
    expect(faceToolAvailable()).toBe(true);
    const portrait = fs.readFileSync(PORTRAIT);
    const boxes = await detectFaces([portrait, await plain(30, 90, 160, 1600, 1067)]);
    expect(boxes![0]).toHaveLength(1);
    expect(boxes![1]).toHaveLength(0);
    // The gallery shows a photo without a face first; the portrait becomes the featured photo.
    const { data } = await runCeleb('Abraham Lincoln', [await plain(30, 90, 160, 1600, 1067), portrait]);
    const notes = data.notes.join(' | ');
    expect(notes).toMatch(/Photos ordered: 2 different, 1 with a face/);
    const featured = data.slots.find((s: { slot: string }) => s.slot === 'FEATURED');
    const source = await client.mediaAsset.findUniqueOrThrow({ where: { id: featured.sourceAssetIds[0] } });
    expect([source.width, source.height]).toEqual([360, 463]);
  });
});
