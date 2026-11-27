import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import sharp from 'sharp';
import { dataPaths } from '../lib/paths';
import { displayScale } from './measure';

/**
 * The photo enhancer of the owner's earlier tool (markroger12/automation-old, images/enhance.ts): Upscayl's
 * command-line tool with the remacri-4x model, in data/tools/upscayl (or one folder below, as its zip unpacks).
 * A photo its place would stretch more than 2× is enlarged 4× first; a soft photo is sharpened even when it is big
 * enough — it goes in at a quarter of the size it is shown at, so the model draws the lost edges anew. remacri-4x
 * was the owner's choice: of the models compared it changed faces least. `npm run tools:install` (also run by
 * `npm run start:all`) downloads the pinned release and checks its SHA-256. Without the tool, or when it fails, the
 * built-in sharpener below is used instead of a plain stretch (owner report: blurry photos).
 */
export const upscaylDir = () => path.join(dataPaths.tools(), 'upscayl');
/** Below 2× it barely shows, and the time grows with the picture (231 s for 1200×628 on an Intel UHD 630). */
export const ENHANCE_ABOVE_SCALE = 2;
/**
 * The built-in sharpener takes well under a second, so it also works on photos stretched less than that (owner report:
 * a 512-pixel photo in a half of the two-photo design is stretched 1.98× and looked blurry, and nothing was done).
 */
export const SHARPEN_ABOVE_SCALE = 1.3;
const MODEL = 'remacri-4x';
const TIMEOUT_MS = 5 * 60_000;

export interface EnhancerTool {
  command: string;
  models: string;
  /** Put before the tool's own arguments (a test runs a script through node). */
  prefix?: string[];
}

export function findEnhancer(root = upscaylDir()): EnhancerTool | null {
  const exe = process.platform === 'win32' ? 'upscayl-bin.exe' : 'upscayl-bin';
  const folders = [root];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) if (entry.isDirectory() && entry.name !== 'models') folders.push(path.join(root, entry.name));
  } catch {
    return null;
  }
  for (const folder of folders) {
    const command = path.join(folder, exe);
    const models = path.join(folder, 'models');
    if (fs.existsSync(command) && fs.existsSync(path.join(models, `${MODEL}.bin`)) && fs.existsSync(path.join(models, `${MODEL}.param`))) return { command, models };
  }
  return null;
}

export function upscalerAvailable(): boolean {
  return findEnhancer() !== null;
}

// The graphics chip handles one picture at a time.
let queue: Promise<unknown> = Promise.resolve();

