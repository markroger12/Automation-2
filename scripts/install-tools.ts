/**
 * npm run tools:install — optional image tools from the owner's earlier tool (articles never stop when they are missing):
 *  - MediaPipe BlazeFace (face locations) → data/tools/mediapipe
 *  - Upscayl (upscaling soft or small pictures) → data/tools/upscayl: the pinned release and the remacri-4x model,
 *    each checked against its SHA-256 before it is kept (owner report: photos were blurry because nobody had done
 *    the manual download)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { mediapipeDir, PERSON_MODEL } from '../src/images/faces';
import { findEnhancer, upscaylDir } from '../src/images/upscale';

const MP_DIR = mediapipeDir();
const UP_DIR = upscaylDir();
const MP_VERSION = process.env.MEDIAPIPE_VERSION || '0.10.21';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
// People (where they stand, never who): EfficientDet-Lite0, 7 MB, version 1 of the float16 model.
const PERSON_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite';

/** Minimal tar reader (ustar + pax path records). */
function* tarEntries(buf: Buffer): Generator<{ name: string; data: Buffer }> {
  let offset = 0;
  let paxPath: string | null = null;
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const str = (start: number, len: number) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 12).trim() || '0', 8);
    const type = str(156, 1);
    const prefix = str(345, 155);
    let name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    const data = buf.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = /\d+ path=([^\n]+)\n/.exec(data.toString('utf8'));
      paxPath = m ? m[1]! : null;
      continue;
    }
    if (paxPath) {
      name = paxPath;
      paxPath = null;
    }
    if (type === '0' || type === '' || type === '\0') yield { name, data };
  }
}

