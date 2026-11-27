/*
 * Runs first in the ChatGPT scripts' own world of the app's ChatGPT tab (main.cjs), before the extension's adapter.js
 * and content.js: the part of chrome.runtime those scripts use, over the app's channel (chatgpt-preload.cjs).
 *   chrome.runtime.sendMessage(msg)  → a Promise of the app's answer
 *   chrome.runtime.onMessage         ← the app's messages (ping, run, snapshot), answered with sendResponse
 *   chrome.runtime.connect({ name }) → a job channel: postMessage, onMessage (cancel), onDisconnect
 */
(function () {
  'use strict';
  if (globalThis.chrome && globalThis.chrome.__basShim) return;
  const bridge = globalThis.basBridge;
  if (!bridge) return;

  function event() {
    const fns = [];
    return {
      addListener: (fn) => fns.push(fn),
      removeListener: (fn) => {
        const i = fns.indexOf(fn);
        if (i >= 0) fns.splice(i, 1);
      },
      emit: (...args) => {
        for (const fn of fns.slice()) {
          try {
            fn(...args);
          } catch (e) {
            /* a listener's error stays in that listener */
          }
        }
      },
    };
  }

  const listeners = [];
  const ports = new Map();
  let nextPort = 1;
  const pagePrefix = Math.random().toString(36).slice(2, 10);

  bridge.onEvent((ev) => {
    if (!ev || typeof ev !== 'object') return;
    if (ev.kind === 'message') {
      let answered = false;
      const sendResponse = (answer) => {
        if (answered) return;
        answered = true;
        bridge.respond(ev.id, answer === undefined ? null : answer);
      };
      let later = false;
      for (const fn of listeners.slice()) {
        try {
          if (fn(ev.msg, { id: 'desktop-app' }, sendResponse) === true) later = true;
        } catch (e) {
          /* as in Chrome: the other listeners still run */
        }
      }
      if (!later) sendResponse(undefined);
    } else if (ev.kind === 'port') {
      const port = ports.get(ev.portId);
      if (port) port.onMessage.emit(ev.msg, port);
    } else if (ev.kind === 'port-disconnect') {
      const port = ports.get(ev.portId);
      if (port) {
        ports.delete(ev.portId);
        port.onDisconnect.emit(port);
      }
    }
  });

  globalThis.chrome = {
    __basShim: true,
    runtime: {
      sendMessage: (msg) => bridge.send(msg),
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
      connect: (info) => {
        const id = `${pagePrefix}-${nextPort++}`;
        const port = {
          name: (info && info.name) || '',
          onMessage: event(),
          onDisconnect: event(),
          postMessage: (msg) => bridge.portPost(id, msg),
          disconnect: () => {
            ports.delete(id);
            bridge.portClose(id);
          },
        };
        ports.set(id, port);
        bridge.portOpen(id, port.name);
        return port;
      },
    },
  };
})();
