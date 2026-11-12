'use strict';
/**
 * Blog Automation Studio as a desktop app (owner requests: “open the .exe and the app opens; no cmd”; “no Node.js or
 * anything needed on the laptop, like Discord”; “no port system”; “light”; “the browser inside the app”).
 *
 * The same tool as `npm run start:all`, on this app's own built-in Node.js (Electron's, nothing to install): the
 * server and the worker hidden in the background, and this window with two tabs:
 * - Dashboard: the dashboard.
 * - ChatGPT: ChatGPT itself, where the owner signs in once (email and password) and the prompts run, with the
 *   extension's own ChatGPT scripts (chatgpt-tab.cjs). Automation Chrome is not needed for ChatGPT any more.
 * Google and Search Console stay in Automation Chrome (Google refuses sign-ins in a browser built into an app, and
 * the app is never disguised as Chrome): the worker opens it as a Search Console window when an indexing request is
 * due, and closes it afterwards.
 *
 * The port is chosen by itself: a free one from 3000 to 3010 (the extension finds it there), or, when the tool already
 * runs on the same data folder (e.g. `npm run start:all`), the window just shows that one (and ChatGPT stays with
 * Automation Chrome, which that dashboard uses). Closing the window keeps the app in the tray so the workflow keeps
 * running; Quit stops the worker safely, then the server.
 *
 * Security as in the browser: the dashboard binds to 127.0.0.1 with its own Host/Origin/CSRF checks; the tabs have no
 * Node access (sandboxed, context-isolated), the dashboard tab only shows the local dashboard and the ChatGPT tab only
 * ChatGPT; every other address opens in the default browser.
 */
const { app, BrowserWindow, Menu, Notification, Tray, WebContentsView, clipboard, dialog, ipcMain, nativeImage, nativeTheme, screen, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');

const { createHash, randomBytes } = require('node:crypto');
const { createChatGPTTabs, isChatGPTContents } = require('./chatgpt-tab.cjs');
const { createGoogleTab, isGoogleContents } = require('./google-tab.cjs');
const { createUpdates } = require('./updates.cjs');
const { SHORTCUTS, contextMenuTemplate, debounce, restoreBounds, updatedFrom } = require('./ux.cjs');

/** Ports the dashboard may use; the extension looks for it on the same ones. */
const PORTS = Array.from({ length: 11 }, (_, i) => 3000 + i);
let PORT = 3000;
let ORIGIN = `http://localhost:${PORT}`;
const TITLE = 'Blog Automation Studio';
/** Where the releases are (What's new, Help). */
const RELEASES = 'https://github.com/markroger12/Automation-2/releases';
const packaged = app.isPackaged;
/** The tool itself: next to this file when run from the repository, in the app's resources once installed. */
const appDir = packaged ? path.join(process.resourcesPath, 'app') : path.resolve(__dirname, '..');
const configFile = () => path.join(app.getPath('userData'), 'desktop.json');
/** Lets the dashboard server stop by itself when the app is gone (prepare.mjs copies it into the installed tool). */
const childGuard = packaged ? path.join(appDir, 'desktop-child-guard.cjs') : path.join(__dirname, 'child-guard.cjs');
/** `--smoke-test`: start once on BAS_DESKTOP_DATA_DIR without any dialog, write the result, quit (the Windows build). */
const smoke = process.argv.includes('--smoke-test');
const smokeResult = (process.argv.find((a) => a.startsWith('--smoke-result=')) || '').slice('--smoke-result='.length);
const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));

let win = null;
/** The window's tabs: the dashboard, and ChatGPT (chatgpt-tab.cjs). */
let dashboardView = null;
let chatgpt = null;
let activeTab = 'dashboard';
let chatgptState = { tone: '', text: '' };
let gscState = null;
let shellTheme = null;
let themeTimer = null;
/** Memory saver (owner request 2026-11-12: “ram free”): see memorySaver(). */
let memoryTimer = null;
let lastAgentStatus = null;
let gscActiveAt = Date.now();
let hiddenSince = null;
let dashboardParked = false;
/** The dashboard page shown last (it comes back there after a reconnect or the memory saver). */
let dashboardUrl = null;
const freshenedAt = new Map();
const TAB_BAR = 44;
/** The key this app gives its dashboard for the ChatGPT tab (made at each start, never stored). */
const agentKey = randomBytes(32).toString('base64url');
let tray = null;
let quitting = false;
/** The window shows a dashboard started elsewhere on the same data folder (npm run start:all). */
let attachedToRunning = false;
let stopped = false;
/** App updates (updates.cjs); `installAfterQuit`: the owner chose “Restart to update”. */
let updates = null;
let installAfterQuit = false;
/** The data folder and the log (Help menu, About). */
const paths = { dataDir: null, logFile: null };
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
    message: 'Welcome to Blog Automation Studio',
    detail:
      'Where should your websites, articles and settings be kept?\n\nAlready using Blog Automation Studio? Choose its data folder (for example F:\\claude\\Automation-2\\data) and everything is used as it is.\n\nNew here? Start with a new data folder. You can change this later from the tray menu.',
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

