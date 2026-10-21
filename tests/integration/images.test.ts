import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BrowserContext } from 'playwright';
import type { PrismaClient, Website } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';
import { configureTestBrowser } from '../helpers/browser';
import { makeDriver, type ScriptedAnswer } from '../helpers/drive';
import { cannedAnswer } from '../helpers/fake-answers';
import { startFakeWordPress, type FakeWp } from '../fixtures/fake-wordpress';

/**
 * IMAGES stage with the real engine: generated images (scripted ChatGPT,
 * delivered like the extension uploads them), a celebrity gallery from a FAKE
 * Wikimedia Commons (local server resolved by a test-only lookup), rendering,
 * placement, WordPress media upload and graceful degradation.
 */
let client: PrismaClient;
let net: typeof import('@/lib/links/net');
let browser: typeof import('@/wordpress/browser');
let session: typeof import('@/wordpress/session');
let create: typeof import('@/lib/tasks/create');
let actions: typeof import('@/lib/tasks/actions');
let commons: http.Server;
let PORT = 0;
const servers: FakeWp[] = [];
let commonsPages: unknown[] = [];
const files = new Map<string, Buffer>();

// Distinct compositions per seed (perceptual hashes see structure, not colour).
const solid = (r: number, g: number, b: number, w = 1600, h = 1067) => {
  const cx = (w * (0.2 + ((r + g) % 7) / 10)) | 0;
  const stripes = Array.from({ length: 1 + (b % 5) }, (_, i) => `<rect x="${(i * w) / (1 + (b % 5))}" y="${(h * (g % 3)) / 4}" width="${w / (3 + (b % 5))}" height="${h / 4}" fill="#${(i % 2 ? 'ffffff' : '111111')}"/>`).join('');
  return sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } })
    .composite([{ input: Buffer.from(`<svg width="${w}" height="${h}">${stripes}<circle cx="${cx}" cy="${h / 3 + (r % 3) * 120}" r="${h / 5}" fill="#f1c27d"/><rect x="${w - cx - w / 6}" y="${h / 2}" width="${w / 3}" height="${h / 2}" fill="#1f2937"/></svg>`) }])
    .jpeg()
    .toBuffer();
};

function page(title: string, file: string, w: number, h: number, mime = 'image/jpeg') {
  return { title: `File:${title}`, imageinfo: [{ url: `http://upload.wikimedia.org:${PORT}/${file}`, thumburl: `http://upload.wikimedia.org:${PORT}/${file}`, width: w, height: h, mime, descriptionurl: `http://commons.wikimedia.org:${PORT}/wiki/File:${encodeURIComponent(title)}` }] };
}

async function loggedInSite(wp: FakeWp, name: string, overrides: Record<string, unknown> = {}): Promise<Website> {
  const websites = await import('@/lib/websites');
  const created = await websites.createWebsite({ name, publicUrl: wp.url, language: 'en', targetCountry: 'United States', timezone: 'UTC' });
  const site = await client.website.findUniqueOrThrow({ where: { id: created.id } });
  expect((await session.interactiveLogin(site, async () => true, 60_000)).state).toBe('ACTIVE');
  await session.syncCategories(site);
  await client.website.update({ where: { id: site.id }, data: { settingsOverrides: JSON.stringify({ content: {}, seo: { rankMathMode: 'off', ...overrides }, workflow: {} }) } });
  return client.website.findUniqueOrThrow({ where: { id: site.id } });
}

async function offlineSite(name: string): Promise<Website> {
  const websites = await import('@/lib/websites');
  const created = await websites.createWebsite({ name, publicUrl: `https://${name.toLowerCase().replace(/\W+/g, '')}.example`, language: 'en', targetCountry: 'United States', timezone: 'UTC' });
  await client.category.create({ data: { websiteId: created.id, externalId: 7, name: 'Celebrities' } });
  return client.website.findUniqueOrThrow({ where: { id: created.id } });
}

async function addLogo(siteId: string) {
  const { storeImage } = await import('@/images/store');
  const logo = await sharp(Buffer.from('<svg width="400" height="160" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="160" rx="24" fill="#0f766e"/></svg>')).png().toBuffer();
  await storeImage({ buffer: logo, websiteId: siteId, role: 'LOGO', origin: 'UPLOADED' });
}

const stageData = async (taskId: string, key: string) => JSON.parse((await client.articleStage.findFirstOrThrow({ where: { taskId, key } })).outputJson ?? 'null');

