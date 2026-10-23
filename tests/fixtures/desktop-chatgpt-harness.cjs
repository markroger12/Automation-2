'use strict';
/**
 * Test harness (Electron main process, NOT part of the app): the desktop app's real ChatGPT tab (desktop/chatgpt-tab.cjs
 * with chatgpt-agent.cjs, the preload, the shim and the extension's own scripts) in a window, against the FAKE
 * ChatGPT app (tests/fixtures/fake-chatgpt/app.js) served for https://chatgpt.com/ inside the tab's own session.
 * Nothing reaches the real site. Used by tests/integration/desktop-chatgpt.test.ts.
 *
 *   electron desktop-chatgpt-harness.cjs --origin=http://127.0.0.1:PORT --key=KEY --fake=config.json --dir=TMP
 *
 * Prints one line per event: `STATUS {...}` (the agent's status), `LOG ...`, `PAGE {...}` (what the page's own world
 * sees, and the fake page's counters, every second). The test can write `reload` into TMP/command to reload the page.
 */
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

/** A plain PNG in one colour (a generated picture as the image CDN serves it; a different colour per file id). */
function png(width, height, [r, g, b]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3);
const repo = path.resolve(__dirname, '..', '..');
const dir = arg('dir');
app.setPath('userData', path.join(dir, 'user-data'));

app.whenReady().then(async () => {
  const { createChatGPTTab, PARTITION } = require(path.join(repo, 'desktop', 'chatgpt-tab.cjs'));
  const APP = fs.readFileSync(path.join(repo, 'tests', 'fixtures', 'fake-chatgpt', 'app.js'), 'utf8');
  const fake = () => JSON.parse(fs.readFileSync(arg('fake'), 'utf8'));
  session.fromPartition(PARTITION).protocol.handle('https', (req) => {
    const url = new URL(req.url);
    if (url.hostname === 'chatgpt.com' && (url.pathname === '/backend-api/estuary/content' || url.pathname === '/backend-api/files/download')) {
      const n = Number(/(\d+)/.exec(url.searchParams.get('id') || url.searchParams.get('f') || '')?.[1] ?? '1');
      const thumb = url.searchParams.get('thumb') === '1';
      return new Response(png(thumb ? 240 : 1024, thumb ? 135 : 576, [(n * 70) % 255, (n * 130) % 255, (n * 50 + 90) % 255]), { status: 200, headers: { 'content-type': 'image/png' } });
    }
    if (url.hostname !== 'chatgpt.com' || url.pathname.startsWith('/backend-api/')) return new Response('', { status: 404 });
    const config = JSON.stringify(fake()).replace(/</g, '\\u003c');
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ChatGPT</title></head><body><div id="root"></div><script>window.__FAKE=${config};</script><script>${APP}</script></body></html>`;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  });
  const win = new BrowserWindow({ width: 1200, height: 800, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
  const storeFile = path.join(dir, 'agent.json');
  const tab = createChatGPTTab({
    appDir: repo,
    origin: () => arg('origin'),
    key: arg('key'),
    store: {
      read: () => {
        try {
          return JSON.parse(fs.readFileSync(storeFile, 'utf8'));
        } catch {
          return {};
        }
      },
      write: (s) => fs.writeFileSync(storeFile, JSON.stringify(s)),
    },
    notify: (title, body) => console.log(`NOTIFY ${JSON.stringify({ title, body })}`),
    front: () => console.log('FRONT'),
    onStatus: (s) => console.log(`STATUS ${JSON.stringify(s)}`),
    log: (line) => console.log(`LOG ${line}`),
  });
  win.contentView.addChildView(tab.view);
  tab.view.setBounds({ x: 0, y: 0, width: 1200, height: 800 });
  await tab.load('https://chatgpt.com/');
  await tab.agent.start();
  const commandFile = path.join(dir, 'command');
  setInterval(() => {
    if (!fs.existsSync(commandFile)) return;
    const command = fs.readFileSync(commandFile, 'utf8').trim();
    fs.rmSync(commandFile, { force: true });
    if (command === 'reload') tab.view.webContents.reload();
  }, 300);
  setInterval(async () => {
    const wc = tab.view.webContents;
    // The page's own world: never the app's channel, never a chrome.runtime.
    const page = await wc.executeJavaScript('({ bridge: typeof window.basBridge, chrome: typeof window.chrome, runtime: typeof (window.chrome && window.chrome.runtime), stats: window.__fakeStats ? window.__fakeStats() : null, url: location.href })').catch((e) => ({ error: e.message }));
    console.log(`PAGE ${JSON.stringify(page)}`);
  }, 1000);
});
