'use strict';
/**
 * Blog Automation Studio as a desktop app (owner requests: “open the .exe and the app opens; no cmd”; “no Node.js or
 * anything needed on the laptop, like Discord”; “no port system”; “light”).
 *
 * The same tool as `npm run start:all`, on this app's own built-in Node.js (Electron's, nothing to install): the
 * dashboard in this window, the server and the worker hidden in the background. The port is chosen by itself: a free
 * one from 3000 to 3010 (the extension finds it there), or, when the tool already runs on the same data folder (e.g.
 * `npm run start:all`), the window just shows that one. Automation Chrome with the extension stays the browser for ChatGPT and Search Console
 * (Google refuses sign-ins in embedded browsers, and the app is never disguised as Chrome). Closing the window keeps
 * the app in the tray so the workflow keeps running; Quit stops the worker safely, then the server.
 *
 * Security as in the browser: the dashboard binds to 127.0.0.1 with its own Host/Origin/CSRF checks; this window has
 * no Node access (sandboxed, context-isolated), and every non-local address opens in the default browser.
 */
const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const { createHash } = require('node:crypto');

/** Ports the dashboard may use; the extension looks for it on the same ones. */
const PORTS = Array.from({ length: 11 }, (_, i) => 3000 + i);
let PORT = 3000;
let ORIGIN = `http://localhost:${PORT}`;
const TITLE = 'Blog Automation Studio';
const packaged = app.isPackaged;
/** The tool itself: next to this file when run from the repository, in the app's resources once installed. */
const appDir = packaged ? path.join(process.resourcesPath, 'app') : path.resolve(__dirname, '..');
const configFile = () => path.join(app.getPath('userData'), 'desktop.json');
/** `--smoke-test`: start once on BAS_DESKTOP_DATA_DIR without any dialog, write the result, quit (the Windows build). */
const smoke = process.argv.includes('--smoke-test');
const smokeResult = (process.argv.find((a) => a.startsWith('--smoke-result=')) || '').slice('--smoke-result='.length);
const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));

let win = null;
let tray = null;
let quitting = false;
let stopped = false;
let logStream = null;
const children = { web: null, worker: null };

// ------------------------------------------------------------------ config

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}

/** The data folder: chosen once (an existing one from `npm run start:all`, or a new one), then remembered. */
async function dataFolder() {
  // Set by tests (and for a fixed folder without asking).
  if (process.env.BAS_DESKTOP_DATA_DIR) return path.resolve(process.env.BAS_DESKTOP_DATA_DIR);
  const cfg = readConfig();
  if (cfg.dataDir && fs.existsSync(cfg.dataDir)) return cfg.dataDir;
  const r = await dialog.showMessageBox({
    type: 'question',
    title: TITLE,
    message: 'Which data should the app use?',
    detail:
      'If you already use Blog Automation Studio with npm run start:all, choose its data folder (for example F:\\claude\\Automation-2\\data). Your websites, articles, settings and the Automation Chrome profile are used as they are; while npm run start:all runs, this window shows it.\n\nOr start with a new, empty data folder.',
    buttons: ['Choose my data folder…', 'Start with a new data folder', 'Quit'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  });
  if (r.response === 2) return null;
  let dir = path.join(app.getPath('userData'), 'data');
  if (r.response === 0) {
    const pick = await dialog.showOpenDialog({ title: 'Choose the data folder (it holds app.db)', properties: ['openDirectory'] });
    if (pick.canceled || !pick.filePaths[0]) return dataFolder();
    dir = pick.filePaths[0];
    // The tool's own folder was chosen: its data folder is inside.
    if (!fs.existsSync(path.join(dir, 'app.db')) && fs.existsSync(path.join(dir, 'data', 'app.db'))) dir = path.join(dir, 'data');
    if (!fs.existsSync(path.join(dir, 'app.db'))) {
      const again = await dialog.showMessageBox({ type: 'warning', title: TITLE, message: 'There is no app.db in this folder.', detail: `${dir}\n\nUse it as a new data folder anyway?`, buttons: ['Choose again', 'Use it'], defaultId: 0, cancelId: 0, noLink: true });
      if (again.response === 0) return dataFolder();
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  writeConfig({ ...cfg, dataDir: dir });
  return dir;
}

/** Settings from the tool's .env next to the data folder (e.g. SERPER_API_KEY), so the app uses the same ones. */
function envFileVars(dataDir) {
  const out = {};
  for (const file of [path.join(path.dirname(dataDir), '.env'), path.join(dataDir, 'desktop.env')]) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m || ['DATABASE_URL', 'APP_ORIGIN', 'BAS_DATA_DIR', 'BAS_PROJECT_ROOT', 'NODE_ENV'].includes(m[1])) continue;
      out[m[1]] = m[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  return out;
}

// ------------------------------------------------------------------ log and splash

function openLog(dataDir) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'desktop.log');
  try {
    if (fs.statSync(file).size > 5 * 1024 * 1024) fs.renameSync(file, path.join(dir, 'desktop.1.log'));
  } catch {
    /* no log yet */
  }
  logStream = fs.createWriteStream(file, { flags: 'a' });
  return file;
}

const recent = [];
let workerRunning = false;
function logLine(source, text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (source === 'worker' && /Worker \S+ running/.test(line)) workerRunning = true;
    const entry = `${new Date().toISOString()} [${source}] ${line}`;
    logStream?.write(`${entry}\n`);
    recent.push(`[${source}] ${line}`);
    if (recent.length > 40) recent.shift();
  }
}

