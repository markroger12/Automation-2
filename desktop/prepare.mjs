// Assembles the desktop bundle (owner request: the tool as a Windows program, nothing else to install, and light):
//   desktop/bundle/app   the tool as `npm run start:all` runs it (no data, no .env, no tests), with only the packages
//                        it loads. It runs on the app's own built-in Node.js (Electron's), as Discord does: no Node.js
//                        to install on the computer.
// Run after `npm ci` and `npm run build` in the repository root. Writes nothing outside desktop/bundle.
import fs from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const bundle = path.join(import.meta.dirname, 'bundle');
const app = path.join(bundle, 'app');

if (fs.existsSync(bundle)) {
  console.error('desktop/bundle already exists: delete it first, it is assembled from scratch.');
  process.exit(1);
}
if (!fs.existsSync(path.join(root, '.next', 'BUILD_ID'))) {
  console.error('There is no production build: run `npm run build` in the repository root first.');
  process.exit(1);
}

// ---- the tool
const KEEP = ['package.json', 'tsconfig.json', '.env.example', 'middleware.ts', 'prisma', 'src', 'scripts', 'public', 'extension', '.next'];
const skip = (rel) => {
  const parts = rel.split(path.sep);
  // The build cache, and the server's source maps (only for debugging the build).
  if (parts[0] === '.next' && (parts[1] === 'cache' || rel.endsWith('.js.map'))) return true;
  // Never a database or a secret.
  return /\.db(-journal|-wal|-shm)?$/.test(rel) || path.basename(rel) === '.env';
};
for (const item of KEEP) {
  const from = path.join(root, item);
  if (!fs.existsSync(from)) continue;
  fs.cpSync(from, path.join(app, item), { recursive: true, verbatimSymlinks: true, filter: (src) => !skip(path.relative(root, src)) });
  console.log(`  app/${item}`);
}
// Lets the dashboard server stop by itself when the app is gone (see main.cjs).
fs.copyFileSync(path.join(import.meta.dirname, 'child-guard.cjs'), path.join(app, 'desktop-child-guard.cjs'));

// ---- the packages the tool loads at run time
// Owner report: the installed app stopped at “prisma migrate deploy failed … Cannot find module 'fast-check'”: a list
// of packages to leave out had dropped one the Prisma CLI loads. Now the packages are found from what the tool really
// loads, then everything those depend on, as Node.js finds them:
//   1. the worker and the start-up steps (they run from TypeScript with tsx): their imports, found with esbuild;
//   2. the dashboard server: the packages its built files require (.next/server);
//   3. Next.js and React (the server itself), the Prisma CLI (migrations) and tsx.
// Packages compiled into the dashboard's pages (e.g. the icons) are not needed again.
const requireFromRoot = createRequire(path.join(root, 'package.json'));
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const packageOf = (spec) => {
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:') || builtins.has(spec) || builtins.has(spec.split('/')[0])) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

const roots = new Set(['next', 'react', 'react-dom', '@prisma/client', 'prisma', 'tsx']);
const esbuild = await import(pathToFileURL(requireFromRoot.resolve('esbuild')).href);

// The Next.js settings as JavaScript: `next start` loads a next.config.ts with Next.js's compiler, which the app does
// not carry (it is only for building); without it Next.js tried to install packages by itself.
const config = await esbuild.build({ entryPoints: [path.join(root, 'next.config.ts')], bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
fs.writeFileSync(path.join(app, 'next.config.mjs'), config.outputFiles[0].text);
console.log('  app/next.config.mjs (from next.config.ts)');
const scan = await esbuild.build({
  entryPoints: ['src/worker/index.ts', 'scripts/preflight.ts', 'scripts/install-tools.ts'].map((f) => path.join(root, f)),
  absWorkingDir: root,
  bundle: true,
  write: false,
  metafile: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  tsconfig: path.join(root, 'tsconfig.json'),
  outdir: path.join(bundle, 'scan'),
  logLevel: 'silent',
});
for (const output of Object.values(scan.metafile.outputs)) for (const i of output.imports) if (i.external && packageOf(i.path)) roots.add(packageOf(i.path));
const serverFiles = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (entry.name.endsWith('.js')) serverFiles.push(p);
  }
};
walk(path.join(root, '.next', 'server'));
// Next.js's own optional ones (e.g. @builder.io/partytown) are tried in the built files; only installed ones count.
const serverRoots = new Set();
for (const file of serverFiles) {
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/(?:require|import)\(\s*["'`]([^"'`\s]+)["'`]\s*\)/g)) if (packageOf(m[1]) && !roots.has(packageOf(m[1]))) serverRoots.add(packageOf(m[1]));
}

/** The folder Node.js loads `name` from when `from` (a package folder) requires it; null when it is not installed. */
function resolvePackage(name, from) {
  for (let dir = from; dir.startsWith(root); dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (dir === root) break;
  }
  return null;
}
// Next.js's compiler (for `next build` and `next dev`, never for `next start`; checked by check-bundle.mjs).
const BUILD_ONLY = (name) => name.startsWith('@next/swc-');
const found = new Set();
const missing = [];
const queue = [...[...roots].map((name) => ({ name, from: root, optional: false })), ...[...serverRoots].map((name) => ({ name, from: root, optional: true }))];
while (queue.length) {
  const { name, from, optional } = queue.shift();
  if (BUILD_ONLY(name)) continue;
  const dir = resolvePackage(name, from);
  if (!dir) {
    // Optional packages for other systems (e.g. the Linux build of sharp on Windows) are not installed.
    if (!optional) missing.push(`${name} (needed by ${path.relative(root, from) || 'the tool'})`);
    continue;
  }
  if (found.has(dir)) continue;
  found.add(dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const deps = Object.keys(pkg.dependencies ?? {});
  for (const dep of deps) queue.push({ name: dep, from: dir, optional: false });
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) if (!deps.includes(dep)) queue.push({ name: dep, from: dir, optional: true });
  // Peers the package cannot do without (optional ones, e.g. TypeScript for Prisma's types, are left out).
  for (const dep of Object.keys(pkg.peerDependencies ?? {})) if (!pkg.peerDependenciesMeta?.[dep]?.optional) queue.push({ name: dep, from: dir, optional: true });
}
if (missing.length) throw new Error(`Packages the tool needs are not installed (run npm ci): ${missing.join(', ')}`);
const packages = [...found].sort();
for (const dir of packages) {
  const rel = path.relative(root, dir);
  // A package's own nested node_modules are copied only for the packages found above.
  fs.cpSync(dir, path.join(app, rel), { recursive: true, verbatimSymlinks: true, filter: (src) => !path.relative(dir, src).split(path.sep).includes('node_modules') });
}
// The generated Prisma client (@prisma/client loads it from here).
fs.cpSync(path.join(root, 'node_modules', '.prisma'), path.join(app, 'node_modules', '.prisma'), { recursive: true });
fs.writeFileSync(path.join(bundle, 'packages.txt'), `${packages.map((d) => path.relative(root, d)).join('\n')}\n`);
console.log(`  app/node_modules (${packages.length} packages the tool loads; list in desktop/bundle/packages.txt)`);
