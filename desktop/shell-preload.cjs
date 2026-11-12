'use strict';
/** The window's tab bar (shell.html): which tab to show, the ChatGPT and Search Console state, and the app update
 * (install the downloaded version, or look for one). Nothing else. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('basShell', {
  select: (tab) => ipcRenderer.send('bas-shell:select', String(tab)),
  update: (action) => ipcRenderer.send('bas-shell:update', action === 'install' ? 'install' : 'check'),
  onState: (callback) => {
    ipcRenderer.on('bas-shell:state', (_event, state) => callback(state));
  },
});