// ------------------------------------------------------------------ log and start-up status

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

/**
 * How a part of the tool starts: the installed app runs it compiled (dist/, prepare.mjs) — no TypeScript compiled at
 * every start, no compiler in memory; a copy started from the repository runs the TypeScript with tsx.
 */
/**
 * Memory (owner request 2026-11-12: “ramm free”): a small young generation for the dashboard server and the worker.
 * Measured on the dashboard server: 252 → 223 MB at rest and 319 → 259 MB after showing every page, with no limit on
 * what a process may use in all (so nothing runs out of memory).
 */
const NODE_MEMORY = ['--max-semi-space-size=2'];

function toolEntry(name, source) {
  const compiled = path.join(appDir, 'dist', `${name}.mjs`);
  return fs.existsSync(compiled) ? [compiled] : ['--import', 'tsx', source];
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

/** The right-click menu (ux.cjs): cut, copy, paste, and a link's address, in every page but the tab bar. */
function contextMenu(contents) {
  // F5 reloads the page, as in a browser (Ctrl+R is in the View menu).
  contents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F5' || input.control || input.alt || input.meta) return;
    if (win && !win.isDestroyed() && contents === win.webContents) return;
    e.preventDefault();
    contents.reload();
  });
  contents.on('context-menu', (_e, params) => {
    if (win && !win.isDestroyed() && contents === win.webContents) return;
    const items = contextMenuTemplate(params, { openExternal: (url) => void shell.openExternal(url), copyText: (text) => clipboard.writeText(text) });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win || undefined });
  });
}

/** The page shown now: the dashboard, the ChatGPT page that has the focus (else the first), or Search Console. */
function shownContents() {
  if (activeTab === 'chatgpt' && shownChatgptView()) return shownChatgptView().webContents;
  if (activeTab === 'search-console' && googleTab) return googleTab.view.webContents;
  return dashboardView ? dashboardView.webContents : null;
}

function zoomShown(step) {
  const wc = shownContents();
  if (!wc) return;
  wc.setZoomLevel(step === 0 ? 0 : Math.max(-3, Math.min(4, wc.getZoomLevel() + step)));
}

/**
 * The dashboard is never left as a blank or broken page: when its page stops (crash) it is loaded again, and when the
 * dashboard does not answer (it is restarting after a crash of the server, which keepRunning does by itself) a
 * “Reconnecting…” page in the tool's look tries again every few seconds and comes back to the same page.
 */
function guardDashboard(view) {
  const wc = view.webContents;
  dashboardUrl = ORIGIN;
  wc.on('did-navigate', (_e, url) => {
    if (isLocal(url)) dashboardUrl = url;
  });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (isMainFrame && isLocal(url)) dashboardUrl = url;
  });
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    // -3: the load was replaced by another (not an error).
    if (!isMainFrame || code === -3 || !isLocal(url)) return;
    logLine('app', `The dashboard page did not load (${description}); reconnecting.`);
    void wc.loadFile(path.join(__dirname, 'offline.html'), { query: { to: url || dashboardUrl, theme: shellTheme || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') } }).catch(() => {});
  });
  wc.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    logLine('app', `The dashboard page stopped (${details.reason}); it is loaded again.`);
    setTimeout(() => !wc.isDestroyed() && !dashboardParked && void wc.loadURL(dashboardUrl).catch(() => {}), 1000);
  });
}

/**
 * Memory saver (owner request 2026-11-12: “app ka sara lagg khatam kr de … ramm free”). Every minute, pages that are
 * not shown and have nothing to do give their memory back; nothing the owner sees or a job needs is touched:
 * - Search Console: put away 10 minutes after it was last shown or made a request (the Google sign-in stays; the
 *   page loads again when the tab is opened or a request comes).
 * - The dashboard: put away while the window has been hidden in the tray for 10 minutes; it comes back at the same
 *   page when the window is opened. The work (server, worker, ChatGPT) goes on meanwhile.
 * - A ChatGPT tab that is not shown, has had nothing to do for 5 minutes and uses more than 700 MB (a long
 *   conversation): it loads ChatGPT's start page afresh, at most once every 30 minutes.
 */