function status(text, detail = '') {
  logLine('app', text);
  if (!win || win.isDestroyed() || !win.webContents.getURL().startsWith('file:')) return;
  win.webContents.executeJavaScript(`window.setStatus && window.setStatus(${JSON.stringify(text)}, ${JSON.stringify(detail)})`).catch(() => {});
}

// ------------------------------------------------------------------ server and worker

/** The tool's processes run on this app's own Node.js (Electron as Node.js), so nothing has to be installed. */
function spawnNode(name, args, env, ipc = false) {
  const child = spawn(process.execPath, args, { cwd: appDir, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logLine(name, d));
  child.stderr.on('data', (d) => logLine(name, d));
  child.on('error', (e) => logLine(name, `could not start: ${e.message}`));
  return child;
}

function runToEnd(name, args, env) {
  return new Promise((resolve) => {
    const child = spawnNode(name, args, env);
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/** The data folder's fingerprint, as the dashboard reports it at /api/instance (src/lib/instance.ts). */
function dataFolderId(dir) {
  const resolved = process.platform === 'win32' ? dir.toLowerCase() : dir;
  return createHash('sha256').update(resolved.replace(/[\\/]+$/, '')).digest('hex').slice(0, 16);
}

/** What answers on a port: this tool's dashboard (with its data folder's fingerprint), or null. */
function instanceAt(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/instance', headers: { host: `localhost:${port}` }, timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/**
 * Owner request: no “port 3000 is already in use”. When the tool already runs on this data folder (npm run
 * start:all), the window shows it; otherwise the dashboard starts on the first free port from 3000 to 3010.
 */
async function choosePort(dataDir) {
  const id = dataFolderId(dataDir);
  for (const port of PORTS) {
    const info = await instanceAt(port);
    if (info && info.app === 'blog-automation-studio' && info.dataId === id) return { port, running: true };
  }
  for (const port of PORTS) if (await portFree(port)) return { port, running: false };
  return null;
}

function dashboardAnswers() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/', headers: { host: `localhost:${PORT}` }, timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForDashboard(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await dashboardAnswers()) return true;
    if (children.web && children.web.exitCode !== null) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const restarts = { web: [], worker: [] };
function keepRunning(name, start) {
  const child = start();
  children[name] = child;
  child.on('exit', (code) => {
    if (quitting) return;
    logLine('app', `${name} stopped (exit ${code}).`);
    // Restarted at most 3 times in 5 minutes; then the window says so.
    const now = Date.now();
    restarts[name] = restarts[name].filter((t) => now - t < 5 * 60_000);
    if (restarts[name].length >= 3) {
      dialog.showMessageBox({ type: 'error', title: TITLE, message: `The ${name === 'web' ? 'dashboard server' : 'worker'} keeps stopping.`, detail: `Last lines of the log:\n\n${recent.slice(-12).join('\n')}`, buttons: ['OK'] }).catch(() => {});
      return;
    }
    restarts[name].push(now);
    setTimeout(() => !quitting && keepRunning(name, start), 2000);
  });
}

async function stopAll() {
  const worker = children.worker;
  if (worker && worker.exitCode === null) {
    // Safe stop over IPC: the worker finishes its step, records it and releases its lock.
    try {
      worker.send({ type: 'shutdown' });
    } catch {
      /* channel already closed */
    }
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        worker.kill();
        resolve();
      }, 20_000);
      worker.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  if (children.web && children.web.exitCode === null) children.web.kill();
}

// ------------------------------------------------------------------ window and tray

const isLocal = (url) => {
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1'].includes(u.hostname) && (u.port || '80') === String(PORT);
  } catch {
    return false;
  }
};

function secureContents(contents) {
  // Links to other websites open in the default browser; the window only ever shows the local dashboard.
  contents.setWindowOpenHandler(({ url }) => {
    if (isLocal(url)) return { action: 'allow', overrideBrowserWindowOptions: { icon, autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } } };
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (e, url) => {
    if (isLocal(url) || url.startsWith('file:')) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
}

function createWindow(hidden) {
  win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 640,
    title: TITLE,
    icon,
    show: !hidden,
    autoHideMenuBar: true,
    backgroundColor: '#0b1020',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  win.on('close', (e) => {
    if (quitting || readConfig().keepInTray === false) return;
    // The workflow keeps running in the background; the tray icon brings the window back.
    e.preventDefault();
    win.hide();
    const cfg = readConfig();
    if (!cfg.trayHintShown && tray && process.platform === 'win32') {
      tray.displayBalloon({ title: TITLE, content: 'Still running here, so the workflow keeps going. Right-click the icon to quit.', iconType: 'info' });
      writeConfig({ ...cfg, trayHintShown: true });
    }
  });
  win.on('closed', () => (win = null));
  return win.loadFile(path.join(__dirname, 'splash.html'));
}

function showWindow() {
  if (!win) {
    createWindow(false).then(() => win.loadURL(ORIGIN)).catch(() => {});
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function buildTray(dataDir, logFile) {
  tray = new Tray(icon.resize({ width: 16, height: 16 }));
  tray.setToolTip(TITLE);
  const menu = () =>
    Menu.buildFromTemplate([
      { label: `Open ${TITLE}`, click: showWindow },
      { label: 'Automation Chrome', click: () => (showWindow(), win?.loadURL(`${ORIGIN}/automation-chrome`)) },
      { type: 'separator' },
      { label: 'Open the data folder', click: () => void shell.openPath(dataDir) },
      { label: 'Open the log', click: () => void shell.openPath(logFile) },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] }),
      },
      {
        label: 'Keep running when the window is closed',
        type: 'checkbox',
        checked: readConfig().keepInTray !== false,
        click: (item) => writeConfig({ ...readConfig(), keepInTray: item.checked }),
      },
      {
        label: 'Use another data folder…',
        click: async () => {
          const r = await dialog.showMessageBox({ type: 'question', title: TITLE, message: 'Choose another data folder?', detail: 'The app stops, then asks for the folder when it starts again.', buttons: ['Restart and choose', 'Cancel'], cancelId: 1, noLink: true });
          if (r.response !== 0) return;
          const cfg = readConfig();
          delete cfg.dataDir;
          writeConfig(cfg);
          app.relaunch();
          quitApp();
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: quitApp },
    ]);
  tray.setContextMenu(menu());
  tray.on('right-click', () => tray.setContextMenu(menu()));
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function quitApp() {
  quitting = true;
  app.quit();
}

function appMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { label: 'App', submenu: [{ label: 'Dashboard', accelerator: 'CmdOrCtrl+Shift+H', click: () => win?.loadURL(ORIGIN) }, { type: 'separator' }, { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: quitApp }] },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      { label: 'View', submenu: [{ role: 'reload' }, { role: 'forceReload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    ]),
  );
}

// ------------------------------------------------------------------ start

async function start() {
  const hidden = process.argv.includes('--hidden') || smoke;
  appMenu();
  // Only what the dashboard needs: copying text. No camera, microphone, location or notifications.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  const dataDir = await dataFolder();
  if (!dataDir) return quitApp();
  const logFile = openLog(dataDir);
  buildTray(dataDir, logFile);
  await createWindow(hidden);
  logLine('app', `Starting (data: ${dataDir}, tool: ${appDir}, built-in Node.js ${process.versions.node}).`);

  const chosen = await choosePort(dataDir);
  if (!chosen) {
    await fail('No free port for the dashboard.', 'Every port from 3000 to 3010 on this computer is taken by other programs. Close one of them and start the app again.');
    return;
  }
  PORT = chosen.port;
  ORIGIN = `http://localhost:${PORT}`;
  if (chosen.running) {
    // The tool already runs on this data folder (npm run start:all): show it instead of starting a second copy.
    logLine('app', `Blog Automation Studio already runs on this data folder at ${ORIGIN}; the window shows it.`);
    if (smoke) return smokeDone(true, `attached to the running dashboard at ${ORIGIN}`);
    if (win && !win.isDestroyed()) await win.loadURL(ORIGIN);
    return;
  }

  const env = { ...process.env, ...envFileVars(dataDir), BAS_DATA_DIR: dataDir, BAS_PROJECT_ROOT: appDir, NODE_ENV: 'production', APP_ORIGIN: ORIGIN, BAS_DESKTOP: '1', NEXT_TELEMETRY_DISABLED: '1', NEXT_IGNORE_INCORRECT_LOCKFILE: '1' };
  delete env.NODE_OPTIONS;

  status('Preparing your data…', 'Migrations with a backup first, settings, the face and person detectors (once).');
  const prepared = await runToEnd('setup', ['--import', 'tsx', 'scripts/preflight.ts'], env);
  if (prepared !== 0) {
    status('Preparing failed.', recent.slice(-10).join('\n'));
    await fail('The data could not be prepared.', `Nothing was deleted. Last lines of the log (${logFile}):\n\n${recent.slice(-12).join('\n')}`);
    return;
  }
  status('Starting the dashboard…');
  // With a channel to this app, so the server stops by itself when the app is gone (desktop-child-guard.cjs).
  keepRunning('web', () => spawnNode('web', ['--require', './desktop-child-guard.cjs', 'node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(PORT)], env, true));
  status('Starting the worker…');
  keepRunning('worker', () => spawnNode('worker', ['--import', 'tsx', 'src/worker/index.ts'], env, true));
  if (!(await waitForDashboard(120_000))) {
    status('The dashboard did not start.', recent.slice(-10).join('\n'));
    if (smoke) smokeDone(false, 'the dashboard did not start');
    return;
  }
  if (smoke) {
    const until = Date.now() + 60_000;
    while (Date.now() < until && !workerRunning) await new Promise((r) => setTimeout(r, 500));
    const worker = workerRunning;
    const info = await instanceAt(PORT);
    const ok = worker && info && info.dataId === dataFolderId(dataDir);
    return smokeDone(Boolean(ok), `dashboard ${ORIGIN} answers; worker ${worker ? 'running' : 'not running'}; data folder ${info && info.dataId === dataFolderId(dataDir) ? 'matches' : 'does not match'}`);
  }
  if (win && !win.isDestroyed()) await win.loadURL(ORIGIN);
}

/** A stop the owner must see; in the smoke test the result file says it instead. */
async function fail(message, detail) {
  if (smoke) return smokeDone(false, `${message} ${detail}`);
  await dialog.showMessageBox({ type: 'error', title: TITLE, message, detail, buttons: ['Quit'] });
  quitApp();
}

function smokeDone(ok, summary) {
  logLine('app', `Smoke test ${ok ? 'passed' : 'failed'}: ${summary}`);
  if (smokeResult) fs.writeFileSync(smokeResult, JSON.stringify({ ok, summary, port: PORT, log: recent.slice(-40) }, null, 2));
  process.exitCode = ok ? 0 : 1;
  quitApp();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => {
    /* stays in the tray */
  });
  app.on('before-quit', (e) => {
    quitting = true;
    if (stopped) return;
    e.preventDefault();
    logLine('app', 'Quitting: stopping the worker safely, then the server.');
    stopAll().finally(() => {
      stopped = true;
      logStream?.end();
      if (smoke) app.exit(process.exitCode ?? 0);
      else app.quit();
    });
  });
  app.on('web-contents-created', (_e, contents) => secureContents(contents));
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox(TITLE, String(error && error.stack ? error.stack : error));
    quitApp();
  });
}
