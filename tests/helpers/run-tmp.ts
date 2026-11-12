import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * One temporary folder per test run, removed when the run ends. The tests make many temporary data folders
 * (databases, media, copies) and did not remove them, so repeated runs filled the disk with thousands of
 * bas-test-* / bas-isolated-* folders. Every os.tmpdir() of the run's workers now points inside this folder.
 */
export default function setup() {
  const before = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-vitest-run-'));
  process.env.TMPDIR = dir;
  process.env.TMP = dir;
  process.env.TEMP = dir;
  return () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  };
}