const MINUTE = 60_000;
function memorySaver() {
  if (!win || win.isDestroyed()) return;
  const now = Date.now();
  if (activeTab === 'search-console' && win.isVisible()) gscActiveAt = now;
  if (lastAgentStatus && lastAgentStatus.gsc && lastAgentStatus.gsc.running) gscActiveAt = now;
  if (googleTab && googleTab.loaded() && now - gscActiveAt > 10 * MINUTE) {
    googleTab.unload();
    logLine('app', 'Memory saver: the Search Console page is put away until it is needed again.');
  }
  if (dashboardView && !dashboardParked && hiddenSince && now - hiddenSince > 10 * MINUTE) parkDashboard();
  if (chatgpt && chatgpt.agent && chatgpt.ids) {
    const memory = new Map(app.getAppMetrics().map((m) => [m.pid, m.memory && m.memory.workingSetSize]));
    for (const id of chatgpt.ids()) {
      if (activeTab === 'chatgpt' && id === activeChatgpt && win.isVisible()) continue;
      const mb = Math.round((memory.get(chatgpt.processId(id)) || 0) / 1024);
      if (mb < 700 || !chatgpt.agent.isIdle(id, 5 * MINUTE) || now - (freshenedAt.get(id) || 0) < 30 * MINUTE) continue;
      freshenedAt.set(id, now);
      logLine('app', `Memory saver: ChatGPT tab ${id} used ${mb} MB with nothing to do; it loads ChatGPT afresh.`);
      chatgpt.freshen(id);
    }
  }
}

function parkDashboard() {
  const wc = dashboardView && dashboardView.webContents;
  if (!wc || wc.isDestroyed()) return;
  if (isLocal(wc.getURL())) dashboardUrl = wc.getURL();
  dashboardParked = true;
  void wc.loadURL('about:blank').catch(() => {});
  logLine('app', 'Memory saver: the dashboard page is put away while the window is hidden.');
}

function unparkDashboard() {
  if (!dashboardParked || !dashboardView || dashboardView.webContents.isDestroyed()) return;
  dashboardParked = false;
  void dashboardView.webContents.loadURL(dashboardUrl || ORIGIN).catch(() => {});
}

// ------------------------------------------------------------------ the tabs

/** The ChatGPT tabs' views in the window (one per ChatGPT tab; the agent opens more while prompts wait). */
let chatgptViews = [];
/** The ChatGPT tab shown when the ChatGPT tabs are on top (app-1, app-2 …). */
let activeChatgpt = 'app-1';
/** The open ChatGPT tabs' ids, and the view of the one shown (else the first). */
const chatgptIds = () => (chatgpt && chatgpt.ids ? chatgpt.ids() : []);
function shownChatgptView() {
  if (!chatgpt) return null;
  if (!chatgptIds().includes(activeChatgpt)) activeChatgpt = chatgptIds()[0] || 'app-1';
  return chatgpt.viewOf(activeChatgpt) || chatgptViews[0] || null;
}
/** The Search Console tab (google-tab.cjs), made the first time it is opened. */
let googleTab = null;

/**
 * Every tab fills the space under the tab bar. The ChatGPT pages (app-1, app-2 …) are separate tabs, as in Chrome
 * (owner request 2026-11-12: “chatgpt ke 2 tabs … ek hi tab me dono use na ho”): one is shown at a time, and the
 * others stay in the window underneath at full size, so ChatGPT keeps working and drawing pictures in them.
 */
function layout() {
  if (!win || win.isDestroyed()) return;
  const { width, height } = win.getContentBounds();
  const bounds = { x: 0, y: TAB_BAR, width, height: Math.max(0, height - TAB_BAR) };
  if (dashboardView) dashboardView.setBounds(bounds);
  if (googleTab) googleTab.view.setBounds(bounds);
  for (const view of chatgptViews) view.setBounds(bounds);
}

/** A ChatGPT tab was opened or closed: the window shows exactly the open ones, the tab shown stays on top. */
function chatgptTabsChanged(views) {
  if (!win || win.isDestroyed()) return;
  for (const view of chatgptViews) if (!views.includes(view)) win.contentView.removeChildView(view);
  for (const view of views) if (!chatgptViews.includes(view)) win.contentView.addChildView(view);
  chatgptViews = [...views];
  // A new view was added on top: put back on top the one shown.
  if (activeTab === 'chatgpt' && shownChatgptView()) win.contentView.addChildView(shownChatgptView());
  else if (activeTab === 'search-console' && googleTab) win.contentView.addChildView(googleTab.view);
  else if (dashboardView) win.contentView.addChildView(dashboardView);
  layout();
  shellState();
}

/** The tab bar follows the dashboard's light/dark toggle (the class on its page, read in a separate world). */
function followDashboardTheme() {
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  if (!dashboardView || dashboardView.webContents.isDestroyed() || dashboardView.webContents.isLoading() || !isLocal(dashboardView.webContents.getURL())) return;
  dashboardView.webContents
    .executeJavaScriptInIsolatedWorld(999, [{ code: "document.documentElement.classList.contains('dark') ? 'dark' : 'light'" }])
    .then((theme) => {
      if ((theme === 'dark' || theme === 'light') && theme !== shellTheme) {
        shellTheme = theme;
        shellState();
      }
    })
    .catch(() => {});
}

function shellState() {
  if (!win || win.isDestroyed()) return;
  const busy = (lastAgentStatus && lastAgentStatus.busyIds) || [];
  const chatgptTabs = chatgptIds().map((id) => ({ id, busy: busy.includes(id) }));
  if (chatgptTabs.length && !chatgptTabs.some((t) => t.id === activeChatgpt)) activeChatgpt = chatgptTabs[0].id;
  win.webContents.send('bas-shell:state', { ready: Boolean(dashboardView), tab: activeTab, chatgptTabs, activeChatgpt, chatgpt: chatgptState, gsc: gscState, theme: shellTheme, update: updates ? updates.state() : null, version: app.getVersion() });
}

