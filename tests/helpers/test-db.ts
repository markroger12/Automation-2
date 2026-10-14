import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * Create an isolated SQLite database with all migrations applied and point the
 * app's `db` singleton at it. Call BEFORE importing modules that use `db`.
 */
export async function setupTestDb(): Promise<{ dir: string; file: string; client: PrismaClient }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-test-'));
  const file = path.join(dir, 'app.db').split(path.sep).join('/');
  process.env.BAS_DATA_DIR = dir;
  process.env.DATABASE_URL = `file:${file}`;
  process.env.BAS_QUIET_LOGS = '1';
  const client = new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
  const migrationsDir = path.resolve(__dirname, '..', '..', 'prisma', 'migrations');
  const names = fs.readdirSync(migrationsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const name of names) {
    const sql = fs.readFileSync(path.join(migrationsDir, name, 'migration.sql'), 'utf8');
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter(Boolean);
    for (const statement of statements) await client.$executeRawUnsafe(statement);
  }
  return { dir, file, client };
}
