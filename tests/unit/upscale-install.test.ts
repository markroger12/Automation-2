import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';

/**
 * Owner report (a blurry two-photo featured image; the Images tab said “Upscayl (remacri-4x) is not installed — the
 * original was used”): Upscayl was a manual download nobody had done, and without it a small photo was simply
 * stretched. Now `tools:install` (also run by `npm run start:all`) downloads the pinned Upscayl release and the
 * remacri-4x model and checks their SHA-256 before anything is kept, and without Upscayl the photo is enlarged with
 * the built-in sharpener instead of a plain stretch.
 */
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** A small zip writer for the test (deflate), shaped like the release: one folder with the binary and the licence. */
function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const packed = zlib.deflateRawSync(e.data);
    const crc = zlib.crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += local.length + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

let server: http.Server;
let base = '';
const files = new Map<string, Buffer>();
const exe = process.platform === 'win32' ? 'upscayl-bin.exe' : 'upscayl-bin';
const binary = Buffer.from('#!/bin/sh\necho fake upscayl\n');
const release = zip([
  { name: 'upscayl-bin-test/README.md', data: Buffer.from('readme') },
  { name: `upscayl-bin-test/${exe}`, data: binary },
  { name: 'upscayl-bin-test/LICENSE', data: Buffer.from('AGPL-3.0') },
]);
const param = Buffer.from('7767517\n1 1\nInput input.1 0 1 data\n');
const model = crypto.randomBytes(4096);

