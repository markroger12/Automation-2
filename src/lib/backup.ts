import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { dataDir, dataPaths, safeJoin } from './paths';

export interface BackupManifest {
  createdAt: string;
  reason: string;
  database: string;
  media: boolean;
  appVersion: string;
}

function stamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * Consistent online backup with `VACUUM INTO` (safe while the worker writes,
 * WAL included). Optionally copies generated media. Profile directories are
 * credentials and are never included.
 */
export async function createBackup(client: PrismaClient, reason: string, options: { media?: boolean } = {}): Promise<string> {
  const dir = path.join(dataPaths.backups(), `${stamp()}-${reason.replace(/[^a-z0-9-]+/gi, '-').slice(0, 40)}`);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'app.db');
  const sqlPath = target.split(path.sep).join('/').replace(/'/g, "''");
  await client.$executeRawUnsafe(`VACUUM INTO '${sqlPath}'`);
  if (options.media && fs.existsSync(dataPaths.media())) {
    fs.cpSync(dataPaths.media(), path.join(dir, 'media'), { recursive: true });
  }
  const manifest: BackupManifest = { createdAt: new Date().toISOString(), reason, database: 'app.db', media: Boolean(options.media), appVersion: '3.0.0' };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

export function listBackups(): { name: string; manifest: BackupManifest | null; sizeBytes: number }[] {
  if (!fs.existsSync(dataPaths.backups())) return [];
  return fs
    .readdirSync(dataPaths.backups(), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(dataPaths.backups(), d.name);
      let manifest: BackupManifest | null = null;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
      } catch {
        manifest = null;
      }
      let sizeBytes = 0;
      try {
        sizeBytes = fs.statSync(path.join(dir, 'app.db')).size;
      } catch {
        sizeBytes = 0;
      }
      return { name: d.name, manifest, sizeBytes };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * Restore a backup into data/app.db. Must run with the dashboard and worker
 * stopped. The current database is first moved aside (never deleted).
 */
export function restoreBackup(name: string): { restoredFrom: string; previousSavedAs: string | null } {
  const dir = safeJoin(dataPaths.backups(), name);
  const source = path.join(dir, 'app.db');
  if (!fs.existsSync(source)) throw new Error(`Backup "${name}" has no app.db`);
  const db = dataPaths.db();
  let previous: string | null = null;
  if (fs.existsSync(db)) {
    previous = path.join(dataDir(), `app.db.before-restore-${stamp()}`);
    fs.renameSync(db, previous);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(db + suffix)) fs.renameSync(db + suffix, previous + suffix);
    }
  }
  fs.copyFileSync(source, db);
  if (fs.existsSync(path.join(dir, 'media'))) {
    fs.cpSync(path.join(dir, 'media'), dataPaths.media(), { recursive: true, force: false, errorOnExist: false });
  }
  return { restoredFrom: dir, previousSavedAs: previous };
}