/** Both tabs stay in the window (ChatGPT keeps working behind the dashboard); the one shown is on top. `focusId`: the
 * ChatGPT tab (app-1, app-2 …) that asked to be shown. */
function selectTab(tab, focusId = null) {
  if (!win || win.isDestroyed() || !dashboardView) return;
  // A ChatGPT tab of the tab bar: “chatgpt:app-2”.
  if (typeof tab === 'string' && tab.startsWith('chatgpt:')) {
    focusId = tab.slice('chatgpt:'.length);
    tab = 'chatgpt';
  }
  if (tab === 'google') {
    // Google and Search Console: Automation Chrome (its sign-in and the indexing panel are on this page).
    tab = 'dashboard';
    void dashboardView.webContents.loadURL(`${ORIGIN}/automation-chrome`).catch(() => {});
  }
  if (tab === 'search-console' && !googleTab) {
    // Search Console in the app (made at start with the app's own dashboard; here for a dashboard started elsewhere).
    googleTab = createGoogleTab({ log: (line) => logLine('google', line) });
    win.contentView.addChildView(googleTab.view);
    layout();
  }
  if (tab === 'search-console') googleTab.open();
  activeTab = tab === 'chatgpt' && chatgpt ? 'chatgpt' : tab === 'search-console' ? 'search-console' : 'dashboard';
  if (activeTab === 'chatgpt' && focusId && chatgptIds().includes(focusId)) activeChatgpt = focusId;
  // The one shown goes on top: the dashboard, one ChatGPT tab, or Search Console.
  const shown = activeTab === 'chatgpt' ? shownChatgptView() : activeTab === 'search-console' ? googleTab.view : dashboardView;
  if (shown) {
    win.contentView.addChildView(shown);
    shown.webContents.focus();
  }
  shellState();
}

function showDashboard(page = '') {
  if (!dashboardView) return;
  dashboardParked = false;
  void dashboardView.webContents.loadURL(`${ORIGIN}${page}`).catch(() => {});
  selectTab('dashboard');
}

function chatgptSummary(s) {
  if (!s) return { tone: '', text: '' };
  if (s.paused) return { tone: '', text: 'ChatGPT: in Automation Chrome (switched in the App menu)' };
  if (s.versionMessage) return { tone: 'bad', text: 'ChatGPT: ' + s.versionMessage };
  if (s.humanCheck) return { tone: 'warn', text: 'ChatGPT shows a check: complete it in the ChatGPT tab' };
  if (s.loggedIn === false) return { tone: 'warn', text: 'ChatGPT: sign in in the ChatGPT tab (email and password)' };
  if (!s.connected) return { tone: 'bad', text: s.lastError ? `ChatGPT: ${s.lastError}` : 'ChatGPT: connecting to the dashboard…' };
  if (s.backoffUntil && new Date(s.backoffUntil) > new Date()) return { tone: 'warn', text: `ChatGPT: usage limit, waiting until ${new Date(s.backoffUntil).toLocaleTimeString()}` };
  const tabs = s.tabs > 1 ? ` (${s.tabs} tabs)` : '';
  if (s.busy) return { tone: 'ok', text: s.busyTabs > 1 ? `ChatGPT: working on ${s.busyTabs} prompts at once${tabs}` : `ChatGPT: working on a prompt${tabs}` };
  return { tone: 'ok', text: s.ready ? `ChatGPT: ready${tabs}` : 'ChatGPT: loading…' };
}

/** The Search Console chip at the top: what the app's Search Console tab is doing, and Google's last answer. */
const GSC_OUTCOME = {
  REQUESTED: ['ok', 'indexing requested'],
  QUOTA: ['warn', "Google's daily limit reached, next try tomorrow"],
  NOT_SIGNED_IN: ['warn', 'sign in to Google in the Search Console tab'],
  HUMAN_CHECK: ['warn', 'Google showed a check, complete it in the Search Console tab'],
  NO_ACCESS: ['bad', 'this Google account has no access to the property'],
  ERROR: ['bad', 'the last request did not finish'],
};
function gscSummary(g) {
  if (!g) return null;
  if (g.running) return { tone: 'busy', text: 'Search Console: requesting indexing…' };
  const last = g.last && GSC_OUTCOME[g.last.outcome];
  if (last) return { tone: last[0], text: `Search Console: ${last[1]}${g.waiting > 0 ? ` · ${g.waiting} waiting` : ''}` };
  if (g.waiting > 0) return { tone: 'busy', text: `Search Console: ${g.waiting} waiting` };
  return { tone: 'ok', text: 'Search Console: ready' };
}

