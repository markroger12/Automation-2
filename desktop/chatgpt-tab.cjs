'use strict';
/**
 * The ChatGPT tab of the app's window (owner request: “the browser inside the app”; ChatGPT sign-in by email and
 * password). The owner signs in to ChatGPT here once; the sign-in stays in the tab's own storage (partition
 * persist:chatgpt in the app's folder), apart from the dashboard.
 *
 * - The page is ChatGPT's own, in a sandboxed, context-isolated tab with this app's normal user agent (never
 *   disguised as Chrome).
 * - On every ChatGPT page, the extension's ChatGPT scripts (extension/adapter.js and content.js, the same files
 *   Automation Chrome runs) are started in a world of their own, as Chrome starts a content script, with
 *   content-shim.js for the part of chrome.runtime they use. The page never sees that world or the app's channel.
 * - The tab stays on ChatGPT and OpenAI's sign-in; other addresses open in the default browser. Only copying text is
 *   allowed (no camera, microphone, location or notifications).
 * - chatgpt-agent.cjs is the background: it talks to the dashboard and answers the scripts.
 */
const { WebContentsView, ipcMain, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { createChatGPTAgent } = require('./chatgpt-agent.cjs');

const PARTITION = 'persist:chatgpt';
/** The world the ChatGPT scripts run in (chatgpt-preload.cjs exposes the channel there only). */
const CONTENT_WORLD = 1001;

/** ChatGPT and OpenAI's sign-in stay in the tab. */
function stays(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'chatgpt.com' || u.hostname.endsWith('.chatgpt.com') || u.hostname === 'auth.openai.com' || u.hostname === 'auth0.openai.com' || u.hostname === 'openai.com');
  } catch {
    return false;
  }
}

/** Where the extension's ChatGPT scripts run (its manifest: https://chatgpt.com/*). */
const scriptsRunOn = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'chatgpt.com';
  } catch {
    return false;
  }
};

const isChatGPTContents = (contents) => contents.session === session.fromPartition(PARTITION);

/**
 * @param {object} o
 * @param {string} o.appDir  the tool (its extension folder holds the ChatGPT scripts)
 * @param {(() => string) | null} o.origin  the dashboard; null: no agent (the window shows a dashboard started elsewhere)
 * @param {string | null} o.key  the key this app gave the dashboard
 * @param {{ read: () => object, write: (s: object) => void }} o.store
 * @param {(title: string, body: string) => void} o.notify
 * @param {() => void} o.front  show the ChatGPT tab (without taking the focus)
 * @param {(status: object) => void} [o.onStatus]
 * @param {(line: string) => void} [o.log]
 * @param {string} [o.partition]
 */
function createChatGPTTab(o) {
  const partition = o.partition || PARTITION;
  const ses = session.fromPartition(partition);
  const log = o.log || (() => {});
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
  const view = new WebContentsView({
    webPreferences: { partition, preload: path.join(__dirname, 'chatgpt-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
  });
  const wc = view.webContents;

  const extension = path.join(o.appDir, 'extension');
  const read = (file) => fs.readFileSync(file, 'utf8');
  const version = JSON.parse(read(path.join(extension, 'manifest.json'))).version;
  const scripts = [
    { code: read(path.join(__dirname, 'content-shim.js')), url: 'bas-desktop://chatgpt/content-shim.js' },
    { code: read(path.join(extension, 'adapter.js')), url: 'bas-desktop://chatgpt/adapter.js' },
    { code: read(path.join(extension, 'content.js')), url: 'bas-desktop://chatgpt/content.js' },
  ];

  // ---- the app → the page (as chrome.tabs.sendMessage), answered by the page's sendResponse
  let nextRequest = 1;
  const pending = new Map();
  function send(msg, timeoutMs = 15_000) {
    if (wc.isDestroyed()) return Promise.reject(new Error('the ChatGPT tab is closed'));
    const id = nextRequest++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error('the ChatGPT page did not answer'));
      }, timeoutMs);
      pending.set(id, { resolve, timer });
      wc.send('bas-chatgpt:event', { kind: 'message', id, msg });
    });
  }

  const agent = o.origin && o.key
    ? createChatGPTAgent({
        origin: o.origin,
        key: o.key,
        version,
        tab: {
          load: (url) => void wc.loadURL(url).catch(() => {}),
          reload: () => wc.reload(),
          url: () => wc.getURL(),
          send,
          post: (portId, msg) => !wc.isDestroyed() && wc.send('bas-chatgpt:event', { kind: 'port', portId, msg }),
          front: o.front,
        },
        fetchImage: async (url) => {
          // With the tab's own ChatGPT sign-in, as the extension fetches with Chrome's.
          const res = await ses.fetch(url, { credentials: 'include' });
          return { ok: res.ok, status: res.status, mime: res.headers.get('content-type') || '', bytes: Buffer.from(await res.arrayBuffer()) };
        },
        store: o.store,
        notify: o.notify,
        onStatus: o.onStatus,
        log,
      })
    : null;

  // ---- the page → the app: only from this tab's own page (main frame)
  const fromPage = (event) => event.sender === wc && event.senderFrame === wc.mainFrame;
  const handlers = {
    message: async (event, msg) => (fromPage(event) && agent ? agent.onMessage(msg) : { ok: false, error: 'not connected to the dashboard' }),
    'port-open': (event, portId, name) => fromPage(event) && agent && agent.onPortOpen(portId, name),
    'port-post': (event, portId, msg) => fromPage(event) && agent && agent.onPortMessage(portId, msg),
    'port-close': (event, portId) => fromPage(event) && agent && agent.onPortClose(portId),
    respond: (event, id, answer) => {
      if (!fromPage(event)) return;
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(answer);
    },
  };
  ipcMain.handle('bas-chatgpt:message', handlers.message);
  for (const name of ['port-open', 'port-post', 'port-close', 'respond']) ipcMain.on(`bas-chatgpt:${name}`, handlers[name]);

  // ---- the scripts start on every ChatGPT page (Chrome: run_at document_idle, main frame only)
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument && agent) agent.onPageLoading();
  });
  wc.on('did-finish-load', () => {
    const url = wc.getURL();
    if (!scriptsRunOn(url)) return;
    wc.executeJavaScriptInIsolatedWorld(CONTENT_WORLD, scripts).catch((e) => log(`The ChatGPT scripts did not start on ${url}: ${e.message}`));
  });
  wc.on('render-process-gone', (_e, details) => {
    log(`The ChatGPT page stopped (${details.reason}); it is loaded again.`);
    if (agent) agent.onPageLoading();
    setTimeout(() => !wc.isDestroyed() && wc.reload(), 1500);
  });

  // ---- the tab stays on ChatGPT
  const leave = (event) => {
    if (!event.isMainFrame || stays(event.url)) return;
    event.preventDefault();
    if (/^https?:/i.test(event.url)) void shell.openExternal(event.url);
  };
  wc.on('will-navigate', leave);
  wc.on('will-redirect', leave);
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  return {
    view,
    agent,
    version,
    load: (url) => wc.loadURL(url),
    destroy() {
      ipcMain.removeHandler('bas-chatgpt:message');
      for (const name of ['port-open', 'port-post', 'port-close', 'respond']) ipcMain.removeListener(`bas-chatgpt:${name}`, handlers[name]);
      if (!wc.isDestroyed()) wc.close();
    },
  };
}

module.exports = { createChatGPTTab, isChatGPTContents, PARTITION, CONTENT_WORLD };
