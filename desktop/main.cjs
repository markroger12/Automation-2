'use strict';
/**
 * Blog Automation Studio as a desktop app (owner request: “open the .exe and the app opens; no cmd”).
 *
 * The same tool as `npm run start:all`, on its own Node.js: the dashboard in this window, the server and the worker
 * hidden in the background. Automation Chrome with the extension stays the browser for ChatGPT and Search Console
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

const PORT = 3000;
const ORIGIN = `http://localhost:${PORT}`;
const TITLE = 'Blog Automation Studio';
const packaged = app.isPackaged;
/** The tool itself: next to this file when run from the repository, in the app's resources once installed. */
const appDir = packaged ? path.join(process.resourcesPath, 'app') : path.resolve(__dirname, '..');
const nodeExe = packaged ? path.join(process.resourcesPath, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node') : process.env.BAS_NODE || 'node';
const configFile = () => path.join(app.getPath('userData'), 'desktop.json');
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
      'If you already use Blog Automation Studio with npm run start:all, choose its data folder (for example F:\\claude\\Automation-2\\data). Your websites, articles, settings and the Automation Chrome profile are used as they are. The app and npm run start:all cannot run at the same time.\n\nOr start with a new, empty data folder.',
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
function logLine(source, text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
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

function spawnNode(name, args, env, ipc = false) {
  const child = spawn(nodeExe, args, { cwd: appDir, env, windowsHide: true, stdio: ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'] });
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

/** Whether something already answers on the dashboard's port (e.g. npm run start:all is still running). */
function portInUse() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: PORT });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
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
  const hidden = process.argv.includes('--hidden');
  appMenu();
  // Only what the dashboard needs: copying text. No camera, microphone, location or notifications.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  const dataDir = await dataFolder();
  if (!dataDir) return quitApp();
  const logFile = openLog(dataDir);
  buildTray(dataDir, logFile);
  await createWindow(hidden);
  logLine('app', `Starting (data: ${dataDir}, tool: ${appDir}, node: ${nodeExe}).`);

  while (await portInUse()) {
    const r = await dialog.showMessageBox({
      type: 'warning',
      title: TITLE,
      message: `Port ${PORT} is already in use.`,
      detail: 'Is npm run start:all still running? Close its window (Ctrl+C), then click Retry. The app and npm run start:all cannot run at the same time.',
      buttons: ['Retry', 'Quit'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (r.response === 1) return quitApp();
  }

  const env = { ...process.env, ...envFileVars(dataDir), BAS_DATA_DIR: dataDir, BAS_PROJECT_ROOT: appDir, NODE_ENV: 'production', APP_ORIGIN: ORIGIN, BAS_DESKTOP: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  // Children find the bundled Node.js first (the migration step starts it again).
  env.PATH = `${path.dirname(nodeExe)}${path.delimiter}${env.PATH || env.Path || ''}`;

  status('Preparing your data…', 'Migrations with a backup first, settings, the face and person detectors (once).');
  const prepared = await runToEnd('setup', ['--import', 'tsx', 'scripts/preflight.ts'], env);
  if (prepared !== 0) {
    status('Preparing failed.', recent.slice(-10).join('\n'));
    await dialog.showMessageBox({ type: 'error', title: TITLE, message: 'The data could not be prepared.', detail: `Nothing was deleted. Last lines of the log (${logFile}):\n\n${recent.slice(-12).join('\n')}`, buttons: ['Quit'] });
    return quitApp();
  }
  status('Starting the dashboard…');
  keepRunning('web', () => spawnNode('web', ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(PORT)], env));
  status('Starting the worker…');
  keepRunning('worker', () => spawnNode('worker', ['--import', 'tsx', 'src/worker/index.ts'], env, true));
  if (!(await waitForDashboard(120_000))) {
    status('The dashboard did not start.', recent.slice(-10).join('\n'));
    return;
  }
  if (win && !win.isDestroyed()) await win.loadURL(ORIGIN);
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
      app.quit();
    });
  });
  app.on('web-contents-created', (_e, contents) => secureContents(contents));
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox(TITLE, String(error && error.stack ? error.stack : error));
    quitApp();
  });
}
