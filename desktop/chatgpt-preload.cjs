'use strict';
/**
 * Preload of the ChatGPT tab (sandboxed, context-isolated). It gives the extension's ChatGPT scripts, which the app runs
 * in a world of their own (CONTENT_WORLD, as Chrome runs a content script), a channel to the app: messages as
 * chrome.runtime.sendMessage, job channels as chrome.runtime.connect (see content-shim.js). The ChatGPT page itself
 * never sees it: nothing is exposed to the page's own world.
 */
const { contextBridge, ipcRenderer } = require('electron');

const CONTENT_WORLD = 1001;

contextBridge.exposeInIsolatedWorld(CONTENT_WORLD, 'basBridge', {
  send: (msg) => ipcRenderer.invoke('bas-chatgpt:message', msg),
  portOpen: (portId, name) => ipcRenderer.send('bas-chatgpt:port-open', String(portId), String(name)),
  portPost: (portId, msg) => ipcRenderer.send('bas-chatgpt:port-post', String(portId), msg),
  portClose: (portId) => ipcRenderer.send('bas-chatgpt:port-close', String(portId)),
  respond: (requestId, answer) => ipcRenderer.send('bas-chatgpt:respond', Number(requestId), answer),
  onEvent: (callback) => {
    ipcRenderer.on('bas-chatgpt:event', (_event, ev) => callback(ev));
  },
});