beforeAll(async () => {
  configureTestBrowser();
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  net = await import('@/lib/links/net');
  browser = await import('@/wordpress/browser');
  session = await import('@/wordpress/session');
  create = await import('@/lib/tasks/create');
  actions = await import('@/lib/tasks/actions');
  const { registerBuiltInPipelines } = await import('@/worker/pipelines');
  registerBuiltInPipelines();
  browser.onWordPressContext(async (context: BrowserContext) => {
    setTimeout(async () => {
      const p = context.pages()[0];
      if (!p || !/wp-login\.php/.test(p.url())) return;
      await p.fill('#user_login', 'owner').catch(() => {});
      await p.fill('#user_pass', 'owner-typed-this').catch(() => {});
      await p.click('#wp-submit').catch(() => {});
    }, 1200);
  });
  commons = http.createServer((req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const url = new URL(req.url ?? '/', 'http://x');
    if (host === 'commons.wikimedia.org' && url.pathname === '/w/api.php') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ query: { pages: commonsPages } }));
    }
    const file = files.get(url.pathname.slice(1));
    if ((host === 'upload.wikimedia.org' || host === 'news.example') && file) {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return res.end(file);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => commons.listen(0, '127.0.0.1', r));
  PORT = (commons.address() as AddressInfo).port;
  net.setLinkNetworkForTests(async (host) => {
    if (['commons.wikimedia.org', 'upload.wikimedia.org', 'news.example'].includes(host)) return [{ address: '127.0.0.1', family: 4 }];
    throw new Error('ENOTFOUND');
  }, ['commons.wikimedia.org', 'upload.wikimedia.org', 'news.example']);
  (await import('@/images/sources/wikimedia')).setCommonsApiBaseForTests(`http://commons.wikimedia.org:${PORT}/w/api.php`);
  // These tests cover the Wikimedia Commons source; the ChatGPT image-search source switches it on itself.
  const { updateSettings } = await import('@/lib/settings');
  await updateSettings({ seo: { celebrityPhotoSource: 'commons' } });
});

afterAll(async () => {
  net.setLinkNetworkForTests(null);
  (await import('@/images/sources/wikimedia')).setCommonsApiBaseForTests(null);
  await browser.closeAllContexts();
  for (const s of servers) await s.close();
  await new Promise((r) => commons.close(r));
});

