'use strict';
/**
 * The Search Console tab of the app's window (owner request 2026-11-08: “search console ko bhi app me add krde, check
 * krta hon login kr ke”). Google's own pages in a sandboxed, context-isolated tab with storage of its own
 * (persist:google, apart from ChatGPT and the dashboard), for the owner to sign in to Google here and use Search Console.
 *
 * - The app's normal user agent (never disguised as Chrome). Google may refuse sign-ins in a browser built into an app
 *   (“This browser or app may not be secure”); then Search Console stays in Automation Chrome, as before.
 * - Nothing runs in these pages and the app reads nothing from them: no preload, no scripts. The owner types the
 *   Google sign-in; passwords never reach the app.
 * - The tab stays on Google's pages (google-hosts.cjs); other addresses open in the default browser. No camera,
 *   microphone, location or notifications.
 */
const { WebContentsView, session, shell } = require('electron');
const { staysInGoogleTab, SEARCH_CONSOLE_URL } = require('./google-hosts.cjs');

const GOOGLE_PARTITION = 'persist:google';

const isGoogleContents = (contents) => contents.session === session.fromPartition(GOOGLE_PARTITION);

/** @param {{ log?: (line: string) => void }} [o] */
function createGoogleTab(o = {}) {
  const log = o.log || (() => {});
  const ses = session.fromPartition(GOOGLE_PARTITION);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'clipboard-sanitized-write'));
  ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
  const view = new WebContentsView({ webPreferences: { partition: GOOGLE_PARTITION, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } });
  const wc = view.webContents;

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
    destroy() {
      if (!wc.isDestroyed()) wc.close();
    },
  };
}

module.exports = { createGoogleTab, isGoogleContents, GOOGLE_PARTITION };
