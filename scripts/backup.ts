/**
 * npm run db:backup [-- --media]
 * Consistent SQLite backup (VACUUM INTO) into data/backups/<timestamp>/.
 * Browser profile folders are credentials and are never included.
 */
import path from 'node:path';
import { loadEnv } from '../src/lib/env';
import { projectRoot } from '../src/lib/paths';

async function main() {
  loadEnv();
  const { db } = await import('../src/lib/db');
  const { createBackup } = await import('../src/lib/backup');
  try {
    const dir = await createBackup(db, 'manual', { media: process.argv.includes('--media') });
    console.log(`✔ Backup created: ${path.relative(projectRoot(), dir)}`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error('✖ Backup failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