describe('Image Studio (IMAGES stage)', () => {
  it('general article: plan → three generated images → branded featured + two clean body images, placed and uploaded once to WordPress', async () => {
    const wp = await startFakeWordPress();
    servers.push(wp);
    const site = await loggedInSite(wp, 'Tech Blog');
    await addLogo(site.id);
    const colors = [await solid(200, 40, 40), await solid(40, 160, 60), await solid(40, 60, 200)];
    let gen = 0;
    const answer = (stageKey: string, prompt: string, language: 'en' | 'de', keyword: string) => {
      if (/Plan 3 images/.test(prompt)) return `FEATURED: A laptop on a tidy desk with soft light | ALT: Laptop on a desk prepared for a WordPress installation\nBODY1: A browser window with a setup wizard, flat style | ALT: Setup wizard steps shown in a browser window\nBODY2: A checklist on a clipboard, flat style | ALT: Checklist for securing a new website`;
      if (/Create this image now/.test(prompt)) return { text: 'Here is the image.', images: [colors[gen++ % 3]] };
      return cannedAnswer(stageKey, prompt, language, keyword);
    };
    const driver = makeDriver(client, answer);
    const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword: 'How to Install WordPress', secondaryKeywords: 'hosting', websiteId: site.id, idempotencyKey: 'img:gen-1' }, { source: 'SINGLE' });
    const t = await driver.drive(task.id);
    const data = await stageData(t.id, 'IMAGES');
    expect(data.slots.map((s: { slot: string }) => s.slot)).toEqual(['FEATURED', 'BODY1', 'BODY2']);
    for (const s of data.slots) {
      expect(s.width).toBe(1200);
      expect(s.height).toBe(675);
      expect(s.bytes).toBeLessThanOrEqual(350_000);
      expect(s.alt.length).toBeGreaterThan(10);
    }
    expect(new Set(data.slots.flatMap((s: { sourceAssetIds: string[] }) => s.sourceAssetIds)).size).toBe(3);
    // Placement: BODY1 before the second H2, BODY2 before the FAQ section; descriptive alt text.
    const html = t.assembledHtml!;
    const h2 = [...html.matchAll(/<h2>/g)].map((m) => m.index!);
    expect(html.indexOf('data-bas-slot="BODY1"')).toBeLessThan(h2[1]);
    expect(html.indexOf('data-bas-slot="BODY1"')).toBeGreaterThan(h2[0]);
    expect(html.indexOf('data-bas-slot="BODY2"')).toBeLessThan(html.indexOf('<h2>Frequently Asked Questions</h2>'));
    expect(html).toContain('alt="Setup wizard steps shown in a browser window"');
    // WordPress: featured + two body images uploaded once, image blocks reference them.
    expect(t.status, t.reviewReasons).toBe('COMPLETED');
    expect(wp.media.size).toBe(3);
    const post = [...wp.posts.values()][0];
    expect(post.featured_media).toBeGreaterThan(0);
    expect((post.content.match(/<!-- wp:image \{"id":\d+/g) ?? []).length).toBe(2);
    expect(post.content).not.toContain('/api/media/');
    expect([...wp.media.values()].map((m) => m.alt)).toContain('Checklist for securing a new website');
    await actions.resaveToWordPress(t.id, { mode: 'resave' });
    expect((await driver.drive(t.id)).status).toBe('COMPLETED');
    expect(wp.media.size).toBe(3); // no duplicate media on retry
  });

  it('earlier tool: the featured prompt carries the short title; a picture handed back twice is asked once more in a new chat; every picture gets the logo', async () => {
    const red = await solid(200, 40, 40);
    const green = await solid(40, 160, 60);
    const blue = await solid(40, 60, 200);
    const prompts: string[] = [];
    // ChatGPT hands back the featured picture again for BODY1 (seen in the earlier tool); the second try is new.
    const answers = [red, red, green, blue];
    const answer = (stageKey: string, prompt: string, language: 'en' | 'de', keyword: string) => {
      if (/Create this image now/.test(prompt)) {
        prompts.push(prompt);
        return { text: '', images: [answers[prompts.length - 1] ?? blue] };
      }
      return cannedAnswer(stageKey, prompt, language, keyword);
    };
    const site = await offlineSite('Repeat Blog');
    await addLogo(site.id);
    const driver = makeDriver(client, answer);
    const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword: 'How to Install WordPress', websiteId: site.id, options: { saveToWordPress: false }, idempotencyKey: 'img:repeat-1' }, { source: 'SINGLE' });
    const t = await driver.drive(task.id);
    const data = await stageData(t.id, 'IMAGES');
    expect(prompts[0]).toMatch(/spelled exactly: "How to Install WordPress"/);
    expect(prompts, data.notes.join(" | ")).toHaveLength(4);
    expect(data.notes.join(' ')).toMatch(/ChatGPT handed back (an earlier picture|no picture)[^;]* for BODY\d; it was asked once more in a new chat/);
    expect(data.slots.map((x: { slot: string }) => x.slot)).toEqual(['FEATURED', 'BODY1', 'BODY2']);
    expect(new Set(data.slots.flatMap((x: { sourceAssetIds: string[] }) => x.sourceAssetIds)).size).toBe(3);
    // The logo (teal plate) sits in the corner of the featured and the body pictures.
    for (const x of data.slots) {
      const a = await client.mediaAsset.findUniqueOrThrow({ where: { id: x.mediaAssetId } });
      const buf = fs.readFileSync(path.join(process.env.BAS_DATA_DIR!, a.filePath));
      const { data: px, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const at = (fx: number, fy: number) => { const i = (Math.round(fy * info.height) * info.width + Math.round(fx * info.width)) * 3; return [px[i], px[i + 1], px[i + 2]]; };
      expect(near(at(0.92, 0.92), [15, 118, 110], 60), `${x.slot} logo corner`).toBe(true);
    }
  });

  it('lost upload answers are found again by slug (no duplicate media) and unusable alt text is replaced', async () => {
    const wp = await startFakeWordPress({ dropMediaAcks: 2 });
    servers.push(wp);
    const site = await loggedInSite(wp, 'Lossy Blog');
    const colors = [await solid(200, 40, 40), await solid(40, 160, 60), await solid(40, 60, 200)];
    let gen = 0;
    const answer = (stageKey: string, prompt: string, language: 'en' | 'de', keyword: string) => {
      if (/Plan 3 images/.test(prompt)) return `FEATURED: A laptop on a desk | ALT: IMG_2041.jpg\nBODY1: A setup wizard | ALT: Image of setup wizard steps in a browser\nBODY2: The same wizard again | ALT: image of setup wizard steps in a browser`;
      if (/Create this image now/.test(prompt)) return { text: 'Here is the image.', images: [colors[gen++ % 3]] };
      return cannedAnswer(stageKey, prompt, language, keyword);
    };
    const driver = makeDriver(client, answer);
    const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword: 'How to Install WordPress', secondaryKeywords: 'hosting', websiteId: site.id, idempotencyKey: 'img:lossy-1' }, { source: 'SINGLE' });
    const t = await driver.drive(task.id);
    expect(t.status, t.reviewReasons).toBe('COMPLETED');
    const data = await stageData(t.id, 'IMAGES');
    const alts = data.slots.map((s: { alt: string }) => s.alt);
    expect(alts[0]).toBe(t.selectedTitle); // a file name is no alt text: the article title is used
    expect(alts[1]).toBe('Setup wizard steps in a browser'); // “Image of …” dropped
    expect(alts[2]).toBe('How to Install WordPress: article image 3'); // the same text twice → neutral fallback
    expect(data.notes.join(' ')).toMatch(/FEATURED alt text: looks like a file name/);
    expect(data.notes.join(' ')).toMatch(/BODY2 alt text: .*same text as another image/);
    // The first two uploads reached WordPress but their answers were lost: found by slug, not uploaded again.
    const uploads = wp.requests.filter((r) => r.method === 'POST' && /\/wp\/v2\/media$/.test(decodeURIComponent(r.path).split('?')[0]));
    expect(uploads).toHaveLength(3);
    expect(wp.media.size).toBe(3);
    expect(new Set([...wp.media.values()].map((m) => m.alt))).toEqual(new Set(alts));
    expect((await stageData(t.id, 'WORDPRESS_DRAFT')).media).toEqual({ uploaded: 1, reused: 0, adopted: 2, failed: 0 });
    const post = [...wp.posts.values()][0];
    expect((post.content.match(/<!-- wp:image \{"id":\d+/g) ?? []).length).toBe(2);
    const assets = await client.mediaAsset.findMany({ where: { taskId: t.id, role: { in: ['FEATURED', 'BODY1', 'BODY2'] }, status: 'UPLOADED' } });
    expect(assets).toHaveLength(3);
    expect(assets.every((a) => a.uploadStartedAt === null && a.wpMediaId)).toBe(true);
    const health = await client.siteHealthObservation.findMany({ where: { websiteId: site.id, kind: { in: ['MEDIA_UPLOAD', 'DRAFT_SAVE'] } } });
    expect(health.map((h) => [h.kind, h.status]).sort()).toEqual([['DRAFT_SAVE', 'OK'], ['MEDIA_UPLOAD', 'OK']]);
  });

  it('celebrity article: bounded Commons gallery, logos/small files/duplicates/near-duplicate crops skipped, distinct photos per slot', async () => {
    const a = await solid(180, 90, 60);
    const b = await solid(60, 110, 170);
    const c = await solid(120, 160, 80);
    const bCrop = await sharp(b).extract({ left: 40, top: 30, width: 1520, height: 1010 }).resize(1600, 1067).jpeg({ quality: 80 }).toBuffer();
    files.set('a.jpg', a).set('a-copy.jpg', a).set('b.jpg', b).set('b-crop.jpg', bCrop).set('c.jpg', c).set('logo.jpg', await solid(0, 0, 0)).set('small.jpg', await solid(9, 9, 9, 300, 200));
    commonsPages = [
      page('Tom Kaulitz 2019.jpg', 'a.jpg', 1600, 1067),
      page('Tom Kaulitz (cropped).jpg', 'a-copy.jpg', 1600, 1067),
      page('Tom Kaulitz Heidi Klum 2022.jpg', 'b.jpg', 1600, 1067),
      page('Tom Kaulitz Heidi Klum 2022 crop.jpg', 'b-crop.jpg', 1600, 1067),
      page('Tom Kaulitz Tokio Hotel concert.jpg', 'c.jpg', 1600, 1067),
      page('Tokio Hotel logo.jpg', 'logo.jpg', 1600, 1067),
      page('Tom Kaulitz small.jpg', 'small.jpg', 300, 200),
    ];
    const site = await offlineSite('Celeb Images');
    await addLogo(site.id);
    const driver = makeDriver(client);
    const cat = await client.category.findFirstOrThrow({ where: { websiteId: site.id } });
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Tom Kaulitz Heidi Klum', websiteId: site.id, categoryId: cat.id, options: { saveToWordPress: false }, idempotencyKey: 'img:celeb-1' }, { source: 'SINGLE' });
    const t = await driver.drive(task.id);
    const data = await stageData(t.id, 'IMAGES');
    const notes = data.notes.join(' | ');
    expect(notes).toMatch(/logo/);
    expect(notes).toMatch(/too small/);
    expect(notes).toMatch(/exact duplicate/);
    expect(notes).toMatch(/crop of/);
    expect(data.slots.map((s: { slot: string }) => s.slot)).toEqual(['FEATURED', 'BODY1', 'BODY2']);
    const sources = data.slots.flatMap((s: { sourceAssetIds: string[] }) => s.sourceAssetIds);
    expect(new Set(sources).size).toBe(sources.length);
    const gallery = await client.mediaAsset.findMany({ where: { taskId: t.id, origin: 'WIKIMEDIA' } });
    expect(gallery.every((g) => g.sourceUrl?.includes('commons.wikimedia.org'))).toBe(true);
    expect(t.assembledHtml).toContain('alt="Photo of Tom Kaulitz"');
  });

  it('celebrity article, ChatGPT image search (owner’s earlier tool): gallery pictures and downloaded links, thumbnails skipped, distinct photos per slot', async () => {
    const { updateSettings } = await import('@/lib/settings');
    await updateSettings({ seo: { celebrityPhotoSource: 'chatgpt' } });
    try {
      files.set('news-photo.jpg', await solid(30, 140, 200));
      const pictures = [await solid(200, 60, 60), await solid(60, 200, 60), await solid(10, 10, 10, 240, 135)];
      const searches: string[] = [];
      const answer = (stageKey: string, prompt: string, language: 'en' | 'de', keyword: string): ScriptedAnswer => {
        if (/show them as an image gallery/.test(prompt)) {
          searches.push(prompt);
          return { text: 'Here are recent photos.', images: pictures, imageLinks: [{ url: `http://news.example:${PORT}/news-photo.jpg`, width: 1600, height: 1067 }] };
        }
        return cannedAnswer(stageKey, prompt, language, keyword);
      };
      const site = await offlineSite('Celeb Gallery');
      await addLogo(site.id);
      // Each new chat reports its own conversation, like ChatGPT does; follow-up prompts report the chat they went to.
      const ARTICLE_CHAT = 'https://chatgpt.com/c/aaaaaaaa-2222-4333-8444-555555555555';
      const GALLERY_CHAT = 'https://chatgpt.com/c/bbbbbbbb-2222-4333-8444-555555555555';
      const claimed: { stageKey: string; newChat: boolean; conversationUrl: string | null }[] = [];
      const driver = makeDriver(client, answer, {
        onClaim: (p) => void claimed.push({ stageKey: p.stageKey, newChat: p.newChat, conversationUrl: p.conversationUrl }),
        conversationFor: (p) => (p.stageKey === 'IMAGES' ? GALLERY_CHAT : (p.conversationUrl ?? ARTICLE_CHAT)),
      });
      const cat = await client.category.findFirstOrThrow({ where: { websiteId: site.id } });
      const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Tom Kaulitz Heidi Klum', websiteId: site.id, categoryId: cat.id, options: { saveToWordPress: false }, idempotencyKey: 'img:celeb-gallery' }, { source: 'SINGLE' });
      const t = await driver.drive(task.id);
      expect(searches).toHaveLength(1);
      expect(searches[0]).toMatch(/real photos of Tom Kaulitz/);
      const data = await stageData(t.id, 'IMAGES');
      const notes = data.notes.join(' | ');
      expect(notes).toMatch(/ChatGPT image search: 3 usable photo\(s\)/);
      expect(notes).toMatch(/1 gallery picture\(s\) downloaded from their links/);
      expect(notes).toMatch(/smaller than 250 px/);
      expect(data.slots.map((s: { slot: string }) => s.slot)).toEqual(['FEATURED', 'BODY1', 'BODY2']);
      const sources = data.slots.flatMap((s: { sourceAssetIds: string[] }) => s.sourceAssetIds);
      expect(new Set(sources).size).toBe(sources.length);
      const linked = await client.mediaAsset.findFirst({ where: { taskId: t.id, origin: 'CHATGPT', sourceUrl: { contains: 'news.example' } } });
      expect(linked).not.toBeNull();
      expect(data.gallery.every((g: { source: string }) => g.source === 'ChatGPT image search')).toBe(true);
      // Commons was not asked (source: ChatGPT gallery only).
      expect(await client.mediaAsset.count({ where: { taskId: t.id, origin: 'WIKIMEDIA' } })).toBe(0);
      // The image search's own chat never becomes the article's chat: every later prompt stays in the article chat.
      const gallery = claimed.findIndex((c) => c.stageKey === 'IMAGES');
      expect(claimed[gallery].newChat).toBe(true);
      const after = claimed.slice(gallery + 1);
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((c) => !c.newChat && c.conversationUrl === ARTICLE_CHAT)).toBe(true);
      expect(t.conversationUrl).toBe(ARTICLE_CHAT);
    } finally {
      await updateSettings({ seo: { celebrityPhotoSource: 'commons' } });
    }
  });

  it('owner report: a text-only image search is asked once more in a new chat; with two photos the two-photo featured template uses both', async () => {
    const { updateSettings } = await import('@/lib/settings');
    const { defaultSiteImageSettings, presetSplit } = await import('@/lib/image-template');
    await updateSettings({ seo: { celebrityPhotoSource: 'chatgpt' } });
    try {
      const pictures = [await solid(200, 60, 60), await solid(60, 200, 60)];
      const searches: { prompt: string; newChat: boolean }[] = [];
      let newChat = false;
      const answer = (stageKey: string, prompt: string, language: 'en' | 'de', keyword: string): ScriptedAnswer => {
        if (/show them as an image gallery/.test(prompt)) {
          searches.push({ prompt, newChat });
          // As for Dixie Brubaker: the first answer is text only.
          if (searches.length === 1) return { text: 'I couldn’t find 10 authentic, recent, high-quality photos reliably identified as this person.' };
          return { text: 'Two archival photos.', images: pictures };
        }
        return cannedAnswer(stageKey, prompt, language, keyword);
      };
      const site = await offlineSite('Celeb Two Photos');
      await addLogo(site.id);
      // The owner's featured design takes two photos.
      const settings = { ...defaultSiteImageSettings('#0b5fff'), featured: { ...presetSplit('#0b5fff'), name: 'Imported' } };
      await client.website.update({ where: { id: site.id }, data: { imageSettings: JSON.stringify(settings) } });
      const driver = makeDriver(client, answer, { onClaim: (p) => void (newChat = p.newChat) });
      const cat = await client.category.findFirstOrThrow({ where: { websiteId: site.id } });
      const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Mary Joan Schutz', websiteId: site.id, categoryId: cat.id, options: { saveToWordPress: false }, idempotencyKey: 'img:celeb-two' }, { source: 'SINGLE' });
      const t = await driver.drive(task.id);
      expect(searches).toHaveLength(2);
      expect(searches.every((s) => s.newChat)).toBe(true);
      expect(searches[0].prompt).toMatch(/archival photos/);
      expect(searches[0].prompt).not.toMatch(/at least 10/);
      const data = await stageData(t.id, 'IMAGES');
      const notes = data.notes.join(' | ');
      expect(notes).toMatch(/asked once more in a new chat/);
      expect(notes).toMatch(/second try, new chat\): 2 usable photo/);
      expect(notes).not.toMatch(/single-photo preset/);
      const featured = data.slots.find((s: { slot: string }) => s.slot === 'FEATURED');
      expect(featured.sourceAssetIds).toHaveLength(2);
      expect(notes).toMatch(/featured design took 2, 0 left for the body/);
      // Tools that are not installed are named, never silently skipped.
      expect(notes).toMatch(/Face detector not installed/);
    } finally {
      await updateSettings({ seo: { celebrityPhotoSource: 'commons' } });
    }
  });

  it('degrades safely: no photos → text-only with a note, or review when images are required', async () => {
    commonsPages = [];
    const site = await offlineSite('No Photos');
    const driver = makeDriver(client);
    const cat = await client.category.findFirstOrThrow({ where: { websiteId: site.id } });
    let t = await driver.drive((await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Unknown Person Example', websiteId: site.id, categoryId: cat.id, options: { saveToWordPress: false }, idempotencyKey: 'img:none-1' }, { source: 'SINGLE' })).task.id);
    let data = await stageData(t.id, 'IMAGES');
    expect(data.slots).toEqual([]);
    expect(data.notes.join(' ')).toMatch(/No usable photo/);
    expect(data.notes.join(' ')).toMatch(/continues without them/);
    expect(t.assembledHtml).not.toContain('<figure');
    await client.website.update({ where: { id: site.id }, data: { settingsOverrides: JSON.stringify({ content: {}, seo: { imagesRequired: true }, workflow: {} }) } });
    t = await driver.drive((await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Another Unknown Example', websiteId: site.id, categoryId: cat.id, options: { saveToWordPress: false }, idempotencyKey: 'img:none-2' }, { source: 'SINGLE' })).task.id);
    expect(t.status).toBe('NEEDS_REVIEW');
    expect(t.reviewReasons).toMatch(/Missing image\(s\): FEATURED, BODY1, BODY2/);
    data = await stageData(t.id, 'IMAGES');
    expect(data).toBeNull();
  });
});

// ---------------------------------------------------------------- designer, uploads, re-runs

const CSRF = 'testtoken1234567890';
type Handler = (req: Request, arg: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** Call a dashboard route handler like the browser does (loopback host, same origin, CSRF double submit). */
async function call(handler: Handler, method: string, url: string, params: Record<string, string>, opts: { json?: unknown; form?: FormData; csrf?: boolean } = {}) {
  const headers: Record<string, string> = { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: `bas_csrf=${CSRF}` };
  if (opts.csrf !== false) headers['x-csrf-token'] = CSRF;
  let body: Uint8Array | string | undefined;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['content-type'] = 'application/json';
  }
  if (opts.form) {
    // Serialize like a browser: multipart body with a declared length.
    const tmp = new Request('http://localhost/', { method: 'POST', body: opts.form });
    body = new Uint8Array(await tmp.arrayBuffer());
    headers['content-type'] = tmp.headers.get('content-type')!;
    headers['content-length'] = String(body.length);
  }
  return handler(new Request(`http://localhost:3000${url}`, { method, headers, body: body as BodyInit | undefined }), { params: Promise.resolve(params) });
}

const fileForm = (fields: Record<string, string>, files: { field: string; name: string; type: string; bytes: Buffer | string }[]) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  for (const f of files) form.append(f.field, new Blob([typeof f.bytes === 'string' ? f.bytes : new Uint8Array(f.bytes)], { type: f.type }), f.name);
  return form;
};

async function colorAt(buf: Buffer, x: number, y: number) {
  const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}
const near = (a: number[], b: number[], tol: number) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

describe('Image Template Designer, owner photos and re-runs', () => {
  let site: Website;
  let fixedId = '';
  let logoId = '';

  it('saves validated templates (SVG sanitized, unknown assets refused), uploads logos/photos with CSRF, and previews through the production renderer', async () => {
    site = await offlineSite('Brand Site');
    const tplRoute = await import('../../app/api/websites/[id]/image-templates/route');
    const assetRoute = await import('../../app/api/websites/[id]/image-assets/route');
    const previewRoute = await import('../../app/api/websites/[id]/image-templates/preview/route');
    const p = { id: site.id };
    const svgLogo = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="160" onload="alert(1)"><script>alert(2)</script><rect width="400" height="160" fill="#ff00ff"/><image href="https://evil.example/x.png"/></svg>';

    // CSRF and multipart are enforced.
    const noCsrf = await call(assetRoute.POST, 'POST', `/api/websites/${site.id}/image-assets`, p, { form: fileForm({ role: 'LOGO' }, [{ field: 'file', name: 'logo.svg', type: 'image/svg+xml', bytes: svgLogo }]), csrf: false });
    expect(noCsrf.status).toBe(403);
    const notImage = await call(assetRoute.POST, 'POST', `/api/websites/${site.id}/image-assets`, p, { form: fileForm({ role: 'LOGO' }, [{ field: 'file', name: 'x.txt', type: 'text/plain', bytes: 'hello' }]) });
    expect(notImage.status).toBe(400);
    expect((await notImage.json()).error.message).toMatch(/PNG, JPEG, WebP or GIF/);

    // SVG logo: sanitized and rasterized; the stored file holds pixels, not markup.
    const logoRes = await call(assetRoute.POST, 'POST', `/api/websites/${site.id}/image-assets`, p, { form: fileForm({ role: 'LOGO' }, [{ field: 'file', name: 'logo.svg', type: 'image/svg+xml', bytes: svgLogo }]) });
    expect(logoRes.status).toBe(200);
    logoId = (await logoRes.json()).asset.id;
    const logo = await client.mediaAsset.findUniqueOrThrow({ where: { id: logoId } });
    expect(logo).toMatchObject({ role: 'LOGO', mime: 'image/webp', websiteId: site.id, taskId: null });
    const { fromDataRelative } = await import('@/lib/paths');
    const logoBytes = fs.readFileSync(fromDataRelative(logo.filePath));
    expect(logoBytes.toString('latin1')).not.toMatch(/script|alert/);
    expect(near(await colorAt(logoBytes, 200, 80), [255, 0, 255], 8)).toBe(true);

    const fixedRes = await call(assetRoute.POST, 'POST', `/api/websites/${site.id}/image-assets`, p, { form: fileForm({ role: 'TEMPLATE_PHOTO' }, [{ field: 'file', name: 'texture.png', type: 'image/png', bytes: await sharp({ create: { width: 600, height: 600, channels: 3, background: { r: 0, g: 200, b: 0 } } }).png().toBuffer() }]) });
    fixedId = (await fixedRes.json()).asset.id;

    const { presetSingle } = await import('@/lib/image-template');
    const base = presetSingle('#ff6600');
    const bad = await call(tplRoute.PUT, 'PUT', `/api/websites/${site.id}/image-templates`, p, { json: { settings: { featured: { ...base, layers: [...base.layers, { id: 'fx', type: 'fixed-photo', assetId: 'not-this-site', x: 0, y: 0, width: 400, height: 400 }] }, body: null, logoAssetId: logoId } } });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toMatch(/Unknown image asset/);

    const featured = {
      ...base,
      layers: [
        ...base.layers,
        { id: 'fx', type: 'fixed-photo', assetId: fixedId, x: 0, y: 0, width: 400, height: 400 },
        { id: 'shape', type: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>steal()</script><circle cx="5" cy="5" r="5" fill="#fff" onclick="x()"/></svg>', x: 1700, y: 600, width: 100, height: 100 },
      ],
    };
    const ok = await call(tplRoute.PUT, 'PUT', `/api/websites/${site.id}/image-templates`, p, { json: { settings: { featured, body: null, logoAssetId: logoId } } });
    expect(ok.status).toBe(200);
    const saved = JSON.parse((await client.website.findUniqueOrThrow({ where: { id: site.id } })).imageSettings);
    const svgLayer = saved.featured.layers.find((l: { id: string }) => l.id === 'shape');
    expect(svgLayer.svg).toContain('<circle');
    expect(svgLayer.svg).not.toMatch(/script|steal|onclick/);
    expect(await client.auditLog.count({ where: { action: 'website.image_templates', entityId: site.id } })).toBe(1);

    const got = await (await call(tplRoute.GET, 'GET', `/api/websites/${site.id}/image-templates`, p)).json();
    expect(got.assets.map((a: { id: string }) => a.id).sort()).toEqual([fixedId, logoId].sort());
    expect(got.output).toEqual({ size: '1200x675', maxBytes: 350_000 });

    // Live preview (draft) and the final file through the same renderer.
    const pv = await call(previewRoute.POST, 'POST', `/api/websites/${site.id}/image-templates/preview`, p, { json: { template: saved.featured, kind: 'featured', title: 'A preview title' } });
    expect(pv.headers.get('content-type')).toBe('image/webp');
    const pvBuf = Buffer.from(await pv.arrayBuffer());
    expect(await sharp(pvBuf).metadata()).toMatchObject({ width: 960, height: 540 });
    expect(near(await colorAt(pvBuf, 60, 60), [0, 200, 0], 30)).toBe(true); // fixed photo top-left
    const fin = await call(previewRoute.POST, 'POST', `/api/websites/${site.id}/image-templates/preview`, p, { json: { template: saved.featured, kind: 'featured', title: 'A preview title', final: true } });
    expect([fin.headers.get('X-Image-Width'), fin.headers.get('X-Image-Height')]).toEqual(['1200', '675']);
    expect(Number(fin.headers.get('X-Image-Bytes'))).toBeLessThanOrEqual(Number(fin.headers.get('X-Image-Budget')));
    const clean = await call(previewRoute.POST, 'POST', `/api/websites/${site.id}/image-templates/preview`, p, { json: { template: null, kind: 'body', title: '' } });
    expect(clean.status).toBe(200);
  });

  it('the pipeline renders with the saved template, chosen logo and fixed photos; owner uploads come first; re-runs reuse the gallery; removed photos are never used again', async () => {
    files.set('a.jpg', await solid(180, 90, 60)).set('b.jpg', await solid(60, 110, 170)).set('c.jpg', await solid(120, 160, 80));
    commonsPages = [page('Tom Kaulitz 2019.jpg', 'a.jpg', 1600, 1067), page('Tom Kaulitz Heidi Klum 2022.jpg', 'b.jpg', 1600, 1067), page('Tom Kaulitz Tokio Hotel concert.jpg', 'c.jpg', 1600, 1067)];
    const driver = makeDriver(client);
    const cat = await client.category.findFirstOrThrow({ where: { websiteId: site.id } });
    const { task } = await create.createArticleTask({ moduleKey: 'celebrity-writer', keyword: 'Tom Kaulitz Heidi Klum', websiteId: site.id, categoryId: cat.id, options: { saveToWordPress: false }, idempotencyKey: 'img:brand-1' }, { source: 'SINGLE' });
    let t = await driver.drive(task.id);
    let data = await stageData(t.id, 'IMAGES');
    expect(data.slots.map((s: { slot: string }) => s.slot)).toEqual(['FEATURED', 'BODY1', 'BODY2']);
    expect(data.notes.join(' ')).not.toMatch(/No site logo/);
    const { fromDataRelative } = await import('@/lib/paths');
    const featuredFile = async (d: { slots: { slot: string; mediaAssetId: string }[] }) => fs.readFileSync(fromDataRelative((await client.mediaAsset.findUniqueOrThrow({ where: { id: d.slots.find((s) => s.slot === 'FEATURED')!.mediaAssetId } })).filePath));
    expect(near(await colorAt(await featuredFile(data), 60, 60), [0, 200, 0], 30)).toBe(true); // fixed photo from the saved template

    // Owner upload through the Images tab route, then regenerate.
    const imagesRoute = await import('../../app/api/tasks/[id]/images/route');
    const up = await call(imagesRoute.POST, 'POST', `/api/tasks/${t.id}/images`, { id: t.id }, { form: fileForm({}, [{ field: 'files', name: 'my-photo.jpg', type: 'image/jpeg', bytes: await solid(230, 30, 200) }]) });
    expect(up.status).toBe(200);
    const [uploadId] = (await up.json()).added;
    const again = await call(imagesRoute.POST, 'POST', `/api/tasks/${t.id}/images`, { id: t.id }, { form: fileForm({}, [{ field: 'files', name: 'same.jpg', type: 'image/jpeg', bytes: await solid(230, 30, 200) }]) });
    expect((await again.json()).skipped[0]).toMatch(/already in this article/);
    await actions.regenerateStage(t.id, 'IMAGES');
    t = await driver.drive(t.id);
    data = await stageData(t.id, 'IMAGES');
    expect(data.slots[0].sourceAssetIds[0]).toBe(uploadId);
    expect(data.slots).toHaveLength(3); // the Commons photos from the first run are reused, not dropped as duplicates
    expect(data.notes.join(' ')).not.toMatch(/exact duplicate/);
    expect(await client.mediaAsset.count({ where: { taskId: t.id, origin: 'WIKIMEDIA' } })).toBe(3); // nothing downloaded twice

    // “Don’t use” a gallery photo: it never comes back on the next run.
    const removedId = data.slots.find((s: { slot: string }) => s.slot === 'BODY1').sourceAssetIds[0];
    const removeRoute = await import('../../app/api/tasks/[id]/images/[assetId]/route');
    expect((await call(removeRoute.DELETE, 'DELETE', `/api/tasks/${t.id}/images/${removedId}`, { id: t.id, assetId: removedId })).status).toBe(200);
    await actions.regenerateStage(t.id, 'IMAGES');
    t = await driver.drive(t.id);
    data = await stageData(t.id, 'IMAGES');
    expect(data.slots.flatMap((s: { sourceAssetIds: string[] }) => s.sourceAssetIds)).not.toContain(removedId);
    expect(data.notes.join(' ')).toMatch(/removed by you earlier/);
    // The only review reason is the switched-off WordPress step — nothing about images.
    expect(JSON.parse(t.reviewReasons)).toEqual(['WordPress draft not created (turned off for this task).']);
  });

  it('general article: owner uploads fill the slots and nothing is generated for them', async () => {
    const generated: string[] = [];
    const answer = (stageKey: string, prompt: string, language: 'en' | 'de', keyword: string) => {
      if (/Plan 3 images/.test(prompt)) return 'FEATURED: Desk | ALT: A tidy desk with a laptop\nBODY1: Browser | ALT: A browser with a setup wizard\nBODY2: Checklist | ALT: A checklist on a clipboard';
      if (/Create this image now/.test(prompt)) {
        generated.push(prompt);
        return { text: 'Here is the image.', images: [] };
      }
      return cannedAnswer(stageKey, prompt, language, keyword);
    };
    const driver = makeDriver(client, answer);
    const { task } = await create.createArticleTask({ moduleKey: 'tigram-writer', keyword: 'How to Install WordPress', websiteId: site.id, options: { saveToWordPress: false }, idempotencyKey: 'img:own-1' }, { source: 'SINGLE' });
    const { addOwnerImages } = await import('@/lib/tasks/images');
    const added = await addOwnerImages(task.id, [
      { name: 'one.jpg', bytes: await solid(250, 200, 10) },
      { name: 'two.jpg', bytes: await solid(10, 200, 250) },
      { name: 'three.jpg', bytes: await solid(120, 20, 90) },
    ]);
    expect(added.added).toHaveLength(3);
    const t = await driver.drive(task.id);
    const data = await stageData(t.id, 'IMAGES');
    expect(generated).toHaveLength(0);
    expect(data.slots.map((s: { sourceAssetIds: string[] }) => s.sourceAssetIds[0])).toEqual(added.added);
    expect(data.slots.map((s: { alt: string }) => s.alt)).toEqual(['A tidy desk with a laptop', 'A browser with a setup wizard', 'A checklist on a clipboard']);
  });
});
