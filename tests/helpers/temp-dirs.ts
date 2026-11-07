import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Temporary folders for tests, removed when the test file ends.
 *
 * tests/helpers/isolate-data.ts (the setup file of every vitest config) calls
 * removeTempDirs() in an afterAll hook. Vitest runs a setup file's afterAll
 * after the test file's own hooks, and after failing tests too. (A process
 * 'exit' hook would not do: vitest ends each test worker with SIGTERM, which
 * skips exit handlers.)
 *
 * Only the exact folders fs.mkdtempSync returned here are removed. Set
 * BAS_KEEP_TEST_DATA=1 to keep them for debugging; their paths are printed.
 */

const dirs: string[] = [];
const releases: (() => unknown)[] = [];

const keepTestData = () => process.env.BAS_KEEP_TEST_DATA === '1';

/** A new empty folder in the system temp directory, removed when this test file ends. */
export function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * Runs before the folders are removed, newest first: close what keeps files
 * open in them (Prisma clients, browsers). Windows cannot delete open files.
 */
export function beforeTempDirsRemoved(release: () => unknown): void {
  releases.push(release);
}

/** Remove one folder made by makeTempDir now. Any other path is ignored. */
export async function removeTempDir(dir: string): Promise<void> {
  const i = dirs.indexOf(dir);
  if (i < 0) return;
  dirs.splice(i, 1);
  if (keepTestData()) {
    console.info(`BAS_KEEP_TEST_DATA=1: kept ${dir}`);
    return;
  }
  await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch((error) => console.warn(`Could not remove test folder ${dir}: ${error}`));
}

/** Run the registered releases, then remove every folder still left from makeTempDir. */
export async function removeTempDirs(): Promise<void> {
  for (const release of releases.splice(0).reverse()) {
    try {
      await release();
    } catch (error) {
      console.warn(`Test cleanup: ${error}`);
    }
  }
  for (const dir of [...dirs].reverse()) await removeTempDir(dir);
}
