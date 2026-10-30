/**
 * npm run start:all — starts the dashboard (`next start`) and the worker side by side, as `concurrently -k` did, and
 * updates the app when the dashboard asks (Settings → App updates; owner request: one click instead of `git pull`,
 * `npm run start:all` and reloading the extension by hand).
 *
 * An update: stop the worker (it finishes its shutdown) and the dashboard → move the code to the commit the owner saw
 * in Settings (`git merge --ff-only`, never a reset of their changes) → `npm install` when the packages changed →
 * build → migrations with a backup first and missing settings (scripts/preflight.ts) → start both again. While the
 * dashboard is stopped, this process answers on its port with the update's progress. When installing or building
 * fails, the code goes back to the commit it was on and that version starts again.
 *
 * Plain Node.js on purpose: no tsx/esbuild and no Prisma engine is loaded in this process, so on Windows
 * `npm install` and `prisma generate` can replace those files while the app is stopped.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST = '127.0.0.1';
const PORT = 3000;
const LOG_LINES = 400;

// ---------------- pure helpers (tests/unit/start-all.test.ts) ----------------

/** The update's steps, in order. */
export const UPDATE_STEPS = [
  { key: 'stop', label: 'Stop the dashboard and the worker' },
  { key: 'code', label: 'Get the new version' },
  { key: 'install', label: 'Install new packages' },
  { key: 'build', label: 'Build the dashboard' },
  { key: 'prepare', label: 'Database (backup first) and settings' },
  { key: 'start', label: 'Start the app again' },
];

/** Whether the packages changed between two versions (then `npm install` runs). */
export const packagesChanged = (files) => files.some((f) => f === 'package.json' || f === 'package-lock.json');

/** Terminal colours are not wanted in the log the dashboard shows. */
// eslint-disable-next-line no-control-regex
export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');

/** A status file left at “running” by a process that ended in the middle of an update. */
export function interrupted(status, now = new Date()) {
  if (!status || status.state !== 'running') return status;
  return {
    ...status,
    state: 'failed',
    finishedAt: now.toISOString(),
    error: status.error || 'The update was interrupted (the window was closed or the computer restarted). Start the app again; it builds the version that is on disk.',
    steps: status.steps.map((s) => (s.state === 'running' ? { ...s, state: 'failed' } : s)),
  };
}

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Requests from the browser are answered only when addressed to this computer (as middleware.ts does). */
export const loopbackHost = (host) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host || '');

// ---------------- the running app ----------------

/** .env values for this process (existing variables win, as src/lib/env.ts does); only BAS_DATA_DIR is needed here. */
function loadEnv() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    const eq = t.indexOf('=');
    if (!t || t.startsWith('#') || eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const NAMES = { web: paint(34, '[web]'), worker: paint(35, '[worker]'), update: paint(33, '[update]') };

let statusFile = '';
let status = null;
const children = new Map();
let stopping = false;
let updating = false;
let statusServer = null;

function say(line) {
  process.stdout.write(`${NAMES.update} ${line}\n`);
  if (status) {
    status.log.push(stripAnsi(line));
    if (status.log.length > LOG_LINES) status.log.splice(0, status.log.length - LOG_LINES);
  }
}

function saveStatus() {
  if (!status) return;
  const text = JSON.stringify(status, null, 2);
  try {
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    const tmp = `${statusFile}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, statusFile);
  } catch {
    try {
      fs.writeFileSync(statusFile, text);
    } catch {
      /* the progress is still printed here */
    }
  }
}

/** Prefix each output line with the process name, as concurrently did; during an update the lines also go to the log. */
function pipeLines(stream, name, out) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const lines = (rest + chunk).split(/\r?\n/);
    rest = lines.pop() ?? '';
    for (const line of lines) out.write(`${NAMES[name] ?? `[${name}]`} ${line}\n`);
  });
  stream.on('end', () => rest && out.write(`${NAMES[name] ?? `[${name}]`} ${rest}\n`));
}

const CHILDREN = {
  web: () => [path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-H', HOST, '-p', String(PORT)],
  // One process (tsx as a loader, not its CLI that starts another one), so stopping it stops the worker itself.
  worker: () => ['--import', 'tsx', path.join(root, 'src', 'worker', 'index.ts')],
};

function startChild(name) {
  const child = spawn(process.execPath, CHILDREN[name](), {
    cwd: root,
    env: { ...process.env, BAS_SUPERVISED: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.set(name, child);
  pipeLines(child.stdout, name, process.stdout);
  pipeLines(child.stderr, name, process.stderr);
  child.on('message', (message) => {
    if (name === 'web' && message && message.type === 'bas:update' && typeof message.target === 'string') void runUpdate(message.target);
  });
  child.on('exit', (code, signal) => {
    if (children.get(name) === child) children.delete(name);
    if (stopping || updating) return;
    // As `concurrently -k`: when one stops by itself, the other is stopped too.
    process.stdout.write(`${NAMES[name]} exited (${signal ?? `code ${code}`}) — stopping the app.\n`);
    void stopAll(code || 1);
  });
  return child;
}

/** Stop one child: the worker gets its own shutdown over IPC (a signal on Windows ends a process at once). */
function stopChild(name, timeoutMs) {
  const child = children.get(name);
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    if (name === 'worker' && child.connected) child.send({ type: 'bas:shutdown' });
    else child.kill('SIGTERM');
  });
}

async function stopAll(code) {
  if (stopping) return;
  stopping = true;
  await Promise.all([stopChild('worker', 20_000), stopChild('web', 10_000)]);
  await closeStatusServer();
  process.exit(code);
}

// ---------------- the update ----------------

/** Run a command; its output goes to this window and to the update log. */
function run(cmd, args, label) {
  return new Promise((resolve, reject) => {
    say(`$ ${label}`);
    const child = spawn(cmd, args, { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    const take = (chunk) => {
      const text = chunk.toString('utf8');
      out += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) say(`  ${line}`);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (error) => reject(new Error(`${label}: ${error.message}`)));
    child.on('exit', (code) => {
      saveStatus();
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${label} failed (exit code ${code}).`));
    });
  });
}

