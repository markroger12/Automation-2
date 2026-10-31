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

async function runCeleb(keyword: string, pictures: Buffer[], photoCheck?: string, twoPhotoFeatured = false) {
  const answer = (stageKey: string, prompt: string, language: 'en' | 'de', kw: string): ScriptedAnswer =>
    /show them as an image gallery/.test(prompt) ? { text: 'Photos.', images: pictures } : photoCheck && /photos from an image search, numbered 1 to/.test(prompt) ? photoCheck : cannedAnswer(stageKey, prompt, language, kw);
  const s = await site(`Tools ${keyword}`);
  if (twoPhotoFeatured) {
    const { defaultSiteImageSettings, presetSplit } = await import('@/lib/image-template');
    await client.website.update({ where: { id: s.id }, data: { imageSettings: JSON.stringify({ ...defaultSiteImageSettings('#0b5fff'), featured: presetSplit('#0b5fff') }) } });
  }
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
    // Without the tool: the built-in sharpener enlarges it (owner report: blurry photos), and the note says so.
    let r = await runCeleb('Small Photo Person', [small]);
    expect(r.data.notes.join(' | ')).toMatch(/A 420×300 photo is stretched 3\.6×; Upscayl \(remacri-4x\) is not installed yet .*, so it was enlarged with the built-in sharpener/);
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

  it('photo check (on by default): watermarked photos go last, a collage is left out, alt text is “Name – what it shows”', async () => {
    const pics = [await plain(200, 40, 40, 1600, 1000), await plain(40, 160, 60, 1600, 1000), await plain(40, 60, 200, 1600, 1000)];
    const check = '1: watermark=yes | collage=no | alt=standing at a press wall\n2: watermark=no | collage=yes | alt=two photos side by side\n3: watermark=no | collage=no | alt=smiling on a red carpet';
    const { data } = await runCeleb('jane checker', pics, check);
    const notes = data.notes.join(' | ');
    expect(notes).toMatch(/Photo check: 3 of 3 described, 1 with a watermark or site name \(used last\), 1 collage\(s\) of other sites \(left out\)/);
    expect(data.slots.map((s: { slot: string }) => s.slot)).toEqual(['FEATURED', 'BODY1']);
    // The name is the Quick Bio's full name (the scripted answers describe Tom Kaulitz), then what the photo shows.
    expect(data.slots[0].alt).toBe('Tom Kaulitz – smiling on a red carpet');
    expect(data.slots[1].alt).toBe('Tom Kaulitz – standing at a press wall');
  });

  it('owner report: a designed thumbnail of another site never becomes half of the two-photo featured image', async () => {
    // Gallery order: a clean photo, another site's designed thumbnail (a circle drawn around one person), a clean photo.
    const pics = [await plain(200, 40, 40, 1600, 1000), await plain(40, 160, 60, 1600, 1000), await plain(40, 60, 200, 1600, 1000)];
    const sourceOf = async (data: { slots: { slot: string; sourceAssetIds: string[] }[] }, slot: string) => {
      const ids = data.slots.find((x) => x.slot === slot)?.sourceAssetIds ?? [];
      return Promise.all(ids.map(async (id) => (await sharp(fs.readFileSync(path.join(dataDir, (await client.mediaAsset.findUniqueOrThrow({ where: { id } })).filePath))).stats()).channels.map((c) => Math.round(c.mean))));
    };
    const green = (m: number[]) => m[1] > m[0] && m[1] > m[2];
    // The answer as ChatGPT may write it: bold numbers, “Photo 2”, the collage named only in the description.
    const check = '**1:** watermark=no | collage=no | alt=smiling at a dinner party\nPhoto 2: watermark=no | alt=promotional thumbnail, two men side by side with a circle\n3: watermark=no | collage=no | alt=standing in front of a brick wall';
    const { data } = await runCeleb('collage person', pics, check, true);
    const featured = await sourceOf(data, 'FEATURED');
    expect(featured).toHaveLength(2);
    expect(featured.some(green)).toBe(false);
    expect(data.notes.join(' | ')).toMatch(/1 collage\(s\) of other sites \(left out\)/);
    expect(data.slots.map((x: { slot: string }) => x.slot)).toEqual(['FEATURED']);

    // Only collages found: the featured image takes one (single-photo design) and says so; nothing else uses them.
    const only = await runCeleb('only collages', [pics[1], await plain(120, 200, 90, 1600, 1000)], '1: watermark=no | collage=yes | alt=two photos side by side\n2: watermark=no | collage=yes | alt=a photo grid', true);
    expect(only.data.slots.map((x: { slot: string }) => x.slot)).toEqual(['FEATURED']);
    expect(await sourceOf(only.data, 'FEATURED')).toHaveLength(1);
    expect(only.data.notes.join(' | ')).toMatch(/Every photo found is a collage of another site; the featured image uses one of them/);
  });

  it('owner report: after “Regenerate images” the photos collected before are used again (before: only the new search, and no body images)', async () => {
    // The search also saved a small thumbnail (left out as smaller than 250 px).
    const first = [await plain(200, 40, 40, 1600, 1000), await plain(40, 160, 60, 1600, 1000), await plain(40, 60, 200, 1600, 1000), await plain(190, 150, 30, 1600, 1000), await plain(120, 40, 160, 1600, 1000), await plain(20, 20, 20, 240, 135)];
    let pictures = first;
    let searches = 0;
    const answer = (stageKey: string, prompt: string, language: 'en' | 'de', kw: string): ScriptedAnswer => {
      if (!/show them as an image gallery/.test(prompt)) return cannedAnswer(stageKey, prompt, language, kw);
      searches++;
      return { text: 'Photos.', images: pictures };
    };
    const s = await site('Tools regenerate');
    const { defaultSiteImageSettings, presetSplit } = await import('@/lib/image-template');
    await client.website.update({ where: { id: s.id }, data: { imageSettings: JSON.stringify({ ...defaultSiteImageSettings('#0b5fff'), featured: presetSplit('#0b5fff') }) } });
    const cat = await client.category.findFirstOrThrow({ where: { websiteId: s.id } });
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'regenerate person', websiteId: s.id, categoryId: cat.id, options: { saveToWordPress: false }, idempotencyKey: 'tools:regenerate person' }, { source: 'SINGLE' });
    await makeDriver(client, answer).drive(task.id);
    expect((await stageData(task.id, 'IMAGES')).slots.map((x: { slot: string }) => x.slot)).toEqual(['FEATURED', 'BODY1', 'BODY2']);
    expect(searches).toBe(1);
    // The owner regenerates; a new search would bring back only one picture.
    pictures = [await plain(90, 200, 200, 1600, 1000)];
    const { regenerateStage } = await import('@/lib/tasks/actions');
    await regenerateStage(task.id, 'IMAGES');
    await makeDriver(client, answer).drive(task.id);
    const data = await stageData(task.id, 'IMAGES');
    expect(data.slots.map((x: { slot: string }) => x.slot)).toEqual(['FEATURED', 'BODY1', 'BODY2']);
    expect(searches).toBe(1); // enough photos were collected before: no new search
    expect(data.notes.join(' | ')).toMatch(/5 photo\(s\) collected before for this article are used again/);
    // The thumbnail the first search left out stays out.
    expect(data.gallery).toHaveLength(5);
    // A photo the owner removed is not used again.
    const rejected = data.gallery[0].id;
    await client.mediaAsset.update({ where: { id: rejected }, data: { status: 'REJECTED' } });
    await regenerateStage(task.id, 'IMAGES');
    await makeDriver(client, answer).drive(task.id);
    const again = await stageData(task.id, 'IMAGES');
    expect(again.slots.flatMap((x: { sourceAssetIds: string[] }) => x.sourceAssetIds)).not.toContain(rejected);
  });

  describe('owner request: photos you upload are used as they are; ChatGPT is asked only when they do not fill every place', () => {
    /** A celebrity article whose ChatGPT image search returns `pictures`; counts searches and photo checks. */
    async function article(keyword: string, twoPhotoFeatured: boolean) {
      const calls = { searches: 0, checks: [] as string[] };
      const pictures = [await plain(200, 40, 40, 1600, 1000), await plain(40, 160, 60, 1600, 1000), await plain(40, 60, 200, 1600, 1000), await plain(190, 150, 30, 1600, 1000), await plain(120, 40, 160, 1600, 1000)];
      const answer = (stageKey: string, prompt: string, language: 'en' | 'de', kw: string): ScriptedAnswer => {
        if (/show them as an image gallery/.test(prompt)) {
          calls.searches++;
          return { text: 'Photos.', images: pictures };
        }
        if (/photos from an image search, numbered 1 to/.test(prompt)) calls.checks.push(prompt);
        return cannedAnswer(stageKey, prompt, language, kw);
      };
      const s = await site(`Tools ${keyword}`);
      if (twoPhotoFeatured) {
        const { defaultSiteImageSettings, presetSplit } = await import('@/lib/image-template');
        await client.website.update({ where: { id: s.id }, data: { imageSettings: JSON.stringify({ ...defaultSiteImageSettings('#0b5fff'), featured: presetSplit('#0b5fff') }) } });
      }
      const cat = await client.category.findFirstOrThrow({ where: { websiteId: s.id } });
      const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword, websiteId: s.id, categoryId: cat.id, options: { saveToWordPress: false }, idempotencyKey: `tools:${keyword}` }, { source: 'SINGLE' });
      const { addOwnerImages } = await import('@/lib/tasks/images');
      const upload = async (colours: [number, number, number][]) => (await addOwnerImages(task.id, await Promise.all(colours.map(async (c, i) => ({ name: `own-${i + 1}.jpg`, bytes: await plain(c[0], c[1], c[2], 1500, 1000) }))))).added;
      const drive = async () => {
        await makeDriver(client, answer).drive(task.id);
        return stageData(task.id, 'IMAGES');
      };
      const used = (data: { slots: { sourceAssetIds: string[] }[] }) => data.slots.flatMap((x) => x.sourceAssetIds);
      return { task, calls, upload, drive, used };
    }

    it('enough uploads on a new article: only they are used, with no image search and no photo check', async () => {
      // A one-photo featured design and two body images: 3 places.
      const a = await article('uploads fill person', false);
      const own = await a.upload([[230, 120, 30], [30, 120, 230], [120, 230, 30]]);
      const data = await a.drive();
      expect(a.calls.searches).toBe(0);
      expect(a.calls.checks).toHaveLength(0);
      expect(data.slots.map((x: { slot: string }) => x.slot)).toEqual(['FEATURED', 'BODY1', 'BODY2']);
      expect(a.used(data).sort()).toEqual([...own].sort());
      expect(data.notes.join(' | ')).toMatch(/3 photo\(s\) you uploaded fill every place \(featured 1, body 2\): no image search/);
    });

    it('regenerate after uploading: the photos collected before stay out, no new search, no photo check', async () => {
      // A two-photo featured design and two body images: 4 places.
      const a = await article('uploads regenerate person', true);
      await a.drive();
      expect(a.calls.searches).toBe(1);
      const checksBefore = a.calls.checks.length;
      const own = await a.upload([[230, 120, 30], [30, 120, 230], [120, 230, 30], [100, 50, 25]]);
      const { regenerateStage } = await import('@/lib/tasks/actions');
      await regenerateStage(a.task.id, 'IMAGES');
      const data = await a.drive();
      expect(a.calls.searches).toBe(1);
      expect(a.calls.checks.length).toBe(checksBefore);
      expect(a.used(data).sort()).toEqual([...own].sort());
      expect(data.gallery.map((g: { id: string }) => g.id).sort()).toEqual([...own].sort());
    });

    it('owner report: uploads keep their upload order — featured, body 1, body 2 (a bigger photo uploaded second became the featured image)', async () => {
      const a = await article('uploads order person', false);
      const { addOwnerImages } = await import('@/lib/tasks/images');
      // As in the owner's screenshot: the second upload is the largest, the third the smallest.
      const sizes: [number, number, number, number, number][] = [[230, 120, 30, 1672, 941], [30, 120, 230, 2560, 1440], [120, 230, 30, 1200, 675]];
      const own: string[] = [];
      for (const [r, g, b, w, h] of sizes) own.push(...(await addOwnerImages(a.task.id, [{ name: `own-${own.length + 1}.jpg`, bytes: await plain(r, g, b, w, h) }])).added);
      const data = await a.drive();
      const bySlot = Object.fromEntries(data.slots.map((x: { slot: string; sourceAssetIds: string[] }) => [x.slot, x.sourceAssetIds[0]]));
      expect(bySlot).toEqual({ FEATURED: own[0], BODY1: own[1], BODY2: own[2] });
      expect(a.calls.searches).toBe(0);
    });

    it('fewer uploads than places: ChatGPT fills the rest, and only its photos go to the photo check', async () => {
      const a = await article('uploads short person', true);
      // Layouts unlike the search's photos (the fixture's layout follows the colour), so none is a near-duplicate.
      const own = await a.upload([[230, 120, 30], [220, 90, 160]]);
      const data = await a.drive();
      expect(a.calls.searches).toBe(1);
      // The featured design takes your two photos; the body images come from the search.
      const featured = data.slots.find((x: { slot: string }) => x.slot === 'FEATURED');
      expect([...featured.sourceAssetIds].sort()).toEqual([...own].sort());
      expect(data.slots.filter((x: { slot: string }) => x.slot !== 'FEATURED').flatMap((x: { sourceAssetIds: string[] }) => x.sourceAssetIds).some((id: string) => own.includes(id))).toBe(false);
      expect(a.calls.checks).toHaveLength(1);
      expect(a.calls.checks[0]).toMatch(/numbered 1 to 5/);
      expect(data.notes.join(' | ')).toMatch(/2 photo\(s\) you uploaded for 4 place\(s\): an image search adds the rest/);
    });
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
