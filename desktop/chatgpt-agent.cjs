'use strict';
/**
 * The app's own ChatGPT tab as an agent of the dashboard (owner request: “the browser inside the app”).
 *
 * The same work as the extension's background (extension/background.js) for its ChatGPT tabs, for the one ChatGPT tab
 * of this window. The tab runs the extension's own ChatGPT scripts (adapter.js, content.js: typing, sending once,
 * waiting for the real end of the answer, recovering a sent prompt), so prompts are handled exactly as in Automation
 * Chrome. This file only does what the background does: talk to the dashboard (hello, claim, progress, complete, fail,
 * an outbox kept on disk), open the conversation a job needs, and answer the scripts' requests.
 *
 * - Talks ONLY to this app's own dashboard on 127.0.0.1, with the key the app gave the dashboard at start.
 * - Login pages and human checks are never automated: the owner is told and completes them in the ChatGPT tab.
 * - Never Search Console or any Google page (Google refuses sign-ins in a browser built into an app): Automation
 *   Chrome's extension keeps those.
 */

const INSTALL_ID = 'desktop-app';
const TAB_ID = 'app-1';
const CAPABILITIES = ['claim', 'progress', 'complete', 'fail', 'release', 'reconcile', 'attachments', 'images', 'gallery', 'continue-generating', 'outbox', 'in-app'];
const IMAGE_HOSTS = (host) => /\.oaiusercontent\.com$/.test(host) || host === 'oaidalleapiprodscus.blob.core.windows.net' || host === 'chatgpt.com' || host === 'images.openai.com' || /(^|\.)mm\.bing\.net$/.test(host);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sameConversation(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin && ua.pathname.replace(/\/$/, '') === ub.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}

/**
 * @param {object} deps
 * @param {() => string} deps.origin  the dashboard (http://127.0.0.1:PORT)
 * @param {string} deps.key  the key the app gave the dashboard (BAS_DESKTOP_AGENT_KEY)
 * @param {string} deps.version  the ChatGPT scripts' version (extension/manifest.json)
 * @param {object} deps.tab  the ChatGPT tab: load(url), reload(), url(), send(msg) → Promise(answer), post(portId, msg),
 *   front() (show it: ChatGPT draws pictures only in a visible tab)
 * @param {(url: string) => Promise<{ ok: boolean, status: number, mime: string, bytes: Buffer }>} deps.fetchImage
 *   a picture with the ChatGPT tab's own sign-in (its session)
 * @param {{ read: () => object, write: (state: object) => void }} deps.store  the outbox and checkpoints on disk
 * @param {(title: string, body: string) => void} deps.notify
 * @param {(status: object) => void} [deps.onStatus]
 * @param {(line: string) => void} [deps.log]
 * @param {typeof fetch} [deps.fetch]
 */
