'use strict';
/**
 * The Search Console tab of the app's window (owner request 2026-11-08: “search console ko bhi app me add krde, check
 * krta hon login kr ke”). Google's own pages in a sandboxed, context-isolated tab with storage of its own
 * (persist:google, apart from ChatGPT and the dashboard), for the owner to sign in to Google here and use Search Console.
 *
 * - The app's normal user agent (never disguised as Chrome). Google may refuse sign-ins in a browser built into an app
 *   (“This browser or app may not be secure”); then Search Console stays in Automation Chrome, as before.
 * - The owner types the Google sign-in; passwords never reach the app. On Search Console's own pages the extension's
 *   Search Console script (gsc.js) runs in a world of its own, as in Automation Chrome: it types the post's URL into
 *   “Inspect any URL”, clicks REQUEST INDEXING and reports what Google answered (owner, 2026-11-12: the indexing
 *   requests are made here now that the sign-in works in the app). Google's checks are left to the owner.
 * - The tab stays on Google's pages (google-hosts.cjs); other addresses open in the default browser. No camera,
 *   microphone, location or notifications.
 */
const { WebContentsView, ipcMain, session, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { staysInGoogleTab, SEARCH_CONSOLE_URL } = require('./google-hosts.cjs');

const GOOGLE_PARTITION = 'persist:google';
/** The world the Search Console script runs in (google-preload.cjs exposes the channel there only). */
const CONTENT_WORLD = 1001;

const isGoogleContents = (contents) => contents.session === session.fromPartition(GOOGLE_PARTITION);

/** Where the extension's Search Console script runs (its manifest: https://search.google.com/search-console*). */
const scriptRunsOn = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'search.google.com' && u.pathname.startsWith('/search-console');
  } catch {
    return false;
  }
};

/**
 * @param {object} [o]
 * @param {string} [o.appDir]  the tool (its extension folder holds the Search Console script); without it no script runs
 * @param {(line: string) => void} [o.log]
 */
function createGoogleTab(o = {}) {
  const log = o.log || (() => {});
  const ses = session.fromPartition(GOOGLE_PARTITION);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
  const view = new WebContentsView({
    webPreferences: { partition: GOOGLE_PARTITION, preload: path.join(__dirname, 'google-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
  });
  const wc = view.webContents;

  // The extension's own Search Console script (gsc.js, with its page-structure helper), as Automation Chrome runs it.
  const extension = o.appDir ? path.join(o.appDir, 'extension') : null;
  const read = (file) => fs.readFileSync(file, 'utf8');
  const scripts = extension
    ? [
        { code: read(path.join(__dirname, 'content-shim.js')), url: 'bas-desktop://search-console/content-shim.js' },
        { code: read(path.join(extension, 'outline.js')), url: 'bas-desktop://search-console/outline.js' },
        { code: read(path.join(extension, 'gsc.js')), url: 'bas-desktop://search-console/gsc.js' },
      ]
    : [];

  // ---- the page → the app: only this tab's own page (main frame)
  let agent = null;
  const fromPage = (event) => event.sender === wc && event.senderFrame === wc.mainFrame;
  const onMessage = async (event, msg) => (fromPage(event) && agent ? agent.onGscMessage(msg) : { ok: false, error: 'not connected to the dashboard' });
  let nextRequest = 1;
  const pending = new Map();
  const onRespond = (event, id, answer) => {
    if (!fromPage(event)) return;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(answer);
  };
  ipcMain.handle('bas-gsc:message', onMessage);
  ipcMain.on('bas-gsc:respond', onRespond);

  // ---- the app → the page (as chrome.tabs.sendMessage)
  function send(msg, timeoutMs = 15_000) {
    if (wc.isDestroyed()) return Promise.reject(new Error('the Search Console tab is closed'));
    const id = nextRequest++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('the Search Console page did not answer'));
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      wc.send('bas-gsc:event', { kind: 'message', id, msg });
    });
  }

  wc.on('did-finish-load', () => {
    const current = wc.getURL();
    if (!scripts.length || !scriptRunsOn(current)) return;
    wc.executeJavaScriptInIsolatedWorld(CONTENT_WORLD, scripts).catch((e) => log(`The Search Console script did not start on ${current}: ${e.message}`));
  });
  wc.on('did-navigate', (_e, url) => agent && agent.onGscNavigate(url));
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => isMainFrame && agent && agent.onGscNavigate(url));

  const leave = (event) => {
    if (!event.isMainFrame || staysInGoogleTab(event.url)) return;
    event.preventDefault();
    if (/^https?:/i.test(event.url)) void shell.openExternal(event.url);
  };
  wc.on('will-navigate', leave);
  wc.on('will-redirect', leave);
  // A Google page that opens a window (some sign-in steps): shown in this tab; anything else in the default browser.
  wc.setWindowOpenHandler(({ url }) => {
    if (staysInGoogleTab(url)) void wc.loadURL(url).catch(() => {});
    else if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('render-process-gone', (_e, details) => log(`The Search Console page stopped (${details.reason}).`));

  let loaded = false;
  return {
    view,
    /** Search Console, the first time the tab is shown. */
    open() {
      if (loaded || wc.isDestroyed()) return;
      loaded = true;
      void wc.loadURL(SEARCH_CONSOLE_URL).catch((e) => log(`Search Console did not load: ${e.message}`));
    },
    /** What the agent uses to make an indexing request in this tab (chatgpt-agent.cjs, deps.gsc). */
    port: {
      load: (url) => {
        loaded = true;
        if (!wc.isDestroyed()) void wc.loadURL(url).catch((e) => log(`Search Console did not load: ${e.message}`));
      },
      send,
      url: () => (wc.isDestroyed() ? '' : wc.getURL()),
      /** The page as it stands (MHTML, as Chrome's page copy), base64, for the request's proof screenshot. */
      async saveProof() {
        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bas-gsc-')), 'page.mhtml');
        try {
          await wc.savePage(file, 'MHTML');
          return fs.readFileSync(file).toString('base64');
        } finally {
          fs.rmSync(path.dirname(file), { recursive: true, force: true });
        }
      },
    },
    /** The agent that makes the requests (messages from the page go to it). */
    connect(a) {
      agent = a;
    },
    destroy() {
      ipcMain.removeHandler('bas-gsc:message');
      ipcMain.removeListener('bas-gsc:respond', onRespond);
      if (!wc.isDestroyed()) wc.close();
    },
  };
}

module.exports = { createGoogleTab, isGoogleContents, GOOGLE_PARTITION };
