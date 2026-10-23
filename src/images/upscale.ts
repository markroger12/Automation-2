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
 * was the owner's choice: of the models compared it changed faces least. Without the tool the original is used.
 */
export const upscaylDir = () => path.join(dataPaths.tools(), 'upscayl');
/** Below 2× it barely shows, and the time grows with the picture (231 s for 1200×628 on an Intel UHD 630). */
export const ENHANCE_ABOVE_SCALE = 2;
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
    if (fs.existsSync(command) && fs.existsSync(path.join(models, `${MODEL}.bin`))) return { command, models };
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
 * The picture to render in this place: an enlarged (or sharpened) copy when needed, else null. Never throws — a
 * missing or failing tool leaves the original, and the note says why.
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
  if (!stretched && !soft) return { buffer: null, note: null };
  const name = `${width}×${height}`;
  const why = stretched ? `stretched ${scale.toFixed(1)}×` : 'soft';
  if (!tool) return { buffer: null, note: `A ${name} photo is ${why}, but Upscayl (${MODEL}) is not installed in data\\tools\\upscayl — the original was used.` };
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
    return { buffer: null, note: `Upscayl could not enhance a ${name} photo (${(err as Error).message.slice(0, 120)}); the original was used.` };
  } finally {
    fs.rmSync(input, { force: true });
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  return {
    buffer: await fs.promises.readFile(output),
    note: stretched ? `A ${name} photo was enlarged 4× with Upscayl (${MODEL}) in ${seconds}s (its place stretched it ${scale.toFixed(1)}×).` : `A soft ${name} photo was sharpened with Upscayl (${MODEL}) in ${seconds}s.`,
  };
}
