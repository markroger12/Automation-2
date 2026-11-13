import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
// @ts-expect-error -- a plain JavaScript module of the desktop app's build
import { ENTRY_GUARD, devOnly, entryGuardPlugin } from '../../desktop/bundle-rules.mjs';

const root = path.resolve(__dirname, '../..');

/** Owner request (2026-11-12): no lag from the installer on — fewer files to install, nothing the app needs left out. */
describe('files the desktop bundle leaves out', () => {
  it('source maps, TypeScript sources and declarations, read-me files, and top-level test/docs/example folders', () => {
    for (const rel of ['dist/index.js.map', 'index.d.ts', 'dist/types.d.mts', 'lib/x.d.cts', 'src/index.ts', 'README.md', 'CHANGELOG.md', 'docs/guide.html', 'test/a.js', '__tests__/b.js', 'examples/demo.js', '.github/workflows/ci.yml']) {
      expect(devOnly(rel), rel).toBe(true);
    }
  });

  it('keeps what runs: JavaScript, JSON, native files, WebAssembly, licences, and inner folders named like test', () => {
    for (const rel of ['index.js', 'dist/index.mjs', 'dist/index.cjs', 'package.json', 'build/Release/sharp.node', 'query_engine_bg.wasm', 'schema-engine-windows.exe', 'LICENSE.md', 'license', 'dist/test/runtime.js', 'lib/docs.js', 'font.woff2']) {
      expect(devOnly(rel), rel).toBe(false);
    }
  });
});

describe('the compiled worker and start-up steps', () => {
  it('the scripts that start themselves use exactly the test the compiler looks for', () => {
    for (const script of ['scripts/migrate.ts', 'scripts/seed.ts', 'scripts/install-tools.ts']) {
      expect(fs.readFileSync(path.join(root, script), 'utf8'), script).toContain(ENTRY_GUARD);
    }
  });

  it('a script bundled into another never starts itself; the entry still does', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-guard-'));
    try {
      fs.mkdirSync(path.join(dir, 'scripts'));
      const guarded = (what: string) => `import { pathToFileURL } from 'node:url';\nexport const ${what} = 1;\nif (${ENTRY_GUARD}) console.log('${what} started itself');\n`;
      fs.writeFileSync(path.join(dir, 'scripts', 'helper.ts'), guarded('helper'));
      fs.writeFileSync(path.join(dir, 'scripts', 'entry.ts'), `import { helper } from './helper';\n${guarded('entry')}console.log('helper is', helper);\n`);
      const entryFile = path.join(dir, 'scripts', 'entry.ts');
      const outfile = path.join(dir, 'out.mjs');
      await build({ entryPoints: [entryFile], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent', plugins: [entryGuardPlugin(entryFile)] });
      const run = spawnSync(process.execPath, [outfile], { encoding: 'utf8' });
      expect(run.stdout).toContain('entry started itself');
      expect(run.stdout).toContain('helper is 1');
      expect(run.stdout).not.toContain('helper started itself');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the real start-up steps compile with no self-starting script left in them', async () => {
    const entryFile = path.join(root, 'scripts', 'preflight.ts');
    const out = await build({ entryPoints: [entryFile], absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', packages: 'external', tsconfig: path.join(root, 'tsconfig.json'), write: false, logLevel: 'silent', plugins: [entryGuardPlugin(entryFile)] });
    const text = out.outputFiles[0].text;
    expect(text).not.toContain('pathToFileURL(process.argv[1]');
    // The migrations, the settings and the tools it runs are inside.
    expect(text).toContain('migrate');
    expect(text).toContain('Upscayl');
  });
});

/**
 * The installer takes only the files named in desktop/electron-builder.yml (files:). One the app loads but the list
 * leaves out works from the repository and breaks only in the installed app (owner rule: nothing may break).
 */
describe("the installer's file list", () => {
  it('names every file the app loads from its own folder', () => {
    const desktop = path.join(root, 'desktop');
    const yml = fs.readFileSync(path.join(desktop, 'electron-builder.yml'), 'utf8');
    const block = /^files:\n((?:[ \t]+- .+\n)+)/m.exec(yml);
    expect(block).not.toBeNull();
    const listed = block![1]
      .split('\n')
      .map((line) => line.replace(/^\s+-\s+/, '').trim())
      .filter(Boolean);
    const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '[^/]*')}$`);
    const inList = (file: string) => listed.some((p) => p === file || p.startsWith(`${file}/`) || (p.includes('*') && glob(p).test(file)));
    for (const p of listed) expect(p.includes('*') || fs.existsSync(path.join(desktop, p)), p).toBe(true);

    const used = new Set<string>();
    for (const file of listed.filter((p) => p.endsWith('.cjs'))) {
      const text = fs.readFileSync(path.join(desktop, file), 'utf8');
      for (const m of text.matchAll(/require\('\.\/([^']+)'\)/g)) used.add(m[1]);
      for (const m of text.matchAll(/path\.join\(__dirname, '([^']+)'/g)) used.add(m[1]);
    }
    // Run from the repository only; the installed app loads the copy prepare.mjs puts into the bundle.
    used.delete('child-guard.cjs');
    expect(used).toContain('updating.html');
    expect(used).toContain('log-file.cjs');
    expect([...used].filter((f) => !inList(f))).toEqual([]);
  });
});
