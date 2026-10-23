'use strict';
/** The window's tab bar (shell.html): which tab to show, and the ChatGPT tab's state. Nothing else. */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('basShell', {
  select: (tab) => ipcRenderer.send('bas-shell:select', String(tab)),
  onState: (callback) => {
    ipcRenderer.on('bas-shell:state', (_event, state) => callback(state));
  },
});
