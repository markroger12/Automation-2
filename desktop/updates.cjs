'use strict';
/**
 * App updates (owner request 2026-11-12: “app me bhi update vala feature add krde”). The Windows workflow builds the
 * installer from the main line and publishes it as a GitHub release of this (public) repository with its update file
 * (latest.yml). The app looks at start (after 30 s) and every 6 hours, downloads a newer version in the background and
 * says so; “Restart to update” installs it once the app has stopped its work safely (prompts back to the queue, the
 * worker stopped), then starts the new version. The data folder is never touched.
 */

/**
 * @param {object} o
 * @param {(line: string) => void} o.log
 * @param {(state: object) => void} o.onState
 * @param {(title: string, body: string) => void} o.notify
 * @param {boolean} o.enabled  an installed app (not the smoke test, not a copy started from the repository)
 * @param {string} o.version  this app's version
 * @param {object} [o.updater]  tests only: an updater in place of electron-updater's
 */
function createUpdates(o) {
  let updater = o.updater || null;
  if (o.enabled && !updater) {
    try {
      updater = require('electron-updater').autoUpdater;
    } catch (e) {
      o.log(`Updates are not available in this copy: ${e.message}`);
    }
  }
  if (!o.enabled) updater = null;
  let state = { state: updater ? 'idle' : 'unavailable', current: o.version, version: null, percent: null, message: null, checkedAt: null };
  const set = (patch) => {
    state = { ...state, ...patch };
    o.onState(state);
  };

  if (updater) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    updater.logger = { info: (m) => o.log(String(m)), warn: (m) => o.log(`warning: ${m}`), error: (m) => o.log(`error: ${m}`), debug: () => {} };
    updater.on('checking-for-update', () => set({ state: 'checking', message: null }));
    updater.on('update-not-available', () => set({ state: 'current', version: null, percent: null, checkedAt: new Date().toISOString() }));
    updater.on('update-available', (info) => set({ state: 'downloading', version: info.version, percent: 0, checkedAt: new Date().toISOString() }));
    updater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.max(0, Math.min(100, Math.round(p.percent || 0))) }));
    updater.on('update-downloaded', (info) => {
      set({ state: 'ready', version: info.version, percent: 100 });
      o.notify('App update ready', `Version ${info.version} is downloaded. Click “Restart to update” at the top of the app; your data stays as it is.`);
    });
    updater.on('error', (e) => set({ state: 'error', message: String((e && e.message) || e).split('\n')[0].slice(0, 200) }));
  }

  async function check() {
    if (!updater || state.state === 'downloading' || state.state === 'ready') return state;
    try {
      await updater.checkForUpdates();
    } catch (e) {
      set({ state: 'error', message: String((e && e.message) || e).split('\n')[0].slice(0, 200) });
    }
    return state;
  }

  let first = null;
  let every = null;
  return {
    state: () => state,
    start() {
      if (!updater) return;
      first = setTimeout(() => void check(), 30_000);
      every = setInterval(() => void check(), 6 * 3600_000);
    },
    check,
    ready: () => state.state === 'ready',
    /** Installs the downloaded version silently and starts it (call once the app has stopped its work). */
    install() {
      if (updater && state.state === 'ready') updater.quitAndInstall(true, true);
    },
    stop() {
      clearTimeout(first);
      clearInterval(every);
    },
  };
}

module.exports = { createUpdates };
