/**
 * npm run db:migrate — back up the existing database, then apply pending
 * Prisma migrations with `prisma migrate deploy` (never `migrate reset`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PrismaClient } from '@prisma/client';
import { dataPaths, ensureDataDirs, projectRoot, resolveDatabaseUrl } from '../src/lib/paths';
import { loadEnv } from '../src/lib/env';
import { createBackup } from '../src/lib/backup';

async function pendingMigrations(client: PrismaClient): Promise<string[]> {
  const dir = path.join(projectRoot(), 'prisma', 'migrations');
  const shipped = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  let applied: string[] = [];
  try {
    const rows = await client.$queryRawUnsafe<{ migration_name: string }[]>(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    applied = rows.map((r) => r.migration_name);
  } catch {
    applied = [];
  }
  return shipped.filter((name) => !applied.includes(name));
}

export async function runMigrations(): Promise<void> {
  loadEnv();
  ensureDataDirs();
  const url = resolveDatabaseUrl();
  const dbFile = url.slice('file:'.length).split('?')[0];
  if (fs.existsSync(dbFile) && fs.statSync(dbFile).size > 0) {
    const client = new PrismaClient({ datasources: { db: { url } } });
    try {
      const pending = await pendingMigrations(client);
      if (pending.length > 0) {
        const dir = await createBackup(client, 'pre-migrate');
        console.log(`  ${pending.length} pending migration(s). Backup saved: ${path.relative(projectRoot(), dir)}`);
      } else {
        console.log('  No pending migrations — no backup needed.');
      }
    } finally {
      await client.$disconnect();
    }
  } else {
    console.log('  No existing database — a new one will be created.');
  }
  const prismaCli = path.join(projectRoot(), 'node_modules', 'prisma', 'build', 'index.js');
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
    cwd: projectRoot(),
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('prisma migrate deploy failed (see output above). Your data was not reset; a backup is in data/backups/.');
  const client = new PrismaClient({ datasources: { db: { url } } });
  try {
    await client.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
  } finally {
    await client.$disconnect();
  }
  console.log(`  Database ready: ${path.relative(projectRoot(), dataPaths.db())}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runMigrations().catch((error) => {
    console.error('✖', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