function agentStore() {
  const file = path.join(app.getPath('userData'), 'chatgpt-agent.json');
  return {
    read: () => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return {};
      }
    },
    write: (state) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
      fs.renameSync(`${file}.tmp`, file);
    },
  };
}

/** The dashboard and ChatGPT tabs, once the dashboard answers. `ownServer`: the dashboard this app started. */
function attachTabs(ownServer) {
  if (!win || win.isDestroyed() || dashboardView) return;
  // Its preload gives the dashboard's App updates card the app's updater, and nothing else (dashboard-preload.cjs).
  dashboardView = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, preload: path.join(__dirname, 'dashboard-preload.cjs') } });
  win.contentView.addChildView(dashboardView);
  void dashboardView.webContents.loadURL(ORIGIN).catch(() => {});
  dashboardView.webContents.on('did-finish-load', followDashboardTheme);
  guardDashboard(dashboardView);
  clearInterval(themeTimer);
  themeTimer = setInterval(followDashboardTheme, 3000);
  // The Search Console tab (owner, 2026-11-12: signed in to Google in the app): the app makes the indexing requests in it.
  if (ownServer && !googleTab) {
    googleTab = createGoogleTab({ appDir, log: (line) => logLine('google', line) });
    win.contentView.addChildView(googleTab.view);
  }
  chatgpt = createChatGPTTabs({
    appDir,
    // A dashboard started elsewhere (npm run start:all) does not know this app's key: ChatGPT stays in Automation Chrome.
    origin: ownServer ? () => `http://127.0.0.1:${PORT}` : null,
    key: ownServer ? agentKey : null,
    store: agentStore(),
    notify: (title, body) => notifyOwner(title, body, () => selectTab(title.startsWith('Search Console') ? 'search-console' : 'chatgpt')),
    front: (id) => {
      if (!win || win.isDestroyed()) return;
      selectTab('chatgpt', id || null);
      if (!win.isVisible() || win.isMinimized()) win.showInactive();
    },
    onTabsChanged: (views) => chatgptTabsChanged(views),
    gsc: ownServer && googleTab ? googleTab.port : null,
    gscFront: () => {
      if (!win || win.isDestroyed()) return;
      selectTab('search-console');
      if (!win.isVisible() || win.isMinimized()) win.showInactive();
    },
    onStatus: (s) => {
      lastAgentStatus = s;
      chatgptState = chatgptSummary(s);
      gscState = gscSummary(s.gsc);
      shellState();
    },
    log: (line) => logLine('chatgpt', line),
  });
  if (googleTab && chatgpt.agent) googleTab.connect(chatgpt.agent);
  chatgptTabsChanged(chatgpt.views());
  if (!ownServer) chatgptState = { tone: '', text: 'ChatGPT: prompts run in Automation Chrome while npm run start:all runs' };
  // The smoke test needs no ChatGPT page (only the connection to the dashboard).
  if (!smoke) void chatgpt.load('https://chatgpt.com/').catch(() => {});
  if (chatgpt.agent) {
    void chatgpt.agent.start();
    if (readConfig().chatgptInApp === false) void chatgpt.agent.setPaused(true);
  }
  layout();
  selectTab('dashboard');
}