const git = (...args) => run('git', args, `git ${args.join(' ')}`);
const node = (args, label) => run(process.execPath, args, label);
/** npm the way `npm run start:all` was started (npm_execpath), else from PATH. */
function npm(args) {
  const cli = process.env.npm_execpath;
  if (cli && /\.(c|m)?js$/.test(cli)) return node([cli, ...args], `npm ${args.join(' ')}`);
  return process.platform === 'win32' ? run('npm.cmd', args, `npm ${args.join(' ')}`) : run('npm', args, `npm ${args.join(' ')}`);
}

const nextBuild = async () => {
  await node([path.join(root, 'node_modules', 'prisma', 'build', 'index.js'), 'generate'], 'prisma generate');
  await node([path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], 'next build');
  await node(['--import', 'tsx', path.join(root, 'scripts', 'preflight.ts'), '--mark-build'], 'record the build');
};
const prepare = () => node(['--import', 'tsx', path.join(root, 'scripts', 'preflight.ts')], 'migrations (backup first) and settings').then(() => 'Ready.');

async function step(key, fn) {
  const s = status.steps.find((x) => x.key === key);
  s.state = 'running';
  s.startedAt = new Date().toISOString();
  saveStatus();
  try {
    const result = await fn();
    s.state = result === 'skipped' ? 'skipped' : 'done';
    if (typeof result === 'string' && result !== 'skipped') s.note = result;
    return result;
  } catch (error) {
    s.state = 'failed';
    throw error;
  } finally {
    s.finishedAt = new Date().toISOString();
    saveStatus();
  }
}

/** Answer on the dashboard's port while it is stopped: the progress as JSON, any page as a short “Updating …” page. */
function openStatusServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (!loopbackHost(req.headers.host)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Blog Automation Studio only accepts requests addressed to localhost.');
        return;
      }
      const headers = { 'cache-control': 'no-store', 'x-bas-updater': '1' };
      if (req.method === 'GET' && (req.url || '').startsWith('/api/update')) {
        res.writeHead(200, { ...headers, 'content-type': 'application/json' });
        res.end(JSON.stringify({ supervised: true, updating: true, status }));
        return;
      }
      if (req.method !== 'GET') {
        res.writeHead(503, { ...headers, 'content-type': 'application/json', 'retry-after': '30' });
        res.end(JSON.stringify({ error: { code: 'UPDATING', message: 'The app is updating; try again in a minute.' } }));
        return;
      }
      const current = status?.steps.find((s) => s.state === 'running');
      res.writeHead(503, { ...headers, 'content-type': 'text/html; charset=utf-8', 'retry-after': '5' });
      res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="4"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Updating…</title>