function run(tool: EnhancerTool, input: string, output: string): Promise<void> {
  const args = [...(tool.prefix ?? []), '-i', input, '-o', output, '-n', MODEL, '-s', '4', '-m', tool.models, '-f', 'png'];
  const job = queue.then(
    () =>
      new Promise<void>((resolve, reject) => {
        execFile(tool.command, args, { timeout: TIMEOUT_MS, windowsHide: true, cwd: path.dirname(tool.command) }, (err, _stdout, stderr) => {
          if (err) {
            const detail = String(stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ');
            reject(new Error(err.killed ? `took longer than ${TIMEOUT_MS / 60_000} minutes` : detail || err.message));
          } else resolve();
        });
      }),
  );
  queue = job.catch(() => undefined);
  return job;
}

/**
 * Without Upscayl (not installed yet, or it failed): the photo is enlarged here in steps of 2× (Lanczos, with a light
 * unsharp mask after each), then to its size in its place, and sharpened once more. It cannot draw detail that is not
 * there as the AI model does, but edges stay crisp instead of the soft look of one plain stretch. Compared on real
 * photos of people (Wikimedia Commons) against one plain stretch and one single sharpen; this looked the most natural.
 * A soft photo that is big enough is only sharpened, at its own size.
 */
export async function enhanceLocally(buf: Buffer, scale: number, stretched: boolean): Promise<Buffer> {
  const upright = await sharp(buf).rotate().png().toBuffer();
  if (!stretched) return sharp(upright).sharpen({ sigma: 1, m1: 0.5, m2: 2 }).png().toBuffer();
  const meta = await sharp(upright).metadata();
  const factor = Math.min(4, scale);
  const target = { width: Math.round((meta.width ?? 1) * factor), height: Math.round((meta.height ?? 1) * factor) };
  let current = upright;
  let w = meta.width ?? 1;
  let h = meta.height ?? 1;
  while (w * 2 < target.width) {
    w *= 2;
    h *= 2;
    current = await sharp(current).resize(w, h, { kernel: 'lanczos3' }).sharpen({ sigma: 0.8, m1: 0.4, m2: 1.5 }).png().toBuffer();
  }
  return sharp(current).resize(target.width, target.height, { kernel: 'lanczos3' }).sharpen({ sigma: 1, m1: 0.5, m2: 2 }).png().toBuffer();
}

/**
 * The picture to render in this place: an enlarged (or sharpened) copy when needed, else null. Never throws — a
 * missing or failing tool falls back to the built-in sharpener, and the note says which was used and why.
 */
export async function enhancePhoto(
  buf: Buffer,
  place: { width: number; height: number },
  soft: boolean,
  tool: EnhancerTool | null = findEnhancer(),
): Promise<{ buffer: Buffer | null; note: string | null }> {
  const meta = await sharp(buf).rotate().metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) return { buffer: null, note: null };
  const scale = displayScale({ width, height }, place);
  const stretched = scale > ENHANCE_ABOVE_SCALE;
  const name = `${width}×${height}`;
  if (!stretched && !soft) {
    if (scale <= SHARPEN_ABOVE_SCALE) return { buffer: null, note: null };
    // A little stretched: the built-in sharpener only (Upscayl would take minutes for a change that barely shows).
    try {
      return { buffer: await enhanceLocally(buf, scale, true), note: `A ${name} photo is stretched ${scale.toFixed(1)}×; it was enlarged with the built-in sharpener.` };
    } catch {
      return { buffer: null, note: null };
    }
  }
  const why = stretched ? `stretched ${scale.toFixed(1)}×` : 'soft';
  const done = stretched ? 'enlarged' : 'sharpened';
  const local = async (reason: string) => {
    try {
      return { buffer: await enhanceLocally(buf, scale, stretched), note: `${reason}, so it was ${done} with the built-in sharpener (less detail than Upscayl).` };
    } catch (err) {
      return { buffer: null, note: `${reason}, and the built-in sharpener failed too (${(err as Error).message.slice(0, 80)}); the original was used.` };
    }
  };
  if (!tool) return local(`A ${name} photo is ${why}; Upscayl (${MODEL}) is not installed yet (npm run start:all or npm run tools:install installs it)`);
  const cacheDir = path.join(dataPaths.tools(), 'cache', 'upscale');
  fs.mkdirSync(cacheDir, { recursive: true });
  const key = crypto.createHash('sha256').update(buf).update(stretched ? 'x' : `soft:${Math.round(place.width)}x${Math.round(place.height)}`).digest('hex');
  const output = path.join(cacheDir, `${key}.png`);
  if (fs.existsSync(output)) return { buffer: await fs.promises.readFile(output), note: `A ${name} photo (${why}) was enhanced with Upscayl (cached).` };
  const input = path.join(cacheDir, `${key}-in.png`);
  let source = sharp(buf).rotate();
  if (!stretched) source = source.resize(Math.max(160, Math.round((width * scale) / 4)), Math.max(90, Math.round((height * scale) / 4)), { fit: 'fill' });
  await fs.promises.writeFile(input, await source.png().toBuffer());
  const started = Date.now();
  try {
    await run(tool, input, output);
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) throw new Error('it wrote no picture');
  } catch (err) {
    fs.rmSync(output, { force: true });
    return local(`Upscayl could not enhance a ${name} photo (${(err as Error).message.slice(0, 120)})`);
  } finally {
    fs.rmSync(input, { force: true });
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  return {
    buffer: await fs.promises.readFile(output),
    note: stretched ? `A ${name} photo was enlarged 4× with Upscayl (${MODEL}) in ${seconds}s (its place stretched it ${scale.toFixed(1)}×).` : `A soft ${name} photo was sharpened with Upscayl (${MODEL}) in ${seconds}s.`,
  };
}
