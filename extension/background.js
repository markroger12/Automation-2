/*
 * Blog Automation Studio — background service worker (Manifest V3).
 *
 * - Talks ONLY to the configured localhost dashboard with the bearer
 *   connection key (never to any other origin).
 * - Polls every 30 s when idle (chrome.alarms) and every few seconds only
 *   while it owns work.
 * - Manages 1–5 ChatGPT tabs it opened itself (never hijacks the owner's own
 *   tabs), reuses a tab that already shows the needed conversation, and never
 *   restarts tabs or itself to "fix" a routine error.
 * - Completions/failures go through a persistent outbox so an answer is not
 *   lost if the dashboard is briefly unreachable.
 * - Login pages and human checks are never automated: it notifies the owner.
 */
'use strict';

const EXTENSION_VERSION = '3.2.7';
const DEFAULT_SERVER = 'http://localhost:3000';
const CAPABILITIES = ['claim', 'progress', 'complete', 'fail', 'release', 'reconcile', 'attachments', 'images', 'gallery', 'multi-tab', 'continue-generating', 'outbox'];

let cfg = null;
let serverCfg = {
  chatgptUrl: 'https://chatgpt.com/',
  maxTabs: 1,
  wantedTabs: 1,
  pollIdleSec: 30,
  pollBusySec: 3,
  generationTimeoutSec: 600,
  humanCheckPauseMinutes: 10,
  backoffUntil: null,
  claimsPaused: false,
  waitingJobs: 0,
  warning: null,
};
let versionMessage = null;
let lastError = null;
let lastHelloAt = 0;
let pageLogin = null;
let pageHumanCheck = false;
let ticking = false;
let busyTimer = null;
/** tabId → { ready, url, busy, jobId, job, port, terminal, waiters } */
const tabs = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- storage ----------------

async function loadConfig() {
  const stored = await chrome.storage.local.get(['serverOrigin', 'key', 'installId', 'paused']);
  if (!stored.installId) {
    stored.installId = crypto.randomUUID();
    await chrome.storage.local.set({ installId: stored.installId });
  }
  cfg = {
    serverOrigin: (stored.serverOrigin || DEFAULT_SERVER).replace(/\/+$/, ''),
    key: stored.key || null,
    installId: stored.installId,
    paused: Boolean(stored.paused),
  };
  return cfg;
}

