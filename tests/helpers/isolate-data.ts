import path from 'node:path';
import { afterAll } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { beforeTempDirsRemoved, makeTempDir, removeTempDirs } from './temp-dirs';

/**
 * Loaded before every test file: point the app at a throwaway data directory
 * so no test (or an accidental early import of the database client) can ever
 * read or write the owner's real data/app.db. setupTestDb() replaces it with
 * a migrated database per file.
 */
const isolatedHere = !process.env.BAS_TEST_ISOLATED;
if (isolatedHere) {
  const dir = makeTempDir('bas-isolated-');
  process.env.BAS_DATA_DIR = dir;
  process.env.DATABASE_URL = `file:${path.join(dir, 'app.db').split(path.sep).join('/')}`;
  process.env.BAS_TEST_ISOLATED = '1';
  // No test may reach the internet; tests that need HTTP install a local fake network.
  process.env.BAS_TEST_NO_NETWORK = '1';
}

// The app's `db` singleton (src/lib/db.ts) keeps the test database open: close it before its folder is removed.
beforeTempDirsRemoved(() => (globalThis as { __basPrisma?: PrismaClient }).__basPrisma?.$disconnect());

// Registered first, so it runs after the test file's own afterAll hooks (sequence.hooks "stack"), also after failures.
afterAll(async () => {
  await removeTempDirs();
  // A worker reused for another file (no isolation) makes a new data directory for it.
  if (isolatedHere) delete process.env.BAS_TEST_ISOLATED;
});
