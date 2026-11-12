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
 * - Several tabs (owner report 2026-11-08: only one prompt ran at a time): app-1 is always there (the owner signs in
 *   there); the agent opens app-2 … app-5 while prompts wait (Settings → ChatGPT tabs) and closes an idle extra one.
 *   All share the one sign-in (the same partition). The window shows them as separate tabs, one at a time (main.cjs).
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
 * @param {(id: string) => void} o.front  show the ChatGPT tabs (without taking the focus); `id`: the tab that asks
 * @param {(views: import('electron').WebContentsView[]) => void} [o.onTabsChanged]  a tab was opened or closed
 * @param {object} [o.gsc]  the Search Console tab's port (google-tab.cjs): the app makes the indexing requests there
 * @param {() => void} [o.gscFront]  show the Search Console tab
 * @param {(status: object) => void} [o.onStatus]
 * @param {(line: string) => void} [o.log]
 * @param {string} [o.partition]
 */
function createChatGPTTabs(o) {
  const partition = o.partition || PARTITION;
  const ses = session.fromPartition(partition);
  const log = o.log || (() => {});
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');

  const extension = path.join(o.appDir, 'extension');
  const read = (file) => fs.readFileSync(file, 'utf8');
  const version = JSON.parse(read(path.join(extension, 'manifest.json'))).version;
  const scripts = [
    { code: read(path.join(__dirname, 'content-shim.js')), url: 'bas-desktop://chatgpt/content-shim.js' },
    // As the extension's manifest: the page-structure helper first (gallery copies when photos are missing).
    { code: read(path.join(extension, 'outline.js')), url: 'bas-desktop://chatgpt/outline.js' },
    { code: read(path.join(extension, 'adapter.js')), url: 'bas-desktop://chatgpt/adapter.js' },
    { code: read(path.join(extension, 'content.js')), url: 'bas-desktop://chatgpt/content.js' },
  ];

  /** The open tabs, in order (app-1 first): id → { view, wc }. */
  const tabs = new Map();
  let nextNumber = 1;
  let agent = null;
  const byContents = (contents) => [...tabs.entries()].find(([, t]) => t.wc === contents);

  // ---- the app → a page (as chrome.tabs.sendMessage), answered by the page's sendResponse
  let nextRequest = 1;
  const pending = new Map();
  function send(id, msg, timeoutMs = 15_000) {
    const tab = tabs.get(id);
    if (!tab || tab.wc.isDestroyed()) return Promise.reject(new Error('the ChatGPT tab is closed'));
    const requestId = nextRequest++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('the ChatGPT page did not answer'));
      }, timeoutMs);
      pending.set(requestId, { resolve, timer, wc: tab.wc });
      tab.wc.send('bas-chatgpt:event', { kind: 'message', id: requestId, msg });
    });
  }

  function open(url) {
    const id = `app-${nextNumber++}`;
    const view = new WebContentsView({
      webPreferences: { partition, preload: path.join(__dirname, 'chatgpt-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    });
    const wc = view.webContents;
    tabs.set(id, { view, wc });

    // ---- the scripts start on every ChatGPT page (Chrome: run_at document_idle, main frame only)
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument && agent) agent.onPageLoading(id);
    });
    wc.on('did-finish-load', () => {
      const current = wc.getURL();
      if (!scriptsRunOn(current)) return;
      wc.executeJavaScriptInIsolatedWorld(CONTENT_WORLD, scripts).catch((e) => log(`The ChatGPT scripts did not start on ${current} (${id}): ${e.message}`));
    });
    // A page that stops answering (its script frozen): loaded again after a minute (the agent resumes its prompt).
    let frozen = null;
    wc.on('unresponsive', () => {
      log(`The ChatGPT page of ${id} is not responding.`);
      clearTimeout(frozen);
      frozen = setTimeout(() => {
        if (wc.isDestroyed()) return;
        log(`The ChatGPT page of ${id} did not respond for a minute; it is loaded again.`);
        if (agent) agent.onPageLoading(id);
        wc.reload();
      }, 60_000);
    });
    wc.on('responsive', () => clearTimeout(frozen));
    wc.on('render-process-gone', (_e, details) => {
      log(`The ChatGPT page of ${id} stopped (${details.reason}); it is loaded again.`);
      if (agent) agent.onPageLoading(id);
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
    wc.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:/i.test(target)) void shell.openExternal(target);
      return { action: 'deny' };
    });

    if (url) void wc.loadURL(url).catch(() => {});
    if (o.onTabsChanged) o.onTabsChanged(views());
    return id;
  }

  function close(id) {
    const tab = tabs.get(id);
    if (!tab || id === 'app-1') return;
    tabs.delete(id);
    for (const [requestId, p] of [...pending.entries()]) {
      if (p.wc !== tab.wc) continue;
      pending.delete(requestId);
      clearTimeout(p.timer);
      p.resolve(null);
    }
    if (!tab.wc.isDestroyed()) tab.wc.close();
    if (o.onTabsChanged) o.onTabsChanged(views());
  }

  const views = () => [...tabs.values()].map((t) => t.view);

  agent = o.origin && o.key
    ? createChatGPTAgent({
        origin: o.origin,
        key: o.key,
        version,
        pool: {
          ids: () => [...tabs.keys()],
          open,
          close,
          load: (id, url) => {
            const tab = tabs.get(id);
            if (tab && !tab.wc.isDestroyed()) void tab.wc.loadURL(url).catch(() => {});
          },
          reload: (id) => {
            const tab = tabs.get(id);
            if (tab && !tab.wc.isDestroyed()) tab.wc.reload();
          },
          url: (id) => {
            const tab = tabs.get(id);
            return tab && !tab.wc.isDestroyed() ? tab.wc.getURL() : '';
          },
          send,
          post: (id, portId, msg) => {
            const tab = tabs.get(id);
            if (tab && !tab.wc.isDestroyed()) tab.wc.send('bas-chatgpt:event', { kind: 'port', portId, msg });
          },
          front: (id) => o.front(id),
        },
        fetchImage: async (url) => {
          // With the tabs' own ChatGPT sign-in, as the extension fetches with Chrome's.
          const res = await ses.fetch(url, { credentials: 'include' });
          return { ok: res.ok, status: res.status, mime: res.headers.get('content-type') || '', bytes: Buffer.from(await res.arrayBuffer()) };
        },
        store: o.store,
        notify: o.notify,
        onStatus: o.onStatus,
        gsc: o.gsc || null,
        gscFront: o.gscFront,
        log,
      })
    : null;

  // ---- a page → the app: only from one of these tabs' own pages (main frame); routed to that tab
  const fromPage = (event) => {
    const hit = byContents(event.sender);
    return hit && event.senderFrame === hit[1].wc.mainFrame ? hit[0] : null;
  };
  const handlers = {
    message: async (event, msg) => {
      const id = fromPage(event);
      return id && agent ? agent.onMessage(msg, id) : { ok: false, error: 'not connected to the dashboard' };
    },
    'port-open': (event, portId, name) => {
      const id = fromPage(event);
      if (id && agent) agent.onPortOpen(portId, name, id);
    },
    'port-post': (event, portId, msg) => {
      const id = fromPage(event);
      if (id && agent) agent.onPortMessage(portId, msg, id);
    },
    'port-close': (event, portId) => {
      const id = fromPage(event);
      if (id && agent) agent.onPortClose(portId, id);
    },
    respond: (event, requestId, answer) => {
      if (!fromPage(event)) return;
      const p = pending.get(requestId);
      // Only the page the request went to answers it.
      if (!p || p.wc !== event.sender) return;
      pending.delete(requestId);
      clearTimeout(p.timer);
      p.resolve(answer);
    },
  };
  ipcMain.handle('bas-chatgpt:message', handlers.message);
  for (const name of ['port-open', 'port-post', 'port-close', 'respond']) ipcMain.on(`bas-chatgpt:${name}`, handlers[name]);

  // The first tab is always there (the owner signs in to ChatGPT in it).
  open(null);
  const firstTab = () => tabs.get('app-1');

  return {
    /** The first tab's view (as before: the harness and the smoke test). */
    get view() {
      return firstTab().view;
    },
    views,
    /** A tab's view by its id (app-1, app-2 …). */
    viewOf: (id) => (tabs.get(id) || {}).view || null,
    agent,
    version,
    /** Load a page in the first tab. */
    load: (url) => firstTab().wc.loadURL(url),
    /** The open tabs' ids (app-1, app-2 …). */
    ids: () => [...tabs.keys()],
    /** A tab's renderer process (memory saver, main.cjs). */
    processId: (id) => {
      const t = tabs.get(id);
      return t && !t.wc.isDestroyed() ? t.wc.getOSProcessId() : null;
    },
    /** A tab with nothing to do loads ChatGPT's start page afresh: a long conversation's page gives its memory back. */
    freshen: (id) => {
      const t = tabs.get(id);
      if (t && !t.wc.isDestroyed()) void t.wc.loadURL('https://chatgpt.com/').catch(() => {});
    },
    destroy() {
      ipcMain.removeHandler('bas-chatgpt:message');
      for (const name of ['port-open', 'port-post', 'port-close', 'respond']) ipcMain.removeListener(`bas-chatgpt:${name}`, handlers[name]);
      for (const { wc } of tabs.values()) if (!wc.isDestroyed()) wc.close();
      tabs.clear();
    },
  };
}

/** One tab (as before 2026-11-08): the pool with its first tab. */
const createChatGPTTab = createChatGPTTabs;

module.exports = { createChatGPTTabs, createChatGPTTab, isChatGPTContents, PARTITION, CONTENT_WORLD };