function isLocalOrigin(origin) {
  try {
    const u = new URL(origin);
    return (u.protocol === 'http:' || u.protocol === 'https:') && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch (e) {
    return false;
  }
}

async function sessionGet(key, fallback) {
  const v = await chrome.storage.session.get(key);
  return v[key] === undefined ? fallback : v[key];
}

async function sessionSet(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

/** In-flight checkpoints (survive service-worker restarts; cleared with the browser session). */
async function checkpoint(jobId, patch) {
  const all = await sessionGet('checkpoints', {});
  all[jobId] = Object.assign({}, all[jobId] || {}, patch, { updatedAt: new Date().toISOString() });
  await sessionSet('checkpoints', all);
  return all[jobId];
}

async function getCheckpoint(jobId) {
  return (await sessionGet('checkpoints', {}))[jobId] || null;
}

async function dropCheckpoint(jobId) {
  const all = await sessionGet('checkpoints', {});
  delete all[jobId];
  await sessionSet('checkpoints', all);
}

async function managedTabIds() {
  return sessionGet('managedTabs', []);
}

async function setManagedTabIds(ids) {
  await sessionSet('managedTabs', Array.from(new Set(ids)));
}

// ---------------- server API ----------------

async function api(action, body, path) {
  if (!cfg || !cfg.key) throw Object.assign(new Error('Not paired: paste the connection key in the extension popup.'), { status: 401 });
  if (!isLocalOrigin(cfg.serverOrigin)) throw Object.assign(new Error('The dashboard address must be localhost.'), { status: 400 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(cfg.serverOrigin + (path || '/api/extension/agent'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
      body: JSON.stringify(Object.assign({ action, installId: cfg.installId }, body || {})),
      signal: ctrl.signal,
      credentials: 'omit',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'HTTP ' + res.status), { status: res.status, data });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/** Persistent outbox for completions/failures (retried until the dashboard answers). */
async function outboxPush(action, body) {
  const { outbox = [] } = await chrome.storage.local.get('outbox');
  outbox.push({ action, body, at: Date.now(), attempts: 0 });
  await chrome.storage.local.set({ outbox });
  await flushOutbox();
}

async function flushOutbox() {
  const { outbox = [] } = await chrome.storage.local.get('outbox');
  if (!outbox.length) return;
  const remaining = [];
  for (const item of outbox) {
    try {
      await api(item.action, item.body);
    } catch (e) {
      const retryable = !e.status || e.status >= 500 || e.status === 429;
      item.attempts++;
      if (retryable && item.attempts < 200) remaining.push(item);
      else lastError = `Dropped ${item.action} after server refused it: ${e.message}`;
    }
  }
  await chrome.storage.local.set({ outbox: remaining });
}

// ---------------- tabs ----------------

function tabState(tabId) {
  if (!tabs.has(tabId)) tabs.set(tabId, { ready: false, url: '', busy: false, started: false, jobId: null, job: null, port: null, terminal: false, waiters: [] });
  return tabs.get(tabId);
}

function sameConversation(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname.replace(/\/$/, '') === ub.pathname.replace(/\/$/, '');
  } catch (e) {
    return false;
  }
}

async function refreshTabs() {
  const ids = await managedTabIds();
  const alive = [];
  for (const id of ids) {
    try {
      const tab = await chrome.tabs.get(id);
      const t = tabState(id);
      if (!t.createdAt) t.createdAt = Date.now();
      const url = tab.url || tab.pendingUrl || '';
      if (!url.startsWith('https://chatgpt.com/') && !url.startsWith('chrome-error://') && url !== 'about:blank' && url !== '') continue;
      alive.push(id);
      t.url = url;
      // An IDLE managed tab whose page never became ready (failed first load, network blip):
      // reload it, at most 5 times. Busy tabs are never reloaded.
      if (!t.busy && !t.ready && tab.status === 'complete' && Date.now() - (t.lastReloadAt || t.createdAt) > 12_000 && (t.reloads || 0) < 5) {
        t.reloads = (t.reloads || 0) + 1;
        t.lastReloadAt = Date.now();
        await chrome.tabs.reload(id);
      }
    } catch (e) {
      tabs.delete(id);
    }
  }
  if (alive.length !== ids.length) await setManagedTabIds(alive);
  return alive;
}

async function ensureTabs(managed) {
  const busy = managed.filter((id) => tabState(id).busy).length;
  const wanted = Math.min(serverCfg.maxTabs || 1, Math.max(serverCfg.wantedTabs || 1, busy));
  if ((serverCfg.waitingJobs || 0) === 0 && managed.length > 0) return managed;
  if (managed.length >= wanted) return managed;
  // Open at most one new tab per tick (never spin up many tabs at once).
  const tab = await chrome.tabs.create({ url: serverCfg.chatgptUrl || 'https://chatgpt.com/', active: false });
  // A working tab must not be discarded by Chrome's memory saver (that unloads the page in the middle of a job).
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  tabState(tab.id).createdAt = Date.now();
  await setManagedTabIds([...managed, tab.id]);
  return [...managed, tab.id];
}

function waitReady(tabId, timeoutMs, expectedUrl) {
  const t = tabState(tabId);
  if (t.ready && (!expectedUrl || sameConversation(t.url, expectedUrl))) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ChatGPT tab did not load within ' + Math.round(timeoutMs / 1000) + 's')), timeoutMs);
    t.waiters.push((url) => {
      if (expectedUrl && !sameConversation(url, expectedUrl) && !/^https:\/\/chatgpt\.com\/?$/.test(expectedUrl)) return false;
      clearTimeout(timer);
      resolve(true);
      return true;
    });
  });
}

function targetUrl(job, currentUrl) {
  const root = serverCfg.chatgptUrl || 'https://chatgpt.com/';
  if (job.reconcile && job.reconcile.conversationUrl) return job.reconcile.conversationUrl;
  if (job.newChat || !job.conversationUrl) return root;
  return job.conversationUrl;
}

async function runOnTab(tabId, job) {
  const t = tabState(tabId);
  t.busy = true;
  t.jobId = job.id;
  t.job = job;
  t.terminal = false;
  const cp = await checkpoint(job.id, { tabId, operationId: job.operationId, job, step: 'claimed' });
  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  try {
    const target = targetUrl(job, t.url);
    const isRoot = /^https:\/\/chatgpt\.com\/?$/.test(target);
    // After the page stopped working (no composer / no Send button) the next job gets a freshly loaded page, even
    // in the same conversation: before 3.2.5 every retry ran on the same stuck page (owner report).
    const fresh = t.freshPage;
    t.freshPage = false;
    if (isRoot || !sameConversation(target, t.url) || fresh) {
      t.ready = false;
      await checkpoint(job.id, { step: 'navigating', target });
      if (fresh && !isRoot && sameConversation(target, t.url)) await chrome.tabs.reload(tabId);
      else await chrome.tabs.update(tabId, { url: target });
      await waitReady(tabId, 60_000, target);
    } else if (!t.ready) {
      await waitReady(tabId, 60_000);
    }
    t.started = true;
    await sendRun(tabId, job, cp, job.reconcile ? 'the app offered the job again (the earlier run did not report back)' : null);
  } catch (e) {
    t.busy = false;
    t.job = null;
    t.freshPage = true;
    await outboxPush('fail', { jobId: job.id, tabId: String(tabId), code: 'ERROR', message: 'Tab could not start the job: ' + e.message });
    await dropCheckpoint(job.id);
  }
}

/** `resumedBy` says why a job runs again (shown to the owner if the sent prompt cannot be found). */
async function sendRun(tabId, job, cp, resumedBy) {
  const local = cp && cp.sentAt ? { sentAt: cp.sentAt, userTurnsBefore: cp.userTurnsBefore, conversationUrl: cp.conversationUrl || null } : null;
  const res = await chrome.tabs.sendMessage(tabId, { type: 'run', job: Object.assign({}, job, { localCheckpoint: local, resumedBy: resumedBy || null }), config: serverCfg });
  if (!res || !res.ok) throw new Error('content script refused the job: ' + (res && res.error));
}

async function finishTab(tabId, jobId) {
  const t = tabState(tabId);
  if (t.jobId === jobId) {
    t.busy = false;
    t.started = false;
    t.jobId = null;
    t.job = null;
    t.terminal = true;
  }
  // Even when this worker restarted and has not restored the tab yet: the job is finished, never resume it.
  await dropCheckpoint(jobId);
}

// ---------------- main loop ----------------

async function pageSignals(managed) {
  for (const id of managed) {
    try {
      const pong = await chrome.tabs.sendMessage(id, { type: 'ping' });
      if (pong && pong.state) {
        pageLogin = pong.state === 'login' ? false : pong.state === 'ready' ? true : pageLogin;
        pageHumanCheck = pong.state === 'challenge';
        return pong;
      }
    } catch (e) {
      /* tab still loading */
    }
  }
  return null;
}

async function hello(managed) {
  await pageSignals(managed);
  const res = await api('hello', {
    version: EXTENSION_VERSION,
    protocol: 1,
    capabilities: CAPABILITIES,
    tabs: managed.map((id) => ({ tabId: String(id), url: tabState(id).url || null, state: tabState(id).busy ? 'busy' : tabState(id).ready ? 'idle' : 'loading', jobId: tabState(id).jobId })),
    loggedIn: pageLogin,
    humanCheck: pageHumanCheck,
    claimsPaused: cfg.paused,
    backoffUntil: serverCfg.backoffUntil,
    lastError,
    diagnostics: { outbox: ((await chrome.storage.local.get('outbox')).outbox || []).length },
  });
  lastHelloAt = Date.now();
  serverCfg = Object.assign({}, serverCfg, res.config || {});
  versionMessage = res.versionOk === false ? res.message : null;
  return res;
}

async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeText({ text });
    if (color) await chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {
    /* ignore */
  }
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    await loadConfig();
    if (!cfg.key) {
      await setBadge('KEY', '#b45309');
      return;
    }
    await flushOutbox();
    let managed = await refreshTabs();
    const anyBusy = managed.some((id) => tabState(id).busy);
    if (anyBusy || Date.now() - lastHelloAt > 20_000 || !lastHelloAt) await hello(managed);
    if (versionMessage) {
      await setBadge('VER', '#b91c1c');
      return;
    }
    if (cfg.paused || serverCfg.claimsPaused) {
      await setBadge('II', '#6b7280');
      return;
    }
    if (serverCfg.backoffUntil && new Date(serverCfg.backoffUntil) > new Date()) {
      await setBadge('WAIT', '#b45309');
      return;
    }
    managed = await ensureTabs(managed);
    await setBadge(anyBusy ? String(managed.filter((id) => tabState(id).busy).length) : '', '#4f46e5');
    for (const id of managed) {
      const t = tabState(id);
      if (t.busy || !t.ready) continue;
      const open = managed.map((m) => tabState(m).url).filter(Boolean);
      const res = await api('claim', { tabId: String(id), openConversationUrls: open });
      if (!res.job) {
        if (res.reason === 'backoff' && res.retryAfterSec) serverCfg.backoffUntil = new Date(Date.now() + res.retryAfterSec * 1000).toISOString();
        if (res.reason === 'version-mismatch') versionMessage = res.message;
        break;
      }
      void runOnTab(id, res.job);
    }
    lastError = null;
  } catch (e) {
    lastError = e.message;
    await setBadge('ERR', '#b91c1c');
  } finally {
    ticking = false;
    scheduleNext();
  }
}

