import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Loaded before every test file: point the app at a throwaway data directory
 * so no test (or an accidental early import of the database client) can ever
 * read or write the owner's real data/app.db. setupTestDb() replaces it with
 * a migrated database per file.
 */
if (!process.env.BAS_TEST_ISOLATED) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-isolated-'));
  process.env.BAS_DATA_DIR = dir;
  process.env.DATABASE_URL = `file:${path.join(dir, 'app.db').split(path.sep).join('/')}`;
  process.env.BAS_TEST_ISOLATED = '1';
}