/** Minimal zip reader (stored or deflated entries), enough for the Upscayl release zip. */
export function zipEntries(buf: Buffer): { name: string; data: Buffer }[] {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('broken zip directory');
    const method = buf.readUInt16LE(p + 10);
    const packedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const packed = buf.subarray(start, start + packedSize);
    if (method !== 0 && method !== 8) throw new Error(`zip entry ${name} uses an unsupported compression (${method})`);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(packed) : Buffer.from(packed) });
  }
  return out;
}

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function installMediapipe() {
  fs.mkdirSync(path.join(MP_DIR, 'wasm'), { recursive: true });
  const tgz = await download(`https://registry.npmjs.org/@mediapipe/tasks-vision/-/tasks-vision-${MP_VERSION}.tgz`);
  const tar = zlib.gunzipSync(tgz);
  let n = 0;
  for (const e of tarEntries(tar)) {
    const rel = e.name.replace(/^package\//, '');
    if (rel === 'vision_bundle.mjs' || /^wasm\/vision_wasm_(nosimd_)?internal\.(js|wasm)$/.test(rel)) {
      fs.writeFileSync(path.join(MP_DIR, rel), e.data);
      n++;
    }
  }
  console.log(`MediaPipe tasks-vision ${MP_VERSION}: ${n} files in ${MP_DIR}`);
  const model = path.join(MP_DIR, 'blaze_face_short_range.tflite');
  if (!fs.existsSync(model)) {
    try {
      fs.writeFileSync(model, await download(MODEL_URL));
      console.log('BlazeFace model downloaded.');
    } catch (err) {
      console.warn(`Could not download the face model (${(err as Error).message}). Download it by hand:\n  ${MODEL_URL}\n  → ${model}`);
    }
  }
  const people = path.join(MP_DIR, PERSON_MODEL);
  if (!fs.existsSync(people)) {
    try {
      fs.writeFileSync(people, await download(PERSON_MODEL_URL));
      console.log('Person model downloaded (so people whose face is not found are not cut either).');
    } catch (err) {
      console.warn(`Could not download the person model (${(err as Error).message}); crops use faces only. By hand:\n  ${PERSON_MODEL_URL}\n  → ${people}`);
    }
  }
}

/**
 * Upscayl's command-line tool (upscayl-ncnn, release 20251207-174704, December 2025) and the remacri-4x model files
 * from the Upscayl app (v2.15.0). The SHA-256 values were taken from these exact downloads; a file that differs is
 * refused and nothing is kept. Other systems: download by hand (the message says where).
 */
export interface UpscaylSource {
  zipUrl: string;
  zipSha256: string;
  exe: string;
  modelBase: string;
  models: Record<string, string>;
}
const UPSCAYL_RELEASE = '20251207-174704';
const REMACRI = { 'remacri-4x.param': '859ecba5b3592ecf3e76c93bed65e9f627b5236dd696aae5a84ecf8c93ab65ce', 'remacri-4x.bin': 'a43be595c0d743314c30b50fe7ef188be0c61cc55c46ce81adb79ba4b3c3fb7a' };
const MODEL_BASE = 'https://raw.githubusercontent.com/upscayl/upscayl/v2.15.0/resources/models/';
const releaseZip = (os: string) => `https://github.com/upscayl/upscayl-ncnn/releases/download/${UPSCAYL_RELEASE}/upscayl-bin-${UPSCAYL_RELEASE}-${os}.zip`;
export const UPSCAYL_SOURCES: Partial<Record<NodeJS.Platform, UpscaylSource>> = {
  win32: { zipUrl: releaseZip('windows'), zipSha256: '1f0f65c5d2ade866555e2ac467d35952c35a47080a4060fe56a1ab028f67258a', exe: 'upscayl-bin.exe', modelBase: MODEL_BASE, models: REMACRI },
  linux: { zipUrl: releaseZip('linux'), zipSha256: 'a9fab3c770b62f2b7a35d8d6d61eb4e8b3aef79128b665c919d080b85a2292f2', exe: 'upscayl-bin', modelBase: MODEL_BASE, models: REMACRI },
};

function checked(name: string, data: Buffer, sha256: string): Buffer {
  const got = crypto.createHash('sha256').update(data).digest('hex');
  if (got !== sha256) throw new Error(`the SHA-256 of ${name} (${got}) does not match the pinned one; nothing was installed`);
  return data;
}

/** Downloads, checks and installs Upscayl into data/tools/upscayl. Files are written only after every check passed. */
export async function installUpscayl({ dir = UP_DIR, source = UPSCAYL_SOURCES[process.platform] }: { dir?: string; source?: UpscaylSource } = {}): Promise<string> {
  if (findEnhancer(dir)) return 'Upscayl is already installed.';
  if (!source) {
    return `Upscayl (optional): no pinned download for ${process.platform}. Download upscayl-ncnn from https://github.com/upscayl/upscayl-ncnn/releases and put upscayl-bin and models/remacri-4x.param + .bin in ${dir}.`;
  }
  const zip = checked(path.basename(new URL(source.zipUrl).pathname), await download(source.zipUrl), source.zipSha256);
  const entries = zipEntries(zip);
  const exe = entries.find((e) => path.posix.basename(e.name) === source.exe);
  if (!exe) throw new Error(`${source.exe} is not in the Upscayl download`);
  const licence = entries.find((e) => path.posix.basename(e.name) === 'LICENSE');
  const models: { name: string; data: Buffer }[] = [];
  for (const [name, sha256] of Object.entries(source.models)) models.push({ name, data: checked(name, await download(source.modelBase + name), sha256) });
  fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
  // Written as .part and renamed, so a stopped install never leaves a half file the app would try to run.
  const put = (file: string, data: Buffer, mode?: number) => {
    fs.writeFileSync(`${file}.part`, data, mode ? { mode } : undefined);
    fs.renameSync(`${file}.part`, file);
  };
  for (const m of models) put(path.join(dir, 'models', m.name), m.data);
  if (licence) put(path.join(dir, 'LICENSE-upscayl.txt'), licence.data);
  put(path.join(dir, source.exe), exe.data, 0o755);
  return `Upscayl ${UPSCAYL_RELEASE} with the remacri-4x model installed in ${dir} (checksums verified).`;
}

async function main() {
  try {
    await installMediapipe();
  } catch (err) {
    console.warn(`MediaPipe was not installed: ${(err as Error).message}`);
  }
  try {
    console.log(await installUpscayl());
  } catch (err) {
    console.warn(`Upscayl was not installed: ${(err as Error).message}. Small photos are enlarged with the built-in sharpener meanwhile.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
