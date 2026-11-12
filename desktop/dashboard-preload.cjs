'use strict';
/**
 * The dashboard tab's only window into the app (owner report 2026-11-12: Settings → App updates showed git errors in
 * the app): the app's updater, for the App updates card (src/components/desktop-updates.tsx). Its version and state,
 * look for a new version, and Restart to update. main.cjs answers only this tab's own page. Nothing else.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('basApp', {
  updates: {
    state: () => ipcRenderer.invoke('bas-app:update-state'),
    check: () => ipcRenderer.invoke('bas-app:update-check'),
    install: () => ipcRenderer.send('bas-app:update-install'),
    onState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('bas-app:update-state', listener);
      return () => ipcRenderer.removeListener('bas-app:update-state', listener);
    },
  },
});