beforeAll(async () => {
  files.set('/release.zip', release);
  files.set('/models/remacri-4x.param', param);
  files.set('/models/remacri-4x.bin', model);
  server = http.createServer((req, res) => {
    const body = files.get(req.url ?? '');
    res.writeHead(body ? 200 : 404).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const source = () => ({ zipUrl: `${base}/release.zip`, zipSha256: sha(release), exe, modelBase: `${base}/models/`, models: { 'remacri-4x.param': sha(param), 'remacri-4x.bin': sha(model) } });

describe('Upscayl is installed automatically (pinned, checksums verified)', () => {
  it('downloads the release and the remacri-4x model, checks every SHA-256, and the app then finds the tool', async () => {
    const { installUpscayl } = await import('../../scripts/install-tools');
    const { findEnhancer } = await import('@/images/upscale');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-upscayl-'));
    expect(findEnhancer(dir)).toBeNull();
    expect(await installUpscayl({ dir, source: source() })).toMatch(/installed/);
    expect(fs.readFileSync(path.join(dir, exe))).toEqual(binary);
    expect(fs.readFileSync(path.join(dir, 'models', 'remacri-4x.bin'))).toEqual(model);
    expect(fs.existsSync(path.join(dir, 'LICENSE-upscayl.txt'))).toBe(true);
    if (process.platform !== 'win32') expect(fs.statSync(path.join(dir, exe)).mode & 0o111).not.toBe(0);
    expect(findEnhancer(dir)).toMatchObject({ command: path.join(dir, exe) });
    // Already there: nothing is downloaded again.
    files.delete('/release.zip');
    expect(await installUpscayl({ dir, source: source() })).toMatch(/already installed/);
    files.set('/release.zip', release);
  });

  it('a download whose SHA-256 differs is refused and nothing is kept', async () => {
    const { installUpscayl } = await import('../../scripts/install-tools');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-upscayl-'));
    await expect(installUpscayl({ dir, source: { ...source(), zipSha256: 'a'.repeat(64) } })).rejects.toThrow(/SHA-256 .* does not match/);
    expect(fs.existsSync(path.join(dir, exe))).toBe(false);
    await expect(installUpscayl({ dir, source: { ...source(), models: { ...source().models, 'remacri-4x.bin': 'b'.repeat(64) } } })).rejects.toThrow(/remacri-4x\.bin.*does not match/);
    expect(fs.existsSync(path.join(dir, 'models', 'remacri-4x.bin'))).toBe(false);
    expect(fs.existsSync(path.join(dir, exe))).toBe(false);
  });

  it('the pinned release is set for Windows (the owner) and Linux', async () => {
    const { UPSCAYL_SOURCES } = await import('../../scripts/install-tools');
    expect(UPSCAYL_SOURCES.win32).toMatchObject({ exe: 'upscayl-bin.exe', zipSha256: '1f0f65c5d2ade866555e2ac467d35952c35a47080a4060fe56a1ab028f67258a' });
    expect(UPSCAYL_SOURCES.win32!.zipUrl).toBe('https://github.com/upscayl/upscayl-ncnn/releases/download/20251207-174704/upscayl-bin-20251207-174704-windows.zip');
    expect(UPSCAYL_SOURCES.linux!.zipSha256).toBe('a9fab3c770b62f2b7a35d8d6d61eb4e8b3aef79128b665c919d080b85a2292f2');
    expect(UPSCAYL_SOURCES.win32!.models).toEqual({ 'remacri-4x.param': '859ecba5b3592ecf3e76c93bed65e9f627b5236dd696aae5a84ecf8c93ab65ce', 'remacri-4x.bin': 'a43be595c0d743314c30b50fe7ef188be0c61cc55c46ce81adb79ba4b3c3fb7a' });
  });
});

describe('without Upscayl a small photo is enlarged with the built-in sharpener (not a plain stretch)', () => {
  it('a photo its place stretches 2.8× comes back enlarged and crisper than a plain stretch; the note says how', async () => {
    const { enhancePhoto } = await import('@/images/upscale');
    // A real photo (the public-domain portrait of the fixtures) made small, as ChatGPT's small pictures.
    const photo = await sharp(path.resolve(__dirname, '..', 'fixtures', 'images', 'portrait-public-domain.jpg')).resize(512, 341, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
    const place = { width: 1434, height: 955 };
    const r = await enhancePhoto(photo, place, false, null);
    expect(r.buffer).not.toBeNull();
    const meta = await sharp(r.buffer!).metadata();
    expect([meta.width, meta.height]).toEqual([1434, 955]);
    expect(r.note).toMatch(/A 512×341 photo is stretched 2\.8×; Upscayl \(remacri-4x\) is not installed yet .*enlarged with the built-in sharpener/);
    // Crisper edges than one plain stretch to the same size (mean absolute Laplacian, measured here).
    const edges = async (b: Buffer) => {
      const { data } = await sharp(b).greyscale().convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 }).raw().toBuffer({ resolveWithObject: true });
      return data.reduce((a, v) => a + Math.abs(v - 128), 0) / data.length;
    };
    const plain = await sharp(photo).resize(1434, 955).png().toBuffer();
    expect(await edges(r.buffer!)).toBeGreaterThan((await edges(plain)) * 1.2);
  });

  it('a soft photo big enough for its place is sharpened at its own size; a sharp, big photo is left alone', async () => {
    const { enhancePhoto } = await import('@/images/upscale');
    const photo = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#888' } }).jpeg().toBuffer();
    const soft = await enhancePhoto(photo, { width: 1200, height: 675 }, true, null);
    expect((await sharp(soft.buffer!).metadata()).width).toBe(1600);
    expect(soft.note).toMatch(/A 1600×1000 photo is soft; .*sharpened with the built-in sharpener/);
    expect(await enhancePhoto(photo, { width: 1200, height: 675 }, false, null)).toEqual({ buffer: null, note: null });
  });

  it('owner case: a 512-pixel photo in a half of the two-photo design (stretched 1.98×) is enlarged with the built-in sharpener, even with Upscayl installed', async () => {
    const { enhancePhoto } = await import('@/images/upscale');
    const photo = await sharp(path.resolve(__dirname, '..', 'fixtures', 'images', 'portrait-public-domain.jpg')).resize(512, 341, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer();
    // A tool that would fail if it were run: below 2× Upscayl is not used (it takes minutes).
    const tool = { command: path.join(os.tmpdir(), 'no-such-upscayl-bin'), models: os.tmpdir() };
    const r = await enhancePhoto(photo, { width: 600, height: 675 }, false, tool);
    expect(r.note).toBe('A 512×341 photo is stretched 2.0×; it was enlarged with the built-in sharpener.');
    expect((await sharp(r.buffer!).metadata()).height).toBe(675);
    // Barely stretched (1.2×): left as it is.
    expect(await enhancePhoto(photo, { width: 614, height: 409 }, false, tool)).toEqual({ buffer: null, note: null });
  });
});