function createWindow(hidden) {
  // The size and place it had last time (ux.cjs), if that still fits on a screen.
  const saved = restoreBounds(readConfig().windowState, screen.getAllDisplays());
  win = new BrowserWindow({
    ...(saved ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height } : { width: 1440, height: 920, center: true }),
    minWidth: 1024,
    minHeight: 640,
    title: TITLE,
    icon,
    show: false,
    autoHideMenuBar: true,
    // The tool's own background (light or dark), so no other colour flashes before the tab bar paints.
    backgroundColor: (shellTheme || (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')) === 'dark' ? '#171717' : '#f4f4f5',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, preload: path.join(__dirname, 'shell-preload.cjs') },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  for (const change of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(change, layout);
  // Shown once the tab bar has painted (no white flash), maximized if it was.
  // Memory saver: how long the window has been hidden (in the tray or minimized), and the check every minute.
  hiddenSince = hidden ? Date.now() : null;
  win.on('hide', () => (hiddenSince = Date.now()));
  win.on('minimize', () => (hiddenSince = Date.now()));
  win.on('show', () => {
    hiddenSince = null;
    unparkDashboard();
  });
  win.on('restore', () => {
    hiddenSince = null;
    unparkDashboard();
  });
  clearInterval(memoryTimer);
  memoryTimer = setInterval(memorySaver, MINUTE);
  win.once('ready-to-show', () => {
    if (hidden) return;
    if (saved && saved.maximized) win.maximize();
    win.show();
  });
  const saveState = debounce(() => {
    if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    writeConfig({ ...readConfig(), windowState: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
  }, 600);
  for (const change of ['resize', 'move', 'maximize', 'unmaximize']) win.on(change, () => saveState());
  win.on('close', (e) => {
    saveState.flush();
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
  win.on('closed', () => {
    win = null;
    dashboardView = null;
    clearInterval(themeTimer);
    clearInterval(memoryTimer);
    if (chatgpt) {
      const agent = chatgpt.agent;
      chatgpt.destroy();
      chatgpt = null;
      chatgptViews = [];
      if (googleTab) googleTab.destroy();
      googleTab = null;
      if (agent) void agent.stop();
    }
  });
  return win.loadFile(path.join(__dirname, 'shell.html'));
}

function showWindow() {
  if (!win) {
    createWindow(false)
      .then(() => attachTabs(!attachedToRunning))
      .catch(() => {});
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
      { label: 'ChatGPT', click: () => (showWindow(), selectTab('chatgpt')) },
      { label: 'Search Console (in this app)', click: () => (showWindow(), selectTab('search-console')) },
      { label: 'Automation Chrome (Google, Search Console)', click: () => (showWindow(), showDashboard('/automation-chrome')) },
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
      ...updateMenuItems(),
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

/** A Windows notification; a click opens the window (and `onClick`). */
function notifyOwner(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon });
  n.on('click', () => {
    showWindow();
    if (onClick) onClick();
  });
  n.show();
}

/** “Restart to update”: the app stops its work safely (prompts back to the queue, the worker stopped), then installs. */
function restartToUpdate() {
  if (!updates || !updates.ready()) return;
  logLine('update', `Installing version ${updates.state().version}: stopping the work safely first.`);
  installAfterQuit = true;
  quitApp();
}

async function checkForUpdatesNow() {
  if (!updates) return;
  const s = await updates.check();
  if (s.state === 'unavailable') await dialog.showMessageBox({ type: 'info', title: TITLE, message: 'Updates', detail: 'This copy of the app does not update itself (it was not installed with the installer).', buttons: ['OK'] });
  else if (s.state === 'current') await dialog.showMessageBox({ type: 'info', title: TITLE, message: `You have the newest version (${app.getVersion()}).`, buttons: ['OK'] });
  else if (s.state === 'error') await dialog.showMessageBox({ type: 'warning', title: TITLE, message: 'Could not look for updates.', detail: `${s.message || 'Unknown error'}\n\nThe app tries again by itself in a few hours.`, buttons: ['OK'] });
}

const updateMenuItems = () => [
  updates && updates.ready()
    ? { label: `Restart to update (version ${updates.state().version})`, click: restartToUpdate }
    : { label: updates && updates.state().state === 'downloading' ? `Downloading update ${updates.state().version} (${updates.state().percent ?? 0}%)…` : 'Check for updates', enabled: !(updates && updates.state().state === 'downloading'), click: () => void checkForUpdatesNow() },
  { label: `Version ${app.getVersion()}`, enabled: false },
];

/** A message box over the window when it is open (else on its own). */
const messageBox = (options) => (win && !win.isDestroyed() && win.isVisible() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options));

/** About: the version and what it runs on, with “Copy details” for a report. */
async function showAbout() {
  const details = [
    `${TITLE} ${app.getVersion()}`,
    `Electron ${process.versions.electron}, Node.js ${process.versions.node}, Chromium ${process.versions.chrome}`,
    `Windows ${process.getSystemVersion()} (${process.arch})`,
    `Data folder: ${paths.dataDir || 'not chosen yet'}`,
    `Dashboard: ${ORIGIN}${attachedToRunning ? ' (the copy started with npm run start:all)' : ''}`,
  ].join('\n');
  const r = await messageBox({ type: 'info', title: `About ${TITLE}`, message: TITLE, detail: `Version ${app.getVersion()}\n\n${details.split('\n').slice(1).join('\n')}\n\nYour articles, settings and sign-ins stay on this computer.`, buttons: ['OK', 'Copy details'], defaultId: 0, cancelId: 0, noLink: true, icon });
  if (r.response === 1) clipboard.writeText(details);
}

/** For a problem report: the version and the last lines of the app's log (no keys or passwords are logged). */
function copyDiagnostics() {
  clipboard.writeText([`${TITLE} ${app.getVersion()} (Electron ${process.versions.electron}, Windows ${process.getSystemVersion()})`, `Dashboard: ${ORIGIN}`, '', 'Last lines of the log:', ...recent].join('\n'));
  notifyOwner('Details copied', 'The version and the last lines of the log are on the clipboard, ready to paste into a report.');
}

function showShortcuts() {
  void messageBox({ type: 'none', title: 'Keyboard shortcuts', message: 'Keyboard shortcuts', detail: SHORTCUTS.map(([keys, what]) => `${keys}\t${what}`).join('\n'), buttons: ['OK'], noLink: true, icon });
}

function appMenu() {
  const go = (tab) => () => {
    showWindow();
    selectTab(tab);
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'File',
        submenu: [
          { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: go('dashboard') },
          { label: 'ChatGPT', accelerator: 'CmdOrCtrl+2', click: go('chatgpt') },
          { label: 'Search Console', accelerator: 'CmdOrCtrl+3', click: go('search-console') },
          { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => (showWindow(), showDashboard('/settings')) },
          { type: 'separator' },
          {
            // Owner's way back: if ChatGPT does not work in the app, Automation Chrome's extension takes the prompts again.
            label: 'Run ChatGPT prompts in this app',
            type: 'checkbox',
            checked: readConfig().chatgptInApp !== false,
            click: (item) => {
              writeConfig({ ...readConfig(), chatgptInApp: item.checked });
              if (chatgpt && chatgpt.agent) void chatgpt.agent.setPaused(!item.checked);
            },
          },
          { type: 'separator' },
          { label: 'Open the data folder', enabled: Boolean(paths.dataDir), click: () => void shell.openPath(paths.dataDir) },
          { type: 'separator' },
          { label: 'Close window', accelerator: 'CmdOrCtrl+W', click: () => win && !win.isDestroyed() && win.close() },
          { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: quitApp },
        ],
      },
      { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
      {
        label: 'View',
        // Reload and zoom act on the page shown (the dashboard, ChatGPT or Search Console), never on the tab bar.
        submenu: [
          { label: 'Reload this page', accelerator: 'CmdOrCtrl+R', click: () => shownContents()?.reload() },
          { type: 'separator' },
          { label: 'Actual size', accelerator: 'CmdOrCtrl+0', click: () => zoomShown(0) },
          { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: () => zoomShown(0.5) },
          { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: () => zoomShown(-0.5) },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Help',
        submenu: [
          ...updateMenuItems(),
          { label: "What's new", click: () => void shell.openExternal(RELEASES) },
          { label: 'Keyboard shortcuts', click: showShortcuts },
          { label: 'User guide', click: () => (showWindow(), showDashboard('/help')) },
          { type: 'separator' },
          {
            label: 'Troubleshooting',
            submenu: [
              { label: 'Open the log', enabled: Boolean(paths.logFile), click: () => void shell.openPath(paths.logFile) },
              { label: 'Copy details for a report', click: copyDiagnostics },
              { label: 'Developer tools (page shown)', accelerator: 'CmdOrCtrl+Shift+I', click: () => shownContents()?.toggleDevTools() },
            ],
          },
          { type: 'separator' },
          { label: `About ${TITLE}`, click: () => void showAbout() },
        ],
      },
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
  paths.dataDir = dataDir;
  paths.logFile = logFile;
  appMenu();
  buildTray(dataDir, logFile);
  await createWindow(hidden);
  logLine('app', `Starting version ${app.getVersion()} (data: ${dataDir}, tool: ${appDir}, built-in Node.js ${process.versions.node}).`);
  // What's new: the first start after an update says so once, with a link to that version's notes.
  const before = readConfig().lastVersion;
  if (!smoke) writeConfig({ ...readConfig(), lastVersion: app.getVersion() });
  const from = smoke ? null : updatedFrom(before, app.getVersion());
  if (from) {
    logLine('update', `Updated from ${from} to ${app.getVersion()}.`);
    setTimeout(() => notifyOwner(`Updated to version ${app.getVersion()}`, 'Click to see what is new in this version.', () => void shell.openExternal(`${RELEASES}/tag/v${app.getVersion()}`)), 4000);
  }
  // Owner request: updates. Only an installed app updates itself (not the smoke test, not a copy run from the repository).
  updates = createUpdates({
    log: (line) => logLine('update', line),
    onState: (state) => {
      shellState();
      appMenu();
      // The dashboard's App updates card follows the download.
      if (dashboardView && !dashboardView.webContents.isDestroyed()) dashboardView.webContents.send('bas-app:update-state', state);
    },
    notify: (title, body) => notifyOwner(title, body),
    enabled: app.isPackaged && !smoke,
    version: app.getVersion(),
  });
  updates.start();

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
    attachedToRunning = true;
    if (smoke) return smokeDone(true, `attached to the running dashboard at ${ORIGIN}`);
    attachTabs(false);
    return;
  }

  const env = { ...process.env, ...envFileVars(dataDir), BAS_DATA_DIR: dataDir, BAS_PROJECT_ROOT: appDir, NODE_ENV: 'production', APP_ORIGIN: ORIGIN, BAS_DESKTOP: '1', BAS_APP_VERSION: app.getVersion(), CACHE_DIR: path.join(dataDir, 'cache'), JITI_FS_CACHE: path.join(dataDir, 'cache', 'jiti'), BAS_DESKTOP_AGENT_KEY: agentKey, NEXT_TELEMETRY_DISABLED: '1', NEXT_IGNORE_INCORRECT_LOCKFILE: '1' };
  delete env.NODE_OPTIONS;

  status('Preparing your data…', 'Migrations with a backup first, settings, the face and person detectors (once).');
  const prepared = await runToEnd('setup', toolEntry('preflight', 'scripts/preflight.ts'), env);
  if (prepared !== 0) {
    status('Preparing failed.', recent.slice(-10).join('\n'));
    await fail('The data could not be prepared.', `Nothing was deleted. Last lines of the log (${logFile}):\n\n${recent.slice(-12).join('\n')}`);
    return;
  }
  status('Starting the dashboard…');
  // With a channel to this app, so the server stops by itself when the app is gone (desktop-child-guard.cjs).
  // The installed app runs Next.js's standalone server (server.js, prepare.mjs); a copy started from the repository runs
  // `next start`. Either way only on 127.0.0.1 (HOSTNAME is set here, never taken from the computer's environment).
  const standaloneServer = path.join(appDir, 'server.js');
  const webArgs = fs.existsSync(standaloneServer) ? [standaloneServer] : ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(PORT)];
  keepRunning('web', () => spawnNode('web', [...NODE_MEMORY, '--require', childGuard, ...webArgs], { ...env, PORT: String(PORT), HOSTNAME: '127.0.0.1' }, true));
  status('Starting the worker…');
  keepRunning('worker', () => spawnNode('worker', [...NODE_MEMORY, ...toolEntry('worker', 'src/worker/index.ts')], env, true));
  if (!(await waitForDashboard(120_000))) {
    status('The dashboard did not start.', recent.slice(-10).join('\n'));
    if (smoke) smokeDone(false, 'the dashboard did not start');
    return;
  }
  attachTabs(true);
  if (smoke) {
    const until = Date.now() + 60_000;
    while (Date.now() < until && !(workerRunning && chatgpt && chatgpt.agent && chatgpt.agent.status().connected)) await new Promise((r) => setTimeout(r, 500));
    const worker = workerRunning;
    const connected = Boolean(chatgpt && chatgpt.agent && chatgpt.agent.status().connected);
    const info = await instanceAt(PORT);
    // The installed app carries the updater and makes the Search Console tab (its files are listed one by one).
    let updater = false;
    try {
      updater = typeof require('electron-updater').autoUpdater.checkForUpdates === 'function';
    } catch {
      updater = false;
    }
    const gscTab = Boolean(googleTab && chatgpt && chatgpt.agent && chatgpt.agent.capabilities().includes('gsc-request-indexing'));
    const pages = fs.existsSync(path.join(__dirname, 'offline.html')) && fs.existsSync(path.join(__dirname, 'dashboard-preload.cjs'));
    const ok = worker && connected && info && info.dataId === dataFolderId(dataDir) && updater && gscTab && pages;
    return smokeDone(Boolean(ok), `dashboard ${ORIGIN} answers; worker ${worker ? 'running' : 'not running'}; ChatGPT tab ${connected ? `connected to the dashboard (scripts v${chatgpt.version})` : 'not connected'}; data folder ${info && info.dataId === dataFolderId(dataDir) ? 'matches' : 'does not match'}; updater ${updater ? 'loaded' : 'missing'}; Search Console tab ${gscTab ? 'ready for indexing requests' : 'missing'}; reconnect page ${pages ? 'present' : 'missing'}; version ${app.getVersion()}`);
  }
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
    // A prompt in progress in the ChatGPT tab goes back to the queue first (it is reconciled, never sent twice).
    Promise.resolve(chatgpt && chatgpt.agent ? chatgpt.agent.stop() : null)
      .catch(() => {})
      .then(stopAll)
      .finally(() => {
        stopped = true;
        if (updates) updates.stop();
        if (smoke) {
          logStream?.end();
          app.exit(process.exitCode ?? 0);
        } else if (installAfterQuit && updates && updates.ready()) {
          logLine('update', 'The work is stopped; the new version is installed and started.');
          logStream?.end();
          updates.install();
        } else {
          logStream?.end();
          app.quit();
        }
      });
  });
  app.on('web-contents-created', (_e, contents) => {
    contextMenu(contents);
    // The ChatGPT and Search Console tabs have their own rules (chatgpt-tab.cjs, google-tab.cjs).
    if (!isChatGPTContents(contents) && !isGoogleContents(contents)) secureContents(contents);
  });
  ipcMain.on('bas-shell:select', (event, tab) => {
    if (win && event.sender === win.webContents) selectTab(tab);
  });
  // The dashboard's App updates card (dashboard-preload.cjs): only the dashboard tab's own page is answered.
  const fromDashboard = (event) => Boolean(dashboardView) && event.sender === dashboardView.webContents && Boolean(event.senderFrame) && event.senderFrame === dashboardView.webContents.mainFrame && isLocal(event.senderFrame.url);
  ipcMain.handle('bas-app:update-state', (event) => (fromDashboard(event) && updates ? updates.state() : null));
  ipcMain.handle('bas-app:update-check', async (event) => (fromDashboard(event) && updates ? updates.check() : null));
  ipcMain.on('bas-app:update-install', (event) => {
    if (fromDashboard(event)) restartToUpdate();
  });
  ipcMain.on('bas-shell:update', (event, action) => {
    if (!win || event.sender !== win.webContents) return;
    if (action === 'install') restartToUpdate();
    else if (action === 'check') void checkForUpdatesNow();
  });
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox(TITLE, String(error && error.stack ? error.stack : error));
    quitApp();
  });
}
