// Runs the assembled bundle as the installed app does, before the installer is built (owner report: the installed
// app stopped at “prisma migrate deploy failed … Cannot find module 'fast-check'”, while a run inside the repository
// worked: Node.js found the package in the repository's own node_modules).
//
// A copy of desktop/bundle goes to a new temporary folder outside the repository, so every package must come from the
// bundle. There it runs the start-up steps on a new data folder (migrations, settings), then the dashboard server and
// the worker, on the app's built-in Node.js (Electron's, from desktop/node_modules: run `npm ci` in desktop/ first),
// started as main.cjs starts them. Exit 0 when the dashboard answers and the worker runs; otherwise the logs and
// exit 1. The temporary folder is removed afterwards.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const source = path.join(import.meta.dirname, 'bundle');
if (!fs.existsSync(source)) {
  console.error('desktop/bundle does not exist: run node desktop/prepare.mjs first.');
  process.exit(1);
}
const where = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-check-'));
// Inside means a relative path that does not leave the repository (on Windows another drive gives an absolute one).
const inRepo = path.relative(repo, where);
if (!inRepo.startsWith('..') && !path.isAbsolute(inRepo)) {
  console.error(`The check folder ${where} is inside the repository; set TMPDIR/TEMP to a folder outside it.`);
  process.exit(1);
}
const bundle = path.join(where, 'bundle');
fs.cpSync(source, bundle, { recursive: true, verbatimSymlinks: true });
const node = path.join(import.meta.dirname, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (!fs.existsSync(node)) {
  console.error(`${node} is missing: run npm ci in desktop/ first.`);
  process.exit(1);
}
const app = path.join(bundle, 'app');
const port = 3123;
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NEXT_IGNORE_INCORRECT_LOCKFILE: '1', NEXT_TELEMETRY_DISABLED: '1', BAS_DATA_DIR: path.join(where, 'data'), BAS_PROJECT_ROOT: app, NODE_ENV: 'production', BAS_DESKTOP: '1', APP_ORIGIN: `http://localhost:${port}` };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;

const logs = { setup: '', web: '', worker: '' };
// The app must never install anything by itself (Next.js tried to, once, when its compiler was missing).
// Caches (e.g. node_modules/.cache/jiti, written by the Prisma CLI's config loader) do not count.
const packageNames = () => new Set(fs.readdirSync(path.join(app, 'node_modules')).filter((n) => !n.startsWith('.')));
const packagesBefore = packageNames();
const children = [];
let failed = null;

function finish(code) {
  for (const child of children) if (child.exitCode === null) child.kill();
  if (code !== 0) for (const [name, text] of Object.entries(logs)) console.log(`\n----- ${name} -----\n${text.split('\n').slice(-40).join('\n')}`);
  setTimeout(() => {
    try {
      fs.rmSync(where, { recursive: true, force: true });
    } catch {
      /* a Windows file still held open; the system cleans its temporary folder */
    }
    process.exit(code);
  }, 2000);
}

console.log(`▸ Start-up steps on a new data folder (bundle copied to ${where})…`);
const setup = spawnSync(node, ['--import', 'tsx', 'scripts/preflight.ts'], { cwd: app, env, encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000 });
logs.setup = `${setup.stdout ?? ''}${setup.stderr ?? ''}`;
if (setup.status !== 0) {
  console.log(`✖ The start-up steps failed (exit ${setup.status}).`);
  finish(1);
} else {
  console.log('  ✓ migrations and settings');
  const start = (name, args) => {
    const child = spawn(node, args, { cwd: app, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', (d) => (logs[name] += d));
    child.stderr.on('data', (d) => (logs[name] += d));
    child.on('exit', (code) => {
      if (code !== null && code !== 0 && !failed) failed = `${name} stopped (exit ${code})`;
    });
    children.push(child);
  };
  start('web', ['--require', './desktop-child-guard.cjs', 'node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)]);
  start('worker', ['--import', 'tsx', 'src/worker/index.ts']);
  const answers = () =>
    new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', headers: { host: `localhost:${port}` }, timeout: 5000 }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(0));
      req.on('timeout', () => {
        req.destroy();
        resolve(0);
      });
    });
  const until = Date.now() + 120_000;
  let status = 0;
  while (Date.now() < until && !failed) {
    status = await answers();
    if (status === 200 && /Worker \S+ running/.test(logs.worker)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const installed = [...packageNames()].filter((n) => !packagesBefore.has(n));
  if (installed.length) failed = `installed while the app ran: ${installed.join(', ')}`;
  if (status === 200 && /Worker \S+ running/.test(logs.worker) && !failed) {
    console.log('  ✓ the dashboard answers (HTTP 200) and the worker runs; nothing was installed');
    finish(0);
  } else {
    console.log(`✖ ${failed ?? `dashboard HTTP ${status}, worker ${/Worker \S+ running/.test(logs.worker) ? 'running' : 'not running'}`}`);
    finish(1);
  }
}
