import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import sharp from 'sharp';
import { dataPaths } from '../lib/paths';

/**
 * Upscayl's upscayl-bin with the remacri-4x model (data/tools/upscayl), as in the owner's earlier tool: small or
 * soft photos are enlarged before they are cropped into a design. Installed by hand (see `npm run tools:install`);
 * missing tool → null and the original photo is used.
 */
export const upscaylDir = () => path.join(dataPaths.tools(), 'upscayl');
const bin = () => path.join(upscaylDir(), process.platform === 'win32' ? 'upscayl-bin.exe' : 'upscayl-bin');
const models = () => path.join(upscaylDir(), 'models');

export function upscalerAvailable(): boolean {
  return fs.existsSync(bin()) && fs.existsSync(path.join(models(), 'remacri-4x.param')) && fs.existsSync(path.join(models(), 'remacri-4x.bin'));
}

let chain: Promise<unknown> = Promise.resolve();

/** One picture at a time (the tool uses the GPU), 5-minute limit, cached by content hash. */
export function upscale(buf: Buffer): Promise<Buffer | null> {
  const run = chain.then(() => doUpscale(buf));
  chain = run.catch(() => undefined);
  return run;
}

async function doUpscale(buf: Buffer): Promise<Buffer | null> {
  if (!upscalerAvailable()) return null;
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const cacheDir = path.join(dataPaths.tools(), 'cache', 'upscale');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cached = path.join(cacheDir, `${hash}.png`);
  if (fs.existsSync(cached)) return fs.promises.readFile(cached);
  const tmpIn = path.join(cacheDir, `${hash}-in.png`);
  await fs.promises.writeFile(tmpIn, await sharp(buf).rotate().png().toBuffer());
  try {
    await new Promise<void>((resolve, reject) => {
      execFile(bin(), ['-i', tmpIn, '-o', cached, '-s', '4', '-m', models(), '-n', 'remacri-4x', '-f', 'png'], { timeout: 5 * 60_000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    });
    return fs.existsSync(cached) ? await fs.promises.readFile(cached) : null;
  } catch {
    return null;
  } finally {
    await fs.promises.rm(tmpIn, { force: true }).catch(() => undefined);
  }
}
