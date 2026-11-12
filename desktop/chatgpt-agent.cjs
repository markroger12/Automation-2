'use strict';
/**
 * The app's own ChatGPT tabs as an agent of the dashboard (owner request: “the browser inside the app”).
 *
 * The same work as the extension's background (extension/background.js) for its ChatGPT tabs, for the ChatGPT tabs of
 * this window: 1 to Settings → ChatGPT tabs (owner report 2026-11-08: the app ran only one prompt at a time, in one
 * tab). Each tab runs the extension's own ChatGPT scripts (adapter.js, content.js: typing, sending once, waiting for
 * the real end of the answer, recovering a sent prompt), so prompts are handled exactly as in Automation Chrome. This
 * file only does what the background does: talk to the dashboard (hello, claim, progress, complete, fail, an outbox
 * kept on disk), open a tab when prompts wait (one per round, never many at once), open the conversation a job needs,
 * and answer the scripts' requests. An extra tab with nothing to do is closed again after a while.
 *
 * - Talks ONLY to this app's own dashboard on 127.0.0.1, with the key the app gave the dashboard at start.
 * - Login pages and human checks are never automated: the owner is told and completes them in the ChatGPT tab.
 * - Never Search Console or any Google page (Google refuses sign-ins in a browser built into an app): Automation
 *   Chrome's extension keeps those.
 */

const INSTALL_ID = 'desktop-app';
/** The first tab (the one the owner signs in in); more are app-2 … app-5. */
const TAB_ID = 'app-1';
/** At most this many tabs, whatever the dashboard allows (as the extension: Settings → ChatGPT tabs is 1–5). */
const MAX_TABS = 5;
/** An extra tab with nothing to do for this long is closed (each ChatGPT tab costs memory). */
const IDLE_CLOSE_MS = 10 * 60_000;
/**
 * Owner report (2026-11-12: ChatGPT in the app sometimes got stuck): the page's script reports a prompt's progress every
 * 5 s while it waits. A busy tab silent for this long has a stuck page: it is loaded again (the prompt is looked for,
 * never sent twice); still silent after as long again, the prompt goes back to the queue and the tab is freed.
 */
