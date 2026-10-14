import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { configureTestBrowser } from '../helpers/browser';
import { startFakeWordPress, type FakeWp } from '../fixtures/fake-wordpress';

/**
 * Vitest compiles TypeScript differently from the worker (tsx/esbuild adds
 * `__name()` around named functions). In-page code must work under the
 * worker's toolchain, so this runs a script with tsx itself.
 */
let wp: FakeWp | null = null;
afterAll(async () => {
  await wp?.close();
});

describe('worker toolchain (tsx)', () => {
  it('functions evaluated in WordPress pages work under tsx; without the app shim they would fail', async () => {
    configureTestBrowser();
    wp = await startFakeWordPress();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-toolchain-'));
    const root = path.resolve(__dirname, '..', '..');
    // Async: the fake WordPress runs in this process and must keep serving while tsx runs.
    const { stdout: out } = await promisify(execFile)(path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx'), [path.join(root, 'tests', 'fixtures', 'in-page-names.mts'), wp.url], {
      cwd: root,
      env: { ...process.env, BAS_DATA_DIR: dataDir, DATABASE_URL: `file:${path.join(dataDir, 'app.db')}` },
      encoding: 'utf8',
      timeout: 90_000,
    });
    const result = JSON.parse(out.trim().split('\n').pop()!);
    expect(result.viaWorkerContext).toEqual({ ok: true, value: 2 });
    expect(result.withoutShim.ok).toBe(false);
    expect(result.withoutShim.error).toMatch(/__name is not defined/);
  });
});
