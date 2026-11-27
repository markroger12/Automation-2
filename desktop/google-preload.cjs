'use strict';
/**
 * Preload of the Search Console tab (sandboxed, context-isolated). As chatgpt-preload.cjs for ChatGPT: it gives the
 * extension's Search Console script (gsc.js), which the app runs in a world of its own (CONTENT_WORLD, as Chrome runs a
 * content script), a channel to the app: messages as chrome.runtime.sendMessage (see content-shim.js). Google's page
 * itself never sees it: nothing is exposed to the page's own world.
 */
const { contextBridge, ipcRenderer } = require('electron');

const CONTENT_WORLD = 1001;

contextBridge.exposeInIsolatedWorld(CONTENT_WORLD, 'basBridge', {
  send: (msg) => ipcRenderer.invoke('bas-gsc:message', msg),
  // gsc.js opens no job channel; these exist so the shim's chrome.runtime.connect never throws.
  portOpen: () => {},
  portPost: () => {},
  portClose: () => {},
  respond: (requestId, answer) => ipcRenderer.send('bas-gsc:respond', Number(requestId), answer),
  onEvent: (callback) => {
    ipcRenderer.on('bas-gsc:event', (_event, ev) => callback(ev));
  },
});