const STUCK_MS = 3 * 60_000;
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
 * @param {object} [deps.pool]  the ChatGPT tabs: ids() → the open tabs' ids (the first is app-1), open(url) → a new
 *   tab's id, close(id), load(id, url), reload(id), url(id), send(id, msg) → Promise(answer), post(id, portId, msg),
 *   front(id) (show it: ChatGPT draws pictures only in a page that is shown)
 * @param {object} [deps.tab]  one tab only (load(url), reload(), url(), send(msg), post(portId, msg), front()): app-1
 * @param {object} [deps.gsc]  the Search Console tab (google-tab.cjs `port`): load(url), send(msg) → Promise(answer),
 *   url(), saveProof() → base64 MHTML. With it the app makes the indexing requests (owner, 2026-11-12).
 * @param {() => void} [deps.gscFront]  show the Search Console tab (a check Google shows is the owner's)
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
  /** The ChatGPT tabs: one fixed tab (deps.tab), or a pool that can open and close tabs. */
  const pool = deps.pool || {
    ids: () => [TAB_ID],
    open: null,
    close: null,
    load: (_id, url) => deps.tab.load(url),
    reload: () => deps.tab.reload(),
    url: () => deps.tab.url(),
    send: (_id, msg) => deps.tab.send(msg),
    post: (_id, portId, msg) => deps.tab.post(portId, msg),
    front: () => deps.tab.front(),
  };
  /** Each tab's state (as the extension's tabState). */
  const tabs = new Map();
  const newTab = () => ({ ready: false, url: '', busy: false, started: false, jobId: null, job: null, port: null, freshPage: false, reloads: 0, lastReloadAt: 0, loadedAt: Date.now(), idleSince: Date.now(), waiters: [], lastActivity: 0, stuckReloads: 0, waitingHuman: false });
  /** The tab's page said something (progress, a message, a new page): it is not stuck. */
  const touch = (id) => {
    const t = tabs.get(id);
    if (t) t.lastActivity = Date.now();
  };
  function tabState(id) {
    if (!tabs.has(id)) tabs.set(id, newTab());
    return tabs.get(id);
  }
  const ids = () => pool.ids();
  const first = () => ids()[0] || TAB_ID;
  /** Open job channels of the pages (content.js connects one per job: `bas-job:<jobId>`), by tab and channel. */
  const ports = new Map();
  const portKey = (tabId, portId) => `${tabId}\u0000${portId}`;

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

  // ---------------- the tabs ----------------
  function waitReady(id, timeoutMs, expectedUrl) {
    const t = tabState(id);
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

  async function runOnTab(id, job) {
    const t = tabState(id);
    t.busy = true;
    t.jobId = job.id;
    t.job = job;
    t.stuckReloads = 0;
    t.waitingHuman = false;
    touch(id);
    const cp = checkpoint(job.id, { tabId: id, operationId: job.operationId, job, step: 'claimed' });
    try {
      const target = targetUrl(job);
      const isRoot = /^https:\/\/chatgpt\.com\/?$/.test(target);
      // After the page stopped working, the next job gets a freshly loaded page, even in the same conversation.
      const fresh = t.freshPage;
      t.freshPage = false;
      if (isRoot || !sameConversation(target, t.url) || fresh) {
        t.ready = false;
        checkpoint(job.id, { step: 'navigating', target });
        if (fresh && !isRoot && sameConversation(target, t.url)) pool.reload(id);
        else pool.load(id, target);
        await waitReady(id, 60_000, target);
      } else if (!t.ready) {
        await waitReady(id, 60_000);
      }
      t.started = true;
      touch(id);
      await sendRun(id, job, cp, job.reconcile ? 'the app offered the job again (the earlier run did not report back)' : null);
    } catch (e) {
      t.busy = false;
      t.job = null;
      t.jobId = null;
      t.freshPage = true;
      t.idleSince = Date.now();
      await outboxPush('fail', { jobId: job.id, tabId: id, code: 'ERROR', message: 'Tab could not start the job: ' + e.message });
      dropCheckpoint(job.id);
    }
  }

  async function sendRun(id, job, cp, resumedBy) {
    const local = cp && cp.sentAt ? { sentAt: cp.sentAt, userTurnsBefore: cp.userTurnsBefore, conversationUrl: cp.conversationUrl || null } : null;
    const res = await pool.send(id, { type: 'run', job: Object.assign({}, job, { localCheckpoint: local, resumedBy: resumedBy || null }), config: serverCfg });
    if (!res || !res.ok) throw new Error('content script refused the job: ' + (res && res.error));
  }

  function finishTab(id, jobId) {
    const t = tabState(id);
    if (t.jobId === jobId) {
      t.busy = false;
      t.started = false;
      t.jobId = null;
      t.job = null;
      t.idleSince = Date.now();
      t.stuckReloads = 0;
      t.waitingHuman = false;
    }
    dropCheckpoint(jobId);
  }

  /** Forget the state of tabs that are gone (closed by the app or the pool). */
  function syncTabs() {
    const open = new Set(ids());
    for (const id of [...tabs.keys()]) if (!open.has(id)) tabs.delete(id);
    for (const id of open) tabState(id);
  }

  /** A busy tab whose page said nothing for STUCK_MS (never while it waits for the owner's sign-in or check). */
  async function watchStuckTabs() {
    for (const id of ids()) {
      const t = tabState(id);
      if (!t.busy || !t.started || t.waitingHuman || !t.lastActivity || Date.now() - t.lastActivity < STUCK_MS) continue;
      const jobId = t.jobId;
      if (t.stuckReloads < 1) {
        t.stuckReloads++;
        t.lastActivity = Date.now();
        log(`ChatGPT tab ${id} showed no progress for ${STUCK_MS / 60_000} minutes: its page is loaded again (the prompt is looked for there, never sent twice).`);
        pool.reload(id);
        continue;
      }
      // Not sent yet (no send step in its checkpoint): back to the queue, and it runs again by itself. Maybe sent: held
      // as uncertain, so the dashboard checks the conversation and it is never sent twice.
      const cp = getCheckpoint(jobId);
      const maybeSent = Boolean(cp && (cp.sentAt || cp.userTurnsBefore !== undefined || cp.step === 'sending' || cp.step === 'sent'));
      log(`ChatGPT tab ${id} still showed no progress after loading again: ${maybeSent ? 'its prompt may have been sent, so it waits for a check (never sent twice)' : 'its prompt was not sent yet and goes back to the queue'}.`);
      t.freshPage = true;
      await outboxPush('fail', { tabId: id, jobId, code: 'ERROR', message: `The ChatGPT tab of the app showed no progress for ${(2 * STUCK_MS) / 60_000} minutes, also after loading its page again.`, uncertain: maybeSent });
      finishTab(id, jobId);
      pool.reload(id);
    }
  }

  /**
   * More tabs while prompts wait (as the extension): up to what the dashboard allows (Settings → ChatGPT tabs, and its
   * slots), one new tab per round, and only when every open tab has loaded and ChatGPT is signed in without a check.
   */
  function ensureTabs() {
    if (!pool.open) return;
    // Only once the pages said ChatGPT is signed in without a check (the owner signs in in app-1 first).
    if (pageLogin !== true || pageHumanCheck) return;
    const list = ids();
    const busy = list.filter((id) => tabState(id).busy).length;
    const wanted = Math.min(MAX_TABS, serverCfg.maxTabs || 1, Math.max(serverCfg.wantedTabs || 1, busy));
    if ((serverCfg.waitingJobs || 0) === 0 && list.length > 0) return;
    if (list.length >= wanted) return;
    if (list.some((id) => !tabState(id).ready && !tabState(id).busy)) return;
    const id = pool.open(serverCfg.chatgptUrl || 'https://chatgpt.com/');
    if (id) {
      tabState(id).loadedAt = Date.now();
      log(`ChatGPT tab ${id} opened (${list.length + 1} of at most ${wanted}).`);
    }
  }

  /** An extra tab with nothing to do: closed after a while, or at once when the owner lowered Settings → ChatGPT tabs. */
  function closeIdleTabs() {
    if (!pool.close) return;
    const list = ids();
    const limit = Math.max(1, Math.min(MAX_TABS, serverCfg.maxTabs || 1));
    let open = list.length;
    for (const id of list.slice(1).reverse()) {
      const t = tabState(id);
      if (t.busy || t.port) continue;
      const tooMany = open > limit;
      const idleLong = (serverCfg.waitingJobs || 0) === 0 && Date.now() - t.idleSince > IDLE_CLOSE_MS;
      if (!tooMany && !idleLong) continue;
      pool.close(id);
      tabs.delete(id);
      open--;
      log(`ChatGPT tab ${id} closed (${tooMany ? 'more tabs than Settings → ChatGPT tabs allows' : 'nothing to do'}).`);
    }
  }

  // ---------------- main loop ----------------
  async function pageSignals() {
    // All tabs share one sign-in: any tab that shows the sign-in page or a check says so.
    let login = null;
    let check = false;
    for (const id of ids()) {
      if (!tabState(id).ready) continue;
      const pong = await pool.send(id, { type: 'ping' }).catch(() => null);
      if (!pong || !pong.state) continue;
      if (pong.state === 'login') login = false;
      else if (pong.state === 'ready' && login === null) login = true;
      if (pong.state === 'challenge') check = true;
    }
    if (login !== null) pageLogin = login;
    pageHumanCheck = check;
  }

  async function hello() {
    if (ids().some((id) => tabState(id).ready)) await pageSignals();
    const res = await api('hello', {
      version: deps.version,
      protocol: 1,
      capabilities: capabilities(),
      tabs: ids().map((id) => {
        const t = tabState(id);
        return { tabId: id, url: t.url || null, state: t.busy ? 'busy' : t.ready ? 'idle' : 'loading', jobId: t.jobId };
      }),
      loggedIn: pageLogin,
      humanCheck: pageHumanCheck,
      claimsPaused: paused,
      backoffUntil: serverCfg.backoffUntil,
      lastError,
      diagnostics: { outbox: state().outbox.length, inApp: true, tabs: ids().length, searchConsole: Boolean(deps.gsc), gsc: gsc.last },
    });
    lastHelloAt = Date.now();
    serverCfg = Object.assign({}, serverCfg, res.config || {});
    versionMessage = res.versionOk === false ? res.message : null;
    return res;
  }

  /** What this app can do for the dashboard: ChatGPT prompts, and indexing requests when it has a Search Console tab. */
  const capabilities = () => (deps.gsc ? [...CAPABILITIES, 'gsc-request-indexing'] : [...CAPABILITIES]);

  function status() {
    const list = ids().map((id) => tabState(id));
    const busyTabs = list.filter((t) => t.busy).length;
    const s = { connected: Boolean(lastHelloAt) && Date.now() - lastHelloAt < 75_000 && !lastError, paused, busy: busyTabs > 0, busyTabs, tabs: list.length, ready: list.some((t) => t.ready), loggedIn: pageLogin, humanCheck: pageHumanCheck, versionMessage, lastError, outbox: state().outbox.length, backoffUntil: serverCfg.backoffUntil, gsc: deps.gsc ? { running: gsc.running, waiting: serverCfg.gscWaiting || 0, last: gsc.last } : null };
    if (deps.onStatus) deps.onStatus(s);
    return s;
  }

  async function tick() {
    if (ticking || !running) return;
    ticking = true;
    try {
      syncTabs();
      await flushOutbox();
      // A ChatGPT page that never became ready (failed first load, network blip): reload it, at most 5 times. Never a
      // busy one, and never OpenAI's sign-in page (the owner may be typing there).
      for (const id of ids()) {
        const t = tabState(id);
        if (!t.busy && !t.ready && /^https:\/\/chatgpt\.com\//.test(pool.url(id)) && Date.now() - (t.lastReloadAt || t.loadedAt) > 30_000 && t.reloads < 5) {
          t.reloads++;
          t.lastReloadAt = Date.now();
          pool.reload(id);
        }
      }
      await watchStuckTabs();
      const anyBusy = ids().some((id) => tabState(id).busy);
      if (anyBusy || paused || Date.now() - lastHelloAt > 20_000 || !lastHelloAt) await hello();
      if (versionMessage || paused) return;
      // Search Console requests (the app's Search Console tab), one at a time, apart from ChatGPT's limits.
      if (deps.gsc && (serverCfg.gscWaiting || 0) > 0 && !gsc.running) void runGscJob();
      if (serverCfg.claimsPaused) return;
      if (serverCfg.backoffUntil && new Date(serverCfg.backoffUntil) > new Date()) return;
      // Before opening a tab: what the pages show now (not only at the last hello).
      if (pool.open && (pageLogin !== true || pageHumanCheck) && (serverCfg.waitingJobs || 0) > 0) await pageSignals();
      ensureTabs();
      closeIdleTabs();
      // Each idle tab with a ready page asks for a prompt; the first “nothing for you” ends the round.
      for (const id of ids()) {
        const t = tabState(id);
        if (t.busy || !t.ready) continue;
        const open = ids().map((i) => tabState(i).url).filter(Boolean);
        const res = await api('claim', { tabId: id, openConversationUrls: open });
        if (res.job) {
          void runOnTab(id, res.job);
          continue;
        }
        if (res.reason === 'backoff' && res.retryAfterSec) serverCfg.backoffUntil = new Date(Date.now() + res.retryAfterSec * 1000).toISOString();
        else if (res.reason === 'version-mismatch') versionMessage = res.message;
        break;
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
    const busy = ids().some((id) => tabState(id).busy) || (serverCfg.waitingJobs || 0) > 0 || gsc.running || (deps.gsc && (serverCfg.gscWaiting || 0) > 0);
    timer = setTimeout(() => void tick(), Math.max(1, busy ? serverCfg.pollBusySec || 3 : serverCfg.pollIdleSec || 30) * 1000);
  }

  // ---------------- Search Console: request indexing (the app's Search Console tab) ----------------
  /**
   * As the extension's background (runGscJob): claim a request, open the property's Search Console page in the tab,
   * hand the job to the page's script (gsc.js) on each page it shows, and report what Google answered. A sign-in page
   * or Google's check is never handled here: the owner is told. The proof (the page as it stands) goes first.
   */
  const gsc = { running: false, onReady: null, onDone: null, onNavigate: null, last: null };
  const pageCopyOf = (msg) => (typeof msg.pageCopy === 'string' && msg.pageCopy.length <= 300000 ? msg.pageCopy : undefined);

  async function saveGscProof(jobId) {
    try {
      await sleep(800); // let Google's dialog finish opening
      const mhtmlBase64 = await deps.gsc.saveProof();
      if (!mhtmlBase64) throw new Error('no page copy');
      await api('gsc-proof', { jobId, mhtmlBase64 }, '/api/extension/gsc-proof', 60_000);
    } catch (e) {
      lastError = 'Search Console screenshot not saved: ' + e.message;
    }
  }

  async function runGscJob() {
    gsc.running = true;
    status();
    try {
      const res = await api('gsc-claim', {});
      const job = res && res.job;
      if (!job) return;
      log(`Search Console: requesting indexing for ${job.url}.`);
      const result = await new Promise((resolve) => {
        let timer = null;
        const finish = (r) => {
          clearTimeout(timer);
          gsc.onReady = null;
          gsc.onDone = null;
          gsc.onNavigate = null;
          resolve(r);
        };
        // How long the owner has for a check Google shows (Settings → Advanced, as for ChatGPT), twice at most.
        const humanWaitMs = Math.round((serverCfg.humanCheckPauseMinutes || 10) * 60_000);
        timer = setTimeout(() => finish({ outcome: 'ERROR', message: 'Search Console did not finish in time.' }), 6 * 60_000 + 2 * humanWaitMs);
        // Google's sign-in page, or Search Console's start page that a signed-out visitor gets.
        gsc.onNavigate = (url) => {
          if (/^https:\/\/accounts\.google\.com\/|^https:\/\/search\.google\.com\/search-console\/about/.test(url)) finish({ outcome: 'NOT_SIGNED_IN', message: "Search Console asked to sign in to Google (in the app's Search Console tab)." });
        };
        // Each page asks for the job: the property's page (type the URL), and after Google's 404 or a box that did
        // nothing, the next address. A few pages at most.
        let pages = 0;
        gsc.onReady = async () => {
          pages++;
          if (pages > 4) return finish({ outcome: 'ERROR', message: 'Search Console kept changing pages; the URL could not be inspected.' });
          const r = await deps.gsc.send({ type: 'gsc-run', jobId: job.id, typeUrl: job.url, altUrl: job.altUrl || null, attempt: pages, humanWaitMs }).catch((e) => ({ ok: false, error: e.message }));
          if (!r || (!r.ok && r.error !== 'busy')) finish({ outcome: 'ERROR', message: 'The Search Console page did not take the request: ' + ((r && r.error) || 'no answer') });
        };
        gsc.onDone = (msg) => {
          if (msg.jobId === job.id) finish({ outcome: msg.outcome, message: msg.message || null, shown: msg.shown || null, pageCopy: pageCopyOf(msg) });
        };
        deps.gsc.load(job.inspectUrl);
      });
      if (result.outcome === 'REQUESTED' || result.outcome === 'QUOTA') await saveGscProof(job.id);
      gsc.last = { url: job.url, outcome: result.outcome, at: new Date().toISOString() };
      log(`Search Console: ${result.outcome} for ${job.url}${result.message ? ` (${String(result.message).slice(0, 200)})` : ''}.`);
      await outboxPush('gsc-result', { jobId: job.id, outcome: result.outcome, message: result.message ? String(result.message).slice(0, 900) : null, pageCopy: result.pageCopy });
      setTimeout(() => void tick(), 500);
    } catch (e) {
      lastError = e.message;
    } finally {
      gsc.running = false;
      gsc.onReady = null;
      gsc.onDone = null;
      gsc.onNavigate = null;
      status();
    }
  }

  /** A message from the Search Console page's script (as chrome.runtime.sendMessage). */
  async function onGscMessage(msg) {
    if (!msg || typeof msg !== 'object') return { ok: false };
    switch (msg.type) {
      case 'gsc-ready':
        if (gsc.onReady) void gsc.onReady();
        return { ok: true };
      case 'gsc-done':
        if (gsc.onDone) gsc.onDone(msg);
        return { ok: true };
      case 'gsc-alive':
        return { ok: true };
      case 'gsc-check':
        // Google shows a check (“I'm not a robot”): the owner completes it in the tab (never this app).
        if (deps.gscFront) deps.gscFront();
        deps.notify('Search Console wants a check', `Google shows a check (“I'm not a robot”) in the app's Search Console tab. Complete it there; indexing is requested right after. It waits up to ${serverCfg.humanCheckPauseMinutes || 10} minutes.`);
        return { ok: true };
      default:
        return { ok: false, error: 'unknown message' };
    }
  }

  /** The Search Console tab went to another page (a sign-in page ends the request: the owner signs in). */
  function onGscNavigate(url) {
    if (gsc.onNavigate) gsc.onNavigate(String(url || ''));
  }

  // ---------------- the pages' messages (as chrome.runtime) ----------------
  async function onMessage(msg, tabId) {
    if (!msg || typeof msg !== 'object') return { ok: false };
    const id = tabId || first();
    const t = tabState(id);
    switch (msg.type) {
      case 'content-ready': {
        t.ready = true;
        t.reloads = 0;
        touch(id);
        t.url = String(msg.url || '');
        t.waiters = t.waiters.filter((w) => !w(t.url));
        // Resume a job whose page was reloaded mid-run (the script reconciles before any resend).
        if (t.busy && t.job && t.started && !t.port) {
          const cp = getCheckpoint(t.job.id);
          const job = t.job;
          if (cp && cp.step !== 'navigating') setTimeout(() => sendRun(id, job, cp, 'the ChatGPT page reloaded').catch((e) => (lastError = e.message)), 500);
        }
        setTimeout(() => void tick(), 300);
        return { ok: true };
      }
      case 'url-changed':
        t.url = String(msg.url || '');
        touch(id);
        return { ok: true };
      case 'come-to-front':
        pool.front(id);
        return { ok: true };
      case 'checkpoint':
        touch(id);
        checkpoint(msg.jobId, Object.fromEntries(Object.entries({ step: msg.step, sentAt: msg.sentAt, userTurnsBefore: msg.userTurnsBefore }).filter(([, v]) => v !== undefined)));
        return { ok: true };
      case 'pre-send-check': {
        const res = await api('progress', { tabId: id, jobId: msg.jobId, step: 'about to send' }).catch(() => null);
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
          const res = await api('upload', { tabId: id, jobId: msg.jobId, name: msg.name, mime: msg.mime, dataBase64: msg.dataBase64, sourceUrl: msg.sourceUrl }, '/api/extension/upload', 60_000);
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
  function onPortOpen(portId, name, tabId) {
    if (typeof name !== 'string' || !name.startsWith('bas-job:')) return;
    const id = tabId || first();
    const key = portKey(id, portId);
    // Handle this job's messages strictly in order.
    ports.set(key, { jobId: name.slice('bas-job:'.length), tabId: id, portId, chain: Promise.resolve() });
    tabState(id).port = key;
    touch(id);
  }

  function onPortMessage(portId, msg, tabId) {
    const p = ports.get(portKey(tabId || first(), portId));
    if (!p || !msg || typeof msg !== 'object') return;
    touch(p.tabId);
    p.chain = p.chain.then(() => handlePortMessage(p, msg)).catch((e) => (lastError = e.message));
  }

  function onPortClose(portId, tabId) {
    const id = tabId || first();
    const key = portKey(id, portId);
    ports.delete(key);
    const t = tabs.get(id);
    if (t && t.port === key) t.port = null;
  }

  async function handlePortMessage(p, msg) {
    const { jobId, tabId, portId } = p;
    if (msg.type === 'progress') {
      if (msg.sent) checkpoint(jobId, Object.assign({ sent: true, sentAt: msg.sentAt || new Date().toISOString() }, msg.conversationUrl ? { conversationUrl: msg.conversationUrl } : {}));
      const res = await api('progress', { tabId, jobId, step: String(msg.step || '').slice(0, 200), sent: Boolean(msg.sent), sentAt: msg.sentAt, conversationUrl: msg.conversationUrl || null, diagnostics: msg.snapshot || {} }).catch((e) => ({ ok: false, error: e.message }));
      if (res && res.cancel) pool.post(tabId, portId, { type: 'cancel' });
    } else if (msg.type === 'needs-human') {
      // The owner's turn (sign-in or check): the tab is not stuck while it waits for them.
      tabState(tabId).waitingHuman = true;
      pageLogin = msg.kind === 'login' ? false : pageLogin;
      pageHumanCheck = msg.kind !== 'login';
      pool.front(tabId);
      deps.notify('Blog Automation Studio needs you', `${msg.message} Please complete it in the ChatGPT tab of this window. The job waits up to ${serverCfg.humanCheckPauseMinutes || 10} minutes.`);
      await hello().catch(() => {});
    } else if (msg.type === 'human-resolved') {
      tabState(tabId).waitingHuman = false;
      pageHumanCheck = false;
      pageLogin = true;
    } else if (msg.type === 'complete') {
      await outboxPush('complete', {
        tabId,
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
      finishTab(tabId, jobId);
      setTimeout(() => void tick(), 500);
    } else if (msg.type === 'fail') {
      await outboxPush('fail', { tabId, jobId, code: msg.code || 'ERROR', message: String(msg.message || 'Unknown error').slice(0, 2000), retryAfterSec: msg.retryAfterSec ?? null, uncertain: Boolean(msg.uncertain), diagnostics: msg.snapshot || {} });
      if (msg.code === 'USAGE_LIMIT') serverCfg.backoffUntil = new Date(Date.now() + (msg.retryAfterSec || 60) * 1000).toISOString();
      if (msg.freshPage) tabState(tabId).freshPage = true;
      finishTab(tabId, jobId);
      setTimeout(() => void tick(), 1000);
    }
  }

  /** A new page in a tab (navigation, reload): its scripts start again and announce themselves. */
  function onPageLoading(tabId) {
    const id = tabId || first();
    const t = tabState(id);
    t.ready = false;
    t.loadedAt = Date.now();
    for (const p of [...ports.values()]) if (p.tabId === id) onPortClose(p.portId, id);
  }

  /** Release the jobs of the busy tabs (the app quits, or a tab is gone). */
  async function releaseBusy(reason, onlyId) {
    // The agent's own list: on quit the window may have closed the tabs already.
    for (const id of onlyId ? [onlyId] : [...tabs.keys()]) {
      const t = tabs.get(id);
      if (!t || !t.busy || !t.jobId) continue;
      await api('release', { tabId: id, jobId: t.jobId, reason }, null, 5000).catch(() => {});
      dropCheckpoint(t.jobId);
      t.busy = false;
      t.jobId = null;
      t.job = null;
    }
  }

  return {
    INSTALL_ID,
    TAB_ID,
    /** Start: a job left from the last run (the app was closed mid-job) goes back to the queue, which reconciles it. */
    async start() {
      running = true;
      for (const [jobId, cp] of Object.entries(state().checkpoints)) {
        await api('release', { tabId: (cp && cp.tabId) || TAB_ID, jobId, reason: 'The desktop app restarted; its ChatGPT tabs are new' }).catch(() => {});
        dropCheckpoint(jobId);
      }
      await tick();
    },
    /** Quit: the prompts in progress go back to the queue (they are reconciled before any resend). */
    async stop() {
      running = false;
      if (timer) clearTimeout(timer);
      await releaseBusy('The desktop app was closed');
    },
    /** Owner switch: ChatGPT in this app, or in Automation Chrome (paused: the dashboard is told at once). */
    async setPaused(value) {
      paused = Boolean(value);
      await hello().catch((e) => (lastError = e.message));
      status();
      schedule();
    },
    /** A tab the app had to close (its page is gone for good): its prompt goes back to the queue. */
    async onTabGone(tabId) {
      await releaseBusy('The ChatGPT tab of the desktop app was closed', tabId);
      for (const [key, p] of [...ports.entries()]) if (p.tabId === tabId) ports.delete(key);
      tabs.delete(tabId);
    },
    tick,
    status,
    onGscMessage,
    onGscNavigate,
    onMessage,
    capabilities,
    onPortOpen,
    onPortMessage,
    onPortClose,
    onPageLoading,
    /** For tests. */
    _state: () => ({ tab: { ...tabState(first()), waiters: tabState(first()).waiters.length }, tabs: Object.fromEntries(ids().map((id) => [id, { ...tabState(id), waiters: tabState(id).waiters.length }])), serverCfg, lastError, versionMessage }),
  };
}

module.exports = { createChatGPTAgent, INSTALL_ID, TAB_ID, MAX_TABS, IDLE_CLOSE_MS, STUCK_MS, sleep };
