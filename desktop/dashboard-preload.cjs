'use strict';
/**
 * The dashboard tab's only window into the app (owner report 2026-11-12: Settings → App updates showed git errors in
 * the app): the app's updater, for the App updates card (src/components/desktop-updates.tsx). Its version and state,
 * look for a new version, and Restart to update; and showing the ChatGPT or Search Console tab (the setup checklist).
 * main.cjs answers only this tab's own page. Nothing else.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('basApp', {
  // The setup checklist's “Open the ChatGPT tab” / “Open the Search Console tab” (main.cjs allows only these two).
  tabs: {
    show: (tab) => ipcRenderer.send('bas-app:show-tab', tab),
  },
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
