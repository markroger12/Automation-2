import { createHash } from 'node:crypto';
import { dataDir } from './paths';

/**
 * Which tool this is and which data folder it runs on, without naming the folder (owner request: the desktop app
 * never stops at “port 3000 is already in use”). The desktop app asks the local ports: a dashboard of this tool on
 * the same data folder (e.g. `npm run start:all`) is shown as it is instead of starting a second copy.
 */
export const INSTANCE_APP = 'blog-automation-studio';

export function dataFolderId(dir: string = dataDir()): string {
  const resolved = process.platform === 'win32' ? dir.toLowerCase() : dir;
  return createHash('sha256').update(resolved.replace(/[\\/]+$/, '')).digest('hex').slice(0, 16);
}

export function instanceInfo(): { app: string; dataId: string } {
  return { app: INSTANCE_APP, dataId: dataFolderId() };
}