<body style="margin:0;display:grid;place-items:center;min-height:100vh;font:15px 'Segoe UI',system-ui,sans-serif;background:#171717;color:#f5f5f5">
<div style="max-width:420px;padding:24px;border:1px solid #323232;border-radius:12px;background:#1f1f1f">
<h1 style="margin:0 0 8px;font-size:18px">Blog Automation Studio is updating</h1>
${
        status?.state === 'failed'
          ? `<p style="margin:0 0 4px;color:#fca5a5">The update did not finish: ${escapeHtml(status.error || '')}</p><p style="margin:0;color:#a6a6a6">The window where the app runs has every step. Close it and run <code>npm run start:all</code> again.</p>`
          : `<p style="margin:0 0 4px;color:#a6a6a6">${current ? `Now: ${escapeHtml(current.label)}.` : 'Starting again…'}</p><p style="margin:0;color:#a6a6a6">This page opens by itself when the app is back (usually 2–5 minutes).</p>`
      }</div></body>`);
    });
    let tries = 0;
    const listen = () => server.listen(PORT, HOST);
    server.on('error', async (error) => {
      // The dashboard's port can take a moment to be free after it stopped.
      if (error.code === 'EADDRINUSE' && tries++ < 40) {
        await sleep(500);
        listen();
      } else {
        say(`The progress page could not start (${error.message}); the update goes on.`);
        resolve(null);
      }
    });
    server.on('listening', () => resolve(server));
    listen();
  });
}

function closeStatusServer() {
  const server = statusServer;
  statusServer = null;
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
}

/** Wait until the dashboard answers again (at most two minutes). */
async function dashboardBack() {
  for (let i = 0; i < 240; i++) {
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: HOST, port: PORT, path: '/api/update', headers: { host: `localhost:${PORT}` }, timeout: 3000 }, (res) => {
        res.resume();
        resolve(res.statusCode !== undefined && !res.headers['x-bas-updater']);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    if (!children.has('web')) return false;
    await sleep(500);
  }
  return false;
}

async function runUpdate(target) {
  if (updating || stopping) return;
  if (!/^[0-9a-f]{40}$/.test(target)) return;
  updating = true;
  status = {
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    from: null,
    to: { sha: target },
    steps: UPDATE_STEPS.map((s) => ({ ...s, state: 'waiting', startedAt: null, finishedAt: null, note: null })),
    error: null,
    rolledBack: false,
    log: [],
  };
  say(`Update to ${target.slice(0, 7)} asked from the dashboard.`);
  saveStatus();
  // Let the dashboard answer the request that asked for the update first.
  await sleep(800);
  let from = null;
  let movedCode = false;
  let changed = [];
  try {
    await step('stop', async () => {
      await Promise.all([stopChild('worker', 30_000), stopChild('web', 10_000)]);
    });
    statusServer = await openStatusServer();
    from = await git('rev-parse', 'HEAD');
    status.from = { sha: from, subject: await git('log', '-1', '--format=%s', from) };
    saveStatus();
    await step('code', async () => {
      if (from === target) return 'Already on this version.';
      await git('merge', '--ff-only', target);
      movedCode = true;
      const head = await git('rev-parse', 'HEAD');
      if (head !== target) throw new Error(`The code is at ${head.slice(0, 7)}, not at ${target.slice(0, 7)}.`);
      status.to.subject = await git('log', '-1', '--format=%s', target);
      changed = (await git('diff', '--name-only', from, target)).split(/\r?\n/).filter(Boolean);
      return `${from.slice(0, 7)} → ${target.slice(0, 7)} (${changed.length} file${changed.length === 1 ? '' : 's'})`;
    });
    await step('install', async () => (packagesChanged(changed) ? npm(['install', '--no-audit', '--no-fund']).then(() => 'Packages installed.') : 'skipped'));
    await step('build', async () => (movedCode ? nextBuild().then(() => 'Built.') : 'skipped'));
  } catch (error) {
    status.error = error instanceof Error ? error.message : String(error);
    say(`✖ ${status.error}`);
    // Installing or building failed: back to the version that was running (the owner's changes are never touched:
    // the update starts only when no tracked file is changed, and --keep refuses to overwrite one).
    if (movedCode && from) {
      say(`Going back to ${from.slice(0, 7)}…`);
      try {
        await git('reset', '--keep', from);
        if (packagesChanged(changed)) await npm(['install', '--no-audit', '--no-fund']);
        await nextBuild();
        status.rolledBack = true;
        say(`Back on ${from.slice(0, 7)}.`);
      } catch (back) {
        say(`✖ Going back failed: ${back instanceof Error ? back.message : String(back)}`);
      }
    }
  }
  if (!status.error) {
    try {
      await step('prepare', prepare);
    } catch (error) {
      // Migrations are not undone by going back; the backup made just before them is in data/backups.
      status.error = `${error instanceof Error ? error.message : String(error)} Your data was not reset; a backup from just before is in data/backups.`;
      say(`✖ ${status.error}`);
    }
  }
  if (stopping) {
    status.state = 'failed';
    status.error = status.error || 'Stopped before the update finished.';
    status.finishedAt = new Date().toISOString();
    saveStatus();
    return;
  }
  try {
    await step('start', async () => {
      await closeStatusServer();
      startChild('web');
      startChild('worker');
      if (!(await dashboardBack())) throw new Error('The dashboard did not start again; see this window for its error.');
      return 'Running.';
    });
  } catch (error) {
    status.error = [status.error, error instanceof Error ? error.message : String(error)].filter(Boolean).join(' ');
  }
  status.state = status.error ? 'failed' : 'done';
  status.finishedAt = new Date().toISOString();
  say(status.error ? `Update did not finish: ${status.error}` : `✔ Updated to ${target.slice(0, 7)}.`);
  saveStatus();
  // The dashboard did not come back: keep answering on its port, so the browser shows why.
  if (!children.has('web') && !statusServer) statusServer = await openStatusServer();
  updating = false;
}

// ---------------- start ----------------

function main() {
  loadEnv();
  const dataDir = process.env.BAS_DATA_DIR ? path.resolve(process.env.BAS_DATA_DIR) : path.join(root, 'data');
  statusFile = path.join(dataDir, 'update', 'status.json');
  try {
    const before = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    const after = interrupted(before);
    if (after !== before) {
      status = after;
      saveStatus();
      status = null;
    }
  } catch {
    /* no update yet */
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
    try {
      process.on(signal, () => void stopAll(0));
    } catch {
      /* signal not available on this platform */
    }
  }
  startChild('web');
  startChild('worker');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
