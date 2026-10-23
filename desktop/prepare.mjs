// Assembles the desktop bundle (owner request: the tool as a .exe) from a built repository:
//   desktop/bundle/app      the tool, as `npm run start:all` runs it (no data, no .env, no tests)
//   desktop/bundle/runtime  Node.js for the tool (checked against nodejs.org's SHA-256 list)
// Run after `npm ci` and `npm run build` in the repository root. Writes nothing outside desktop/bundle.
// `--linux` takes the Linux Node.js (for a local test build); the default is Windows x64.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const NODE_VERSION = 'v26.11.1';
const root = path.resolve(import.meta.dirname, '..');
const bundle = path.join(import.meta.dirname, 'bundle');
const linux = process.argv.includes('--linux');

if (fs.existsSync(bundle)) {
  console.error('desktop/bundle already exists: delete it first, it is assembled from scratch.');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, '.next', 'BUILD_ID'))) {
  console.error('There is no production build: run `npm run build` in the repository root first.');
  process.exit(1);
}

// ---- the tool
const KEEP = ['package.json', 'next.config.ts', 'tsconfig.json', '.env.example', 'middleware.ts', 'prisma', 'src', 'scripts', 'public', 'extension', '.next', 'node_modules'];
// Test and build tools the running app never loads.
const SKIP_MODULES = new Set(['vitest', '@vitest', 'vite', 'axe-core', 'fast-check', 'concurrently', '@types', 'tailwindcss', '@tailwindcss', '.cache']);
const skip = (rel) => {
  const parts = rel.split(path.sep);
  if (parts[0] === '.next' && parts[1] === 'cache') return true;
  if (parts[0] === 'node_modules' && SKIP_MODULES.has(parts[1])) return true;
  // Never a database or a secret.
  return /\.db(-journal|-wal|-shm)?$/.test(rel) || path.basename(rel) === '.env';
};
for (const item of KEEP) {
  const from = path.join(root, item);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(bundle, 'app', item), { recursive: true, verbatimSymlinks: true, filter: (src) => !skip(path.relative(root, src)) });
  console.log(`  app/${item}`);
}

// ---- Node.js
const base = `https://nodejs.org/dist/${NODE_VERSION}`;
const archive = linux ? `node-${NODE_VERSION}-linux-x64.tar.xz` : `node-${NODE_VERSION}-win-x64.zip`;
const top = archive.replace(/\.(zip|tar\.xz)$/, '');
const get = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
};
const sums = (await get(`${base}/SHASUMS256.txt`)).toString('utf8');
const expected = sums.split('\n').find((l) => l.trim().endsWith(`  ${archive}`))?.split(/\s+/)[0];
const data = await get(`${base}/${archive}`);
const actual = createHash('sha256').update(data).digest('hex');
if (!expected || actual !== expected) throw new Error(`${archive}: SHA-256 ${actual} does not match nodejs.org's ${expected ?? '(not listed)'}.`);
const runtime = path.join(bundle, 'runtime');
fs.mkdirSync(runtime, { recursive: true });
const archiveFile = path.join(bundle, archive);
fs.writeFileSync(archiveFile, data);
// One file at a time to stdout (tar reads .zip on Windows 10+), so no extracted folder is left to clean up.
const extract = (inner) => execFileSync('tar', ['-xOf', archiveFile, `${top}/${inner}`], { maxBuffer: 512 * 1024 * 1024 });
fs.writeFileSync(path.join(runtime, linux ? 'node' : 'node.exe'), extract(linux ? 'bin/node' : 'node.exe'), { mode: 0o755 });
fs.writeFileSync(path.join(runtime, 'LICENSE.txt'), extract('LICENSE'));
fs.unlinkSync(archiveFile);
console.log(`  runtime/${linux ? 'node' : 'node.exe'} (Node.js ${NODE_VERSION}, SHA-256 checked)`);