function scheduleNext() {
  if (busyTimer) clearTimeout(busyTimer);
  const busy = Array.from(tabs.values()).some((t) => t.busy);
  if (busy || (serverCfg.waitingJobs || 0) > 0) busyTimer = setTimeout(() => void tick(), Math.max(1, serverCfg.pollBusySec || 3) * 1000);
}

// ---------------- messages from content scripts / popup ----------------

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('bas-job:') || !port.sender || !port.sender.tab) return;
  const tabId = port.sender.tab.id;
  const jobId = port.name.slice('bas-job:'.length);
  const t = tabState(tabId);
  t.port = port;
  // Handle this job's messages strictly in order (no concurrent read-modify-write races).
  let chain = Promise.resolve();
  port.onMessage.addListener((msg) => {
    chain = chain.then(() => handlePortMessage(msg)).catch((e) => (lastError = e.message));
  });
  async function handlePortMessage(msg) {
    try {
      await loadConfig();
      if (msg.type === 'progress') {
        if (msg.sent) await checkpoint(jobId, Object.assign({ sent: true, sentAt: msg.sentAt || new Date().toISOString() }, msg.conversationUrl ? { conversationUrl: msg.conversationUrl } : {}));
        const res = await api('progress', { tabId: String(tabId), jobId, step: String(msg.step || '').slice(0, 200), sent: Boolean(msg.sent), sentAt: msg.sentAt, conversationUrl: msg.conversationUrl || null, diagnostics: msg.snapshot || {} }).catch((e) => ({ ok: false, error: e.message }));
        if (res && res.cancel) port.postMessage({ type: 'cancel' });
      } else if (msg.type === 'needs-human') {
        pageLogin = msg.kind === 'login' ? false : pageLogin;
        pageHumanCheck = msg.kind !== 'login';
        chrome.notifications.create(`bas-human-${tabId}`, {
          type: 'basic',
          iconUrl: 'icons/icon-128.png',
          title: 'Blog Automation Studio needs you',
          message: msg.message + ' Please complete it in the Automation Chrome window. The job waits up to ' + (serverCfg.humanCheckPauseMinutes || 10) + ' minutes.',
          priority: 2,
        });
        await hello(await managedTabIds()).catch(() => {});
      } else if (msg.type === 'human-resolved') {
        pageHumanCheck = false;
        pageLogin = true;
        chrome.notifications.clear(`bas-human-${tabId}`);
      } else if (msg.type === 'complete') {
        await outboxPush('complete', {
          tabId: String(tabId),
          jobId,
          text: msg.text,
          html: msg.html || null,
          images: Array.isArray(msg.images) && msg.images.length ? msg.images : undefined,
          imageLinks: Array.isArray(msg.imageLinks) && msg.imageLinks.length ? msg.imageLinks.slice(0, 20) : undefined,
          conversationUrl: msg.conversationUrl || null,
          recovered: Boolean(msg.recovered),
          elapsedMs: msg.elapsedMs,
        });
        await finishTab(tabId, jobId);
        setTimeout(() => void tick(), 500);
      } else if (msg.type === 'fail') {
        await outboxPush('fail', { tabId: String(tabId), jobId, code: msg.code || 'ERROR', message: String(msg.message || 'Unknown error').slice(0, 2000), retryAfterSec: msg.retryAfterSec ?? null, uncertain: Boolean(msg.uncertain), diagnostics: msg.snapshot || {} });
        if (msg.code === 'USAGE_LIMIT') serverCfg.backoffUntil = new Date(Date.now() + (msg.retryAfterSec || 60) * 1000).toISOString();
        if (msg.freshPage) t.freshPage = true;
        await finishTab(tabId, jobId);
        setTimeout(() => void tick(), 1000);
      }
    } catch (e) {
      lastError = e.message;
    }
  }
  port.onDisconnect.addListener(() => {
    if (t.port === port) t.port = null;
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  const tabId = sender.tab ? sender.tab.id : null;
  (async () => {
    await loadConfig();
    switch (msg.type) {
      case 'content-ready': {
        if (tabId === null) return sendResponse({ ok: false });
        const t = tabState(tabId);
        t.ready = true;
        t.url = msg.url;
        t.waiters = t.waiters.filter((w) => !w(msg.url));
        // Resume a job whose content script was reloaded mid-run (it reconciles before any resend).
        if (t.busy && t.job && t.started && !t.port) {
          const cp = await getCheckpoint(t.job.id);
          if (cp && cp.step !== 'navigating') setTimeout(() => sendRun(tabId, t.job, cp, 'the ChatGPT page reloaded').catch((e) => (lastError = e.message)), 500);
        }
        return sendResponse({ ok: true });
      }
      case 'url-changed':
        if (tabId !== null) tabState(tabId).url = msg.url;
        return sendResponse({ ok: true });
      case 'come-to-front': {
        // ChatGPT draws a picture only in a visible tab (owner's earlier tool did the same).
        if (tabId === null) return sendResponse({ ok: false });
        await chrome.tabs.update(tabId, { active: true }).catch(() => {});
        return sendResponse({ ok: true });
      }
      case 'checkpoint':
        // Only the fields given: a step-only checkpoint (e.g. 'reloading') must never erase a recorded sentAt.
        await checkpoint(msg.jobId, Object.fromEntries(Object.entries({ step: msg.step, sentAt: msg.sentAt, userTurnsBefore: msg.userTurnsBefore }).filter(([, v]) => v !== undefined)));
        return sendResponse({ ok: true });
      case 'pre-send-check': {
        const res = await api('progress', { tabId: String(tabId), jobId: msg.jobId, step: 'about to send' }).catch(() => null);
        return sendResponse({ cancel: Boolean(res && res.cancel), ok: Boolean(res && res.ok) });
      }
      case 'fetch-attachment': {
        try {
          const res = await fetch(cfg.serverOrigin + msg.url, { headers: { Authorization: 'Bearer ' + cfg.key }, credentials: 'omit' });
          if (!res.ok) return sendResponse({ ok: false, error: 'HTTP ' + res.status });
          const buf = new Uint8Array(await res.arrayBuffer());
          if (buf.length > 12 * 1024 * 1024) return sendResponse({ ok: false, error: 'attachment too large' });
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
          return sendResponse({ ok: true, base64: btoa(bin) });
        } catch (e) {
          return sendResponse({ ok: false, error: e.message });
        }
      }
      case 'fetch-image': {
        // Pictures on ChatGPT's own image hosts only: generated images and the image-search gallery
        // (host permissions limit this further).
        try {
          const url = new URL(msg.url);
          const allowed =
            url.protocol === 'https:' &&
            (/\.oaiusercontent\.com$/.test(url.hostname) || url.hostname === 'oaidalleapiprodscus.blob.core.windows.net' || url.hostname === 'chatgpt.com' || url.hostname === 'images.openai.com' || /(^|\.)mm\.bing\.net$/.test(url.hostname));
          if (!allowed) return sendResponse({ ok: false, error: 'not an image host of ChatGPT' });
          const res = await fetch(url.toString(), { credentials: 'include' });
          if (!res.ok) return sendResponse({ ok: false, error: 'HTTP ' + res.status });
          const buf = new Uint8Array(await res.arrayBuffer());
          if (buf.length > 12 * 1024 * 1024) return sendResponse({ ok: false, error: 'image too large' });
          let bin = '';
          for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
          return sendResponse({ ok: true, base64: btoa(bin), mime: res.headers.get('content-type') || 'image/png' });
        } catch (e) {
          return sendResponse({ ok: false, error: e.message });
        }
      }
      case 'upload-image': {
        try {
          const res = await api('upload', { tabId: String(tabId), jobId: msg.jobId, name: msg.name, mime: msg.mime, dataBase64: msg.dataBase64, sourceUrl: msg.sourceUrl }, '/api/extension/upload');
          return sendResponse({ ok: true, mediaAssetId: res.mediaAssetId });
        } catch (e) {
          return sendResponse({ ok: false, error: e.message });
        }
      }
      case 'popup-state': {
        const managed = await managedTabIds();
        const { outbox = [] } = await chrome.storage.local.get('outbox');
        return sendResponse({
          version: EXTENSION_VERSION,
          serverOrigin: cfg.serverOrigin,
          paired: Boolean(cfg.key),
          keyPrefix: cfg.key ? cfg.key.slice(0, 8) : null,
          paused: cfg.paused,
          serverPaused: serverCfg.claimsPaused,
          versionMessage,
          lastError,
          lastHelloAt,
          backoffUntil: serverCfg.backoffUntil,
          tabs: managed.map((id) => ({ id, busy: tabState(id).busy, ready: tabState(id).ready, url: tabState(id).url })),
          outbox: outbox.length,
          warning: serverCfg.warning,
          loggedIn: pageLogin,
          humanCheck: pageHumanCheck,
        });
      }
      case 'popup-save': {
        const origin = String(msg.serverOrigin || DEFAULT_SERVER).trim().replace(/\/+$/, '');
        if (!isLocalOrigin(origin)) return sendResponse({ ok: false, error: 'Use a localhost address such as http://localhost:3000' });
        const patch = { serverOrigin: origin };
        if (msg.key) {
          if (!/^bas_[A-Za-z0-9_-]{40,}$/.test(String(msg.key).trim())) return sendResponse({ ok: false, error: 'That does not look like a connection key (bas_…).' });
          patch.key = String(msg.key).trim();
        }
        await chrome.storage.local.set(patch);
        await loadConfig();
        lastHelloAt = 0;
        try {
          await hello(await managedTabIds());
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        return;
      }
      case 'popup-pause':
        await chrome.storage.local.set({ paused: Boolean(msg.paused) });
        await loadConfig();
        return sendResponse({ ok: true, paused: cfg.paused });
      case 'popup-open-tab': {
        const tab = await chrome.tabs.create({ url: serverCfg.chatgptUrl || 'https://chatgpt.com/', active: true });
        tabState(tab.id);
        await setManagedTabIds([...(await managedTabIds()), tab.id]);
        return sendResponse({ ok: true });
      }
      case 'popup-test':
        try {
          lastHelloAt = 0;
          const res = await hello(await managedTabIds());
          return sendResponse({ ok: true, versionOk: res.versionOk, message: res.message });
        } catch (e) {
          return sendResponse({ ok: false, error: e.message });
        }
      default:
        return sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const t = tabs.get(tabId);
  const ids = await managedTabIds();
  if (!ids.includes(tabId)) return;
  await setManagedTabIds(ids.filter((id) => id !== tabId));
  tabs.delete(tabId);
  if (t && t.busy && t.jobId) {
    await loadConfig();
    await api('release', { tabId: String(tabId), jobId: t.jobId, reason: 'ChatGPT tab was closed' }).catch((e) => (lastError = e.message));
    await dropCheckpoint(t.jobId);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bas-poll') void tick();
});

async function restoreAfterWorkerRestart() {
  await loadConfig();
  const checkpoints = await sessionGet('checkpoints', {});
  for (const [jobId, cp] of Object.entries(checkpoints)) {
    if (!cp || cp.tabId === undefined) continue;
    try {
      await chrome.tabs.get(cp.tabId);
      const t = tabState(cp.tabId);
      t.busy = true;
      t.started = true;
      t.jobId = jobId;
      t.job = cp.job;
      const pong = await chrome.tabs.sendMessage(cp.tabId, { type: 'ping' }).catch(() => null);
      if (pong) {
        t.ready = true;
        t.url = pong.url;
        if (!pong.busy) await sendRun(cp.tabId, cp.job, cp, 'Chrome restarted the extension background');
      }
    } catch (e) {
      await api('release', { tabId: String(cp.tabId), jobId, reason: 'Service worker restarted and the tab is gone' }).catch(() => {});
      await dropCheckpoint(jobId);
    }
  }
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create('bas-poll', { periodInMinutes: 0.5 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create('bas-poll', { periodInMinutes: 0.5 }));
chrome.alarms.create('bas-poll', { periodInMinutes: 0.5 });

// Test/diagnostic hooks (no privileged actions).
self.basTick = tick;
self.basState = () => ({ cfg: cfg && { serverOrigin: cfg.serverOrigin, installId: cfg.installId, paired: Boolean(cfg.key) }, serverCfg, versionMessage, lastError, tabs: Array.from(tabs.entries()).map(([id, t]) => ({ id, ready: t.ready, busy: t.busy, url: t.url, jobId: t.jobId })) });

void restoreAfterWorkerRestart().then(() => tick());
