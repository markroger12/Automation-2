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

const plain = (r: number, g: number, b: number, w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } })
    .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}"><rect x="${w / 5}" y="${h / 4}" width="${w / 3}" height="${h / 3}" fill="#222"/><rect x="${w / 2}" y="${h / 2}" width="${w / 4}" height="${h / 5}" fill="#eee"/></svg>`) }])
    .jpeg()
    .toBuffer();

async function site(name: string): Promise<Website> {
  const websites = await import('@/lib/websites');
  const created = await websites.createWebsite({ name, publicUrl: `https://${name.toLowerCase().replace(/\W+/g, '')}.example`, language: 'en', targetCountry: 'United States', timezone: 'UTC' });
  await client.category.create({ data: { websiteId: created.id, externalId: 7, name: 'Celebrities' } });
  return client.website.findUniqueOrThrow({ where: { id: created.id } });
}

const stageData = async (taskId: string, key: string) => JSON.parse((await client.articleStage.findFirstOrThrow({ where: { taskId, key } })).outputJson ?? 'null');

async function runCeleb(keyword: string, pictures: Buffer[]) {
  const answer = (stageKey: string, prompt: string, language: 'en' | 'de', kw: string): ScriptedAnswer =>
    /show them as an image gallery/.test(prompt) ? { text: 'Photos.', images: pictures } : cannedAnswer(stageKey, prompt, language, kw);
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
    expect(r.data.notes.join(' | ')).toMatch(/Upscayl is not installed/);
    // A fake upscayl-bin with the same arguments as the real one (-i in -o out -s 4 -m models -n remacri-4x -f png).
    const tool = path.join(dataDir, 'tools', 'upscayl');
    fs.mkdirSync(path.join(tool, 'models'), { recursive: true });
    fs.writeFileSync(path.join(tool, 'models', 'remacri-4x.param'), 'fake');
    fs.writeFileSync(path.join(tool, 'models', 'remacri-4x.bin'), 'fake');
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
    expect(fs.readFileSync(calls, 'utf8')).toMatch(/-s 4 .*-n remacri-4x -f png/);
    expect(r.data.notes.join(' | ')).toMatch(/A small photo \(420×300\) was enlarged with Upscayl/);
    expect(r.data.slots.find((s: { slot: string }) => s.slot === 'FEATURED')).toBeTruthy();
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
    expect(notes).toMatch(/Face detector: 1 of 2 photo\(s\) show a face/);
    const featured = data.slots.find((s: { slot: string }) => s.slot === 'FEATURED');
    const source = await client.mediaAsset.findUniqueOrThrow({ where: { id: featured.sourceAssetIds[0] } });
    expect([source.width, source.height]).toEqual([360, 463]);
  });
});