function createChatGPTAgent(deps) {
  const doFetch = deps.fetch || fetch;
  const log = deps.log || (() => {});
  let serverCfg = { chatgptUrl: 'https://chatgpt.com/', pollIdleSec: 30, pollBusySec: 3, generationTimeoutSec: 600, humanCheckPauseMinutes: 10, backoffUntil: null, claimsPaused: false, waitingJobs: 0 };
  let versionMessage = null;
  let lastError = null;
  let lastHelloAt = 0;
  let pageLogin = null;
  let pageHumanCheck = false;
  let ticking = false;
  let running = false;
  let paused = false;
  let timer = null;
  /** The one ChatGPT tab of the window (as the extension's tabState). */
  const t = { ready: false, url: '', busy: false, started: false, jobId: null, job: null, port: null, freshPage: false, reloads: 0, lastReloadAt: 0, loadedAt: Date.now(), waiters: [] };
  /** Open job channels of the page (content.js connects one per job: `bas-job:<jobId>`). */
  const ports = new Map();

  // ---------------- storage (outbox, checkpoints) ----------------
  const state = () => {
    const s = deps.store.read() || {};
    return { outbox: Array.isArray(s.outbox) ? s.outbox : [], checkpoints: s.checkpoints && typeof s.checkpoints === 'object' ? s.checkpoints : {} };
  };
  const save = (s) => deps.store.write(s);

  function checkpoint(jobId, patch) {
    const s = state();
    s.checkpoints[jobId] = Object.assign({}, s.checkpoints[jobId] || {}, patch, { updatedAt: new Date().toISOString() });
    save(s);
    return s.checkpoints[jobId];
  }
  const getCheckpoint = (jobId) => state().checkpoints[jobId] || null;
  function dropCheckpoint(jobId) {
    const s = state();
    delete s.checkpoints[jobId];
    save(s);
  }

  // ---------------- dashboard API ----------------
  async function api(action, body, path, timeoutMs = 30_000) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await doFetch(deps.origin() + (path || '/api/extension/agent'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + deps.key },
        body: JSON.stringify(Object.assign({ action, installId: INSTALL_ID }, body || {})),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(data.error || 'HTTP ' + res.status), { status: res.status, data });
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function outboxPush(action, body) {
    const s = state();
    s.outbox.push({ action, body, at: Date.now(), attempts: 0 });
    save(s);
    await flushOutbox();
  }

  let flushing = null;
  function flushOutbox() {
    // One flush at a time (two would send an item twice).
    if (!flushing) flushing = doFlush().finally(() => (flushing = null));
    return flushing;
  }
  async function doFlush() {
    for (;;) {
      const s = state();
      const item = s.outbox[0];
      if (!item) return;
      try {
        await api(item.action, item.body);
      } catch (e) {
        const retryable = !e.status || e.status >= 500 || e.status === 429;
        const now = state();
        if (retryable && item.attempts + 1 < 200) {
          now.outbox[0] = Object.assign({}, item, { attempts: item.attempts + 1 });
          save(now);
          return;
        }
        lastError = `Dropped ${item.action} after the dashboard refused it: ${e.message}`;
      }
      const after = state();
      after.outbox.shift();
      save(after);
    }
  }

  // ---------------- the tab ----------------
  function waitReady(timeoutMs, expectedUrl) {
    if (t.ready && (!expectedUrl || sameConversation(t.url, expectedUrl))) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('ChatGPT tab did not load within ' + Math.round(timeoutMs / 1000) + 's')), timeoutMs);
      t.waiters.push((url) => {
        if (expectedUrl && !sameConversation(url, expectedUrl) && !/^https:\/\/chatgpt\.com\/?$/.test(expectedUrl)) return false;
        clearTimeout(timeout);
        resolve(true);
        return true;
      });
    });
  }

  function targetUrl(job) {
    const root = serverCfg.chatgptUrl || 'https://chatgpt.com/';
    if (job.reconcile && job.reconcile.conversationUrl) return job.reconcile.conversationUrl;
    if (job.newChat || !job.conversationUrl) return root;
    return job.conversationUrl;
  }

  async function runOnTab(job) {
    t.busy = true;
    t.jobId = job.id;
    t.job = job;
    const cp = checkpoint(job.id, { operationId: job.operationId, job, step: 'claimed' });
    try {
      const target = targetUrl(job);
      const isRoot = /^https:\/\/chatgpt\.com\/?$/.test(target);
      // After the page stopped working, the next job gets a freshly loaded page, even in the same conversation.
      const fresh = t.freshPage;
      t.freshPage = false;
      if (isRoot || !sameConversation(target, t.url) || fresh) {
        t.ready = false;
        checkpoint(job.id, { step: 'navigating', target });
        if (fresh && !isRoot && sameConversation(target, t.url)) deps.tab.reload();
        else deps.tab.load(target);
        await waitReady(60_000, target);
      } else if (!t.ready) {
        await waitReady(60_000);
      }
      t.started = true;
      await sendRun(job, cp, job.reconcile ? 'the app offered the job again (the earlier run did not report back)' : null);
    } catch (e) {
      t.busy = false;
      t.job = null;
      t.jobId = null;
      t.freshPage = true;
      await outboxPush('fail', { jobId: job.id, tabId: TAB_ID, code: 'ERROR', message: 'Tab could not start the job: ' + e.message });
      dropCheckpoint(job.id);
    }
  }

  async function sendRun(job, cp, resumedBy) {
    const local = cp && cp.sentAt ? { sentAt: cp.sentAt, userTurnsBefore: cp.userTurnsBefore, conversationUrl: cp.conversationUrl || null } : null;
    const res = await deps.tab.send({ type: 'run', job: Object.assign({}, job, { localCheckpoint: local, resumedBy: resumedBy || null }), config: serverCfg });
    if (!res || !res.ok) throw new Error('content script refused the job: ' + (res && res.error));
  }

  function finishTab(jobId) {
    if (t.jobId === jobId) {
      t.busy = false;
      t.started = false;
      t.jobId = null;
      t.job = null;
    }
    dropCheckpoint(jobId);
  }

  // ---------------- main loop ----------------
  async function pageSignals() {
    const pong = await deps.tab.send({ type: 'ping' }).catch(() => null);
    if (pong && pong.state) {
      pageLogin = pong.state === 'login' ? false : pong.state === 'ready' ? true : pageLogin;
      pageHumanCheck = pong.state === 'challenge';
    }
    return pong;
  }

  async function hello() {
    if (t.ready) await pageSignals();
    const res = await api('hello', {
      version: deps.version,
      protocol: 1,
      capabilities: CAPABILITIES,
      tabs: [{ tabId: TAB_ID, url: t.url || null, state: t.busy ? 'busy' : t.ready ? 'idle' : 'loading', jobId: t.jobId }],
      loggedIn: pageLogin,
      humanCheck: pageHumanCheck,
      claimsPaused: paused,
      backoffUntil: serverCfg.backoffUntil,
      lastError,
      diagnostics: { outbox: state().outbox.length, inApp: true },
    });
    lastHelloAt = Date.now();
    serverCfg = Object.assign({}, serverCfg, res.config || {});
    versionMessage = res.versionOk === false ? res.message : null;
    return res;
  }

  function status() {
    const s = { connected: Boolean(lastHelloAt) && Date.now() - lastHelloAt < 75_000 && !lastError, paused, busy: t.busy, ready: t.ready, loggedIn: pageLogin, humanCheck: pageHumanCheck, versionMessage, lastError, outbox: state().outbox.length, backoffUntil: serverCfg.backoffUntil };
    if (deps.onStatus) deps.onStatus(s);
    return s;
  }

  async function tick() {
    if (ticking || !running) return;
    ticking = true;
    try {
      await flushOutbox();
      // A ChatGPT page that never became ready (failed first load, network blip): reload it, at most 5 times. Never a
      // busy one, and never OpenAI's sign-in page (the owner may be typing there).
      if (!t.busy && !t.ready && /^https:\/\/chatgpt\.com\//.test(deps.tab.url()) && Date.now() - (t.lastReloadAt || t.loadedAt) > 30_000 && t.reloads < 5) {
        t.reloads++;
        t.lastReloadAt = Date.now();
        deps.tab.reload();
      }
      if (t.busy || paused || Date.now() - lastHelloAt > 20_000 || !lastHelloAt) await hello();
      if (versionMessage || paused || serverCfg.claimsPaused) return;
      if (serverCfg.backoffUntil && new Date(serverCfg.backoffUntil) > new Date()) return;
      if (!t.busy && t.ready) {
        const res = await api('claim', { tabId: TAB_ID, openConversationUrls: t.url ? [t.url] : [] });
        if (res.job) void runOnTab(res.job);
        else if (res.reason === 'backoff' && res.retryAfterSec) serverCfg.backoffUntil = new Date(Date.now() + res.retryAfterSec * 1000).toISOString();
        else if (res.reason === 'version-mismatch') versionMessage = res.message;
      }
      lastError = null;
    } catch (e) {
      lastError = e.message;
    } finally {
      ticking = false;
      status();
      schedule();
    }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    if (!running) return;
    const busy = t.busy || (serverCfg.waitingJobs || 0) > 0;
    timer = setTimeout(() => void tick(), Math.max(1, busy ? serverCfg.pollBusySec || 3 : serverCfg.pollIdleSec || 30) * 1000);
  }

  // ---------------- the page's messages (as chrome.runtime) ----------------
  async function onMessage(msg) {
    if (!msg || typeof msg !== 'object') return { ok: false };
    switch (msg.type) {
      case 'content-ready': {
        t.ready = true;
        t.reloads = 0;
        t.url = String(msg.url || '');
        t.waiters = t.waiters.filter((w) => !w(t.url));
        // Resume a job whose page was reloaded mid-run (the script reconciles before any resend).
        if (t.busy && t.job && t.started && !t.port) {
          const cp = getCheckpoint(t.job.id);
          const job = t.job;
          if (cp && cp.step !== 'navigating') setTimeout(() => sendRun(job, cp, 'the ChatGPT page reloaded').catch((e) => (lastError = e.message)), 500);
        }
        setTimeout(() => void tick(), 300);
        return { ok: true };
      }
      case 'url-changed':
        t.url = String(msg.url || '');
        return { ok: true };
      case 'come-to-front':
        deps.tab.front();
        return { ok: true };
      case 'checkpoint':
        checkpoint(msg.jobId, Object.fromEntries(Object.entries({ step: msg.step, sentAt: msg.sentAt, userTurnsBefore: msg.userTurnsBefore }).filter(([, v]) => v !== undefined)));
        return { ok: true };
      case 'pre-send-check': {
        const res = await api('progress', { tabId: TAB_ID, jobId: msg.jobId, step: 'about to send' }).catch(() => null);
        return { cancel: Boolean(res && res.cancel), ok: Boolean(res && res.ok) };
      }
      case 'fetch-attachment': {
        try {
          if (typeof msg.url !== 'string' || !msg.url.startsWith('/api/extension/media/')) return { ok: false, error: 'not an attachment of this dashboard' };
          const res = await doFetch(deps.origin() + msg.url, { headers: { Authorization: 'Bearer ' + deps.key } });
          if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 12 * 1024 * 1024) return { ok: false, error: 'attachment too large' };
          return { ok: true, base64: buf.toString('base64') };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
      case 'fetch-image': {
        // Pictures on ChatGPT's own image hosts only: generated images and the image-search gallery.
        try {
          const url = new URL(msg.url);
          if (url.protocol !== 'https:' || !IMAGE_HOSTS(url.hostname)) return { ok: false, error: 'not an image host of ChatGPT' };
          const res = await deps.fetchImage(url.toString());
          if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
          if (res.bytes.length > 12 * 1024 * 1024) return { ok: false, error: 'image too large' };
          return { ok: true, base64: res.bytes.toString('base64'), mime: res.mime || 'image/png' };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
      case 'upload-image': {
        try {
          const res = await api('upload', { tabId: TAB_ID, jobId: msg.jobId, name: msg.name, mime: msg.mime, dataBase64: msg.dataBase64, sourceUrl: msg.sourceUrl }, '/api/extension/upload', 60_000);
          return { ok: true, mediaAssetId: res.mediaAssetId };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }
      default:
        return { ok: false, error: 'unknown message' };
    }
  }

  // ---------------- a job's channel (as chrome.runtime.connect) ----------------
  function onPortOpen(portId, name) {
    if (typeof name !== 'string' || !name.startsWith('bas-job:')) return;
    const jobId = name.slice('bas-job:'.length);
    // Handle this job's messages strictly in order.
    ports.set(portId, { jobId, chain: Promise.resolve() });
    t.port = portId;
  }

  function onPortMessage(portId, msg) {
    const p = ports.get(portId);
    if (!p || !msg || typeof msg !== 'object') return;
    p.chain = p.chain.then(() => handlePortMessage(portId, p.jobId, msg)).catch((e) => (lastError = e.message));
  }

  function onPortClose(portId) {
    ports.delete(portId);
    if (t.port === portId) t.port = null;
  }

  async function handlePortMessage(portId, jobId, msg) {
    if (msg.type === 'progress') {
      if (msg.sent) checkpoint(jobId, Object.assign({ sent: true, sentAt: msg.sentAt || new Date().toISOString() }, msg.conversationUrl ? { conversationUrl: msg.conversationUrl } : {}));
      const res = await api('progress', { tabId: TAB_ID, jobId, step: String(msg.step || '').slice(0, 200), sent: Boolean(msg.sent), sentAt: msg.sentAt, conversationUrl: msg.conversationUrl || null, diagnostics: msg.snapshot || {} }).catch((e) => ({ ok: false, error: e.message }));
      if (res && res.cancel) deps.tab.post(portId, { type: 'cancel' });
    } else if (msg.type === 'needs-human') {
      pageLogin = msg.kind === 'login' ? false : pageLogin;
      pageHumanCheck = msg.kind !== 'login';
      deps.tab.front();
      deps.notify('Blog Automation Studio needs you', `${msg.message} Please complete it in the ChatGPT tab of this window. The job waits up to ${serverCfg.humanCheckPauseMinutes || 10} minutes.`);
      await hello().catch(() => {});
    } else if (msg.type === 'human-resolved') {
      pageHumanCheck = false;
      pageLogin = true;
    } else if (msg.type === 'complete') {
      await outboxPush('complete', {
        tabId: TAB_ID,
        jobId,
        text: msg.text,
        html: msg.html || null,
        images: Array.isArray(msg.images) && msg.images.length ? msg.images : undefined,
        imageLinks: Array.isArray(msg.imageLinks) && msg.imageLinks.length ? msg.imageLinks.slice(0, 20) : undefined,
        galleryReport: typeof msg.galleryReport === 'string' ? msg.galleryReport.slice(0, 400) : undefined,
        conversationUrl: msg.conversationUrl || null,
        recovered: Boolean(msg.recovered),
        elapsedMs: msg.elapsedMs,
      });
      finishTab(jobId);
      setTimeout(() => void tick(), 500);
    } else if (msg.type === 'fail') {
      await outboxPush('fail', { tabId: TAB_ID, jobId, code: msg.code || 'ERROR', message: String(msg.message || 'Unknown error').slice(0, 2000), retryAfterSec: msg.retryAfterSec ?? null, uncertain: Boolean(msg.uncertain), diagnostics: msg.snapshot || {} });
      if (msg.code === 'USAGE_LIMIT') serverCfg.backoffUntil = new Date(Date.now() + (msg.retryAfterSec || 60) * 1000).toISOString();
      if (msg.freshPage) t.freshPage = true;
      finishTab(jobId);
      setTimeout(() => void tick(), 1000);
    }
  }

  /** A new page in the tab (navigation, reload): its scripts start again and announce themselves. */
  function onPageLoading() {
    t.ready = false;
    t.loadedAt = Date.now();
    for (const id of [...ports.keys()]) onPortClose(id);
  }

  return {
    INSTALL_ID,
    TAB_ID,
    /** Start: a job left from the last run (the app was closed mid-job) goes back to the queue, which reconciles it. */
    async start() {
      running = true;
      for (const [jobId] of Object.entries(state().checkpoints)) {
        await api('release', { tabId: TAB_ID, jobId, reason: 'The desktop app restarted; its ChatGPT tab is new' }).catch(() => {});
        dropCheckpoint(jobId);
      }
      await tick();
    },
    /** Quit: a job in progress goes back to the queue (it reconciles before any resend). */
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      if (t.busy && t.jobId) {
        await api('release', { tabId: TAB_ID, jobId: t.jobId, reason: 'The desktop app was closed' }, null, 5000).catch(() => {});
        dropCheckpoint(t.jobId);
      }
    },
    /** Owner switch: ChatGPT in this app, or in Automation Chrome (paused: the dashboard is told at once). */
    async setPaused(value) {
      paused = Boolean(value);
      await hello().catch((e) => (lastError = e.message));
      status();
      schedule();
    },
    tick,
    status,
    onMessage,
    onPortOpen,
    onPortMessage,
    onPortClose,
    onPageLoading,
    /** For tests. */
    _state: () => ({ tab: { ...t, waiters: t.waiters.length }, serverCfg, lastError, versionMessage }),
  };
}

module.exports = { createChatGPTAgent, INSTALL_ID, TAB_ID, sleep };
