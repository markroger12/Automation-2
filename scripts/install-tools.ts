/**
 * npm run tools:install — optional image tools from the owner's earlier tool (articles never stop when they are missing):
 *  - MediaPipe BlazeFace (face locations) → data/tools/mediapipe
 *  - Upscayl (upscaling soft or small pictures) → data/tools/upscayl (manual download, see below)
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

import { mediapipeDir } from '../src/images/faces';
import { upscaylDir } from '../src/images/upscale';

const MP_DIR = mediapipeDir();
const UP_DIR = upscaylDir();
const MP_VERSION = process.env.MEDIAPIPE_VERSION || '0.10.21';
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

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
}

async function main() {
  try {
    await installMediapipe();
  } catch (err) {
    console.warn(`MediaPipe was not installed: ${(err as Error).message}`);
  }
  fs.mkdirSync(path.join(UP_DIR, 'models'), { recursive: true });
  const bin = path.join(UP_DIR, process.platform === 'win32' ? 'upscayl-bin.exe' : 'upscayl-bin');
  if (fs.existsSync(bin)) console.log('Upscayl found.');
  else {
    console.log(`Upscayl (optional): download upscayl-ncnn from https://github.com/upscayl/upscayl-ncnn/releases and put
  ${bin}
  ${path.join(UP_DIR, 'models', 'remacri-4x.param')}
  ${path.join(UP_DIR, 'models', 'remacri-4x.bin')}
(the remacri-4x model files come with the Upscayl app: resources/models).`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) void main();
