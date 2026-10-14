/*
 * Blog Automation Studio — content script for chatgpt.com.
 *
 * Runs ONE job at a time in this tab, following the documented algorithm:
 * open/validate conversation → detect login/challenge/limits → recover an
 * already-submitted prompt instead of resending → type the prompt as text and
 * verify it → attach files only when asked → send once → watch for real
 * completion (stop button gone + stable text, Continue generating handled) →
 * return only the final user-facing answer.
 *
 * Login and human-verification pages are NEVER automated: the owner completes
 * them; this script only waits (bounded) and reports.
 */
(function () {
  'use strict';
  if (window.top !== window) return;
  if (window.__basContentLoaded) return;
  window.__basContentLoaded = true;

  const EXTENSION_VERSION = '3.0.0';
  const A = globalThis.BASAdapter;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let current = null; // { job, port, cancelled, step, startedAt, pausedMs }

  class JobError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.code = code;
      this.extra = extra || {};
    }
  }

  function post(type, data) {
    if (!current || !current.port) return;
    try {
      current.port.postMessage(Object.assign({ type, jobId: current.job.id }, data || {}));
    } catch (e) {
      /* background restarting; it will resync via resume */
    }
  }

  function progress(step, extra) {
    if (!current) return;
    current.step = step;
    post('progress', Object.assign({ step, conversationUrl: realConversationUrl(), snapshot: A.snapshot({ step }) }, extra || {}));
  }

  function realConversationUrl() {
    return /\/c\/[0-9a-f-]{20,}$/i.test(location.pathname) ? location.origin + location.pathname : null;
  }

  function checkCancelled() {
    if (current && current.cancelled) throw new JobError('CANCELLED', 'Cancelled by the owner');
  }

  /** Wait (bounded) for the owner to finish a login/human check. Time here never counts as generation time. */
  async function waitForHumanAction(kind, minutes) {
    const started = Date.now();
    post('needs-human', { kind, message: kind === 'login' ? 'ChatGPT asks you to sign in.' : 'ChatGPT shows a human verification check.' });
    progress(kind === 'login' ? 'waiting for you to sign in to ChatGPT' : 'waiting for you to complete the human check');
    const deadline = started + minutes * 60_000;
    while (Date.now() < deadline) {
      checkCancelled();
      await sleep(3000);
      const state = A.pageState().state;
      if (state === 'ready') {
        current.pausedMs += Date.now() - started;
        post('human-resolved', { kind });
        return;
      }
    }
    throw new JobError(kind === 'login' ? 'LOGIN' : 'HUMAN_CHECK', kind === 'login' ? 'ChatGPT still asks for sign-in.' : 'Human verification was not completed in time.');
  }

  async function waitForReady(config) {
    const readySec = config.composerReadyTimeoutSec || 60;
    const deadline = Date.now() + readySec * 1000;
    while (Date.now() < deadline) {
      checkCancelled();
      const s = A.pageState();
      if (s.state === 'ready') return;
      if (s.state === 'login') await waitForHumanAction('login', config.humanCheckPauseMinutes || 10);
      else if (s.state === 'challenge') await waitForHumanAction('challenge', config.humanCheckPauseMinutes || 10);
      else if (s.state === 'usage-limit') throw new JobError('USAGE_LIMIT', s.message || 'ChatGPT usage limit reached', { retryAfterSec: s.retryAfterSec });
      else if (s.state === 'lost') throw new JobError('CONVERSATION_LOST', 'The saved ChatGPT conversation could not be loaded.');
      await sleep(500);
    }
    throw new JobError('ERROR', `ChatGPT composer did not become ready within ${readySec} seconds (the page layout may have changed; see the debug snapshot).`);
  }

  async function typeAndVerify(prompt) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const composer = A.findComposer();
      if (!composer) throw new JobError('ERROR', 'Chat composer not found.');
      A.clearComposer(composer);
      for (const chip of A.pastedTextChips()) {
        const remove = chip.querySelector('button');
        if (remove) remove.click();
      }
      await sleep(150);
      A.insertPrompt(composer, prompt);
      await sleep(400 + Math.min(2000, prompt.length / 50));
      const fresh = A.findComposer();
      if (A.pastedTextChips().length > 0) {
        progress(`prompt became a "Pasted text" attachment (attempt ${attempt}); retrying as typed text`);
        continue;
      }
      if (fresh && A.composerMatches(fresh, prompt)) return;
      progress(`composer content mismatch after entry (attempt ${attempt}); retrying`);
      await sleep(500);
    }
    throw new JobError('ERROR', 'Could not place the complete prompt in the composer as text (verified 3 times).');
  }

  async function attachFiles(job, config) {
    if (!job.attachments || job.attachments.length === 0) return;
    const input = A.fileInput();
    if (!input) throw new JobError('ERROR', 'File input not found for attachments.');
    const dt = new DataTransfer();
    for (const att of job.attachments) {
      const res = await chrome.runtime.sendMessage({ type: 'fetch-attachment', url: att.url });
      if (!res || !res.ok) throw new JobError('ERROR', `Could not load attachment ${att.name}: ${res && res.error}`);
      const bytes = Uint8Array.from(atob(res.base64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bytes], att.name, { type: att.mime }));
    }
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const send = A.findSendButton();
      if (A.attachmentChips().length >= job.attachments.length && send && !send.disabled && send.getAttribute('aria-disabled') !== 'true') return;
      await sleep(500);
    }
    throw new JobError('ERROR', 'Attachments did not finish uploading within 60 seconds.');
  }

  async function sendOnce(beforeUsers) {
    let send = null;
    for (let i = 0; i < 20; i++) {
      send = A.findSendButton();
      if (send && !send.disabled && send.getAttribute('aria-disabled') !== 'true') break;
      await sleep(250);
    }
    if (!send || send.disabled) throw new JobError('ERROR', 'Send button not available.');
    checkCancelled();
    progress('sending');
    send.click();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (A.userMessages().length > beforeUsers || A.isGenerating()) return A.userMessages()[A.userMessages().length - 1] || null;
      const limit = A.limitInfo();
      if (limit) throw new JobError('USAGE_LIMIT', limit.message, { retryAfterSec: limit.retryAfterSec });
      await sleep(250);
    }
    // We clicked but cannot prove ChatGPT accepted it: never resend blindly.
    throw new JobError('ERROR', 'Clicked Send but no new message appeared; cannot prove the prompt was submitted.', { uncertain: true });
  }

  /**
   * Wait for the final answer after the user turn at `userIndex`; returns
   * { text, html }. The anchor is re-resolved on every check because the page
   * re-renders (React) and replaces DOM nodes.
   */
  async function waitForAnswer(userIndex, config) {
    const timeoutMs = (config.generationTimeoutSec || 600) * 1000;
    const started = Date.now();
    let lastText = '';
    let stable = 0;
    let continues = 0;
    let lastProgress = 0;
    while (true) {
      checkCancelled();
      const elapsed = Date.now() - started - current.pausedMs;
      if (elapsed > timeoutMs) throw new JobError('ERROR', `No complete answer within ${Math.round(timeoutMs / 1000)}s.`);
      const state = A.pageState();
      if (state.state === 'challenge') {
        await waitForHumanAction('challenge', config.humanCheckPauseMinutes || 10);
        continue;
      }
      if (state.state === 'login') {
        await waitForHumanAction('login', config.humanCheckPauseMinutes || 10);
        continue;
      }
      const limit = A.limitInfo();
      const generating = A.isGenerating();
      const userEl = A.userMessages()[userIndex] || null;
      const assistants = userEl ? A.assistantAfter(userEl) : [];
      let answerEl = null;
      let errorTurn = null;
      if (assistants.length) {
        const last = assistants[assistants.length - 1];
        answerEl = A.finalAnswerElement(last) || last;
      } else if (userEl) {
        const generic = A.genericAnswerAfter(userEl);
        // An error/limit notice in place of an answer is never accepted as the answer.
        if (generic && generic.querySelector('[role="alert"], .text-token-text-error') && !A.finalAnswerElement(generic)) errorTurn = generic;
        else if (generic) answerEl = A.finalAnswerElement(generic) || generic;
      }
      const text = answerEl ? A.toMarkdown(answerEl) : '';
      const limitInAnswer = limit && text && A.normalizeForHash(text).toLowerCase().includes(A.normalizeForHash(limit.message).toLowerCase().slice(0, 40));
      if (limit && !generating && (!text || limitInAnswer)) throw new JobError('USAGE_LIMIT', limit.message, { retryAfterSec: limit.retryAfterSec });
      if (errorTurn && !generating) {
        const msg = (errorTurn.innerText || '').trim().slice(0, 300);
        throw new JobError('ERROR', `ChatGPT showed an error instead of an answer: ${msg}`);
      }
      if (!generating) {
        const cont = A.findContinueButton();
        if (cont && continues < 3) {
          continues++;
          progress(`continuing a cut-off answer (${continues}/3)`);
          cont.click();
          stable = 0;
          await sleep(1500);
          continue;
        }
      }
      if (!generating && text && text === lastText) stable++;
      else stable = 0;
      lastText = text;
      if (Date.now() - lastProgress > 5000) {
        lastProgress = Date.now();
        progress(generating ? `generating (${text.length} chars so far)` : text ? 'checking that the answer is complete' : 'waiting for the answer to start');
      }
      const composerReady = Boolean(A.findComposer()) && !A.findStopButton();
      if (stable >= 3 && composerReady) return { text, html: answerEl ? answerEl.innerHTML : null };
      await sleep(1000);
    }
  }

  async function runJob(job, config, port) {
    current = { job, port, cancelled: false, step: 'start', startedAt: Date.now(), pausedMs: 0 };
    try {
      progress('checking the ChatGPT page');
      await waitForReady(config);
      checkCancelled();

      // Exactly-once: recover an already-submitted prompt instead of resending.
      // Evidence = server "sent" record or this browser's own checkpoint. Without
      // evidence, only the LAST user turn may be ours (crash right after Send),
      // and never for a deliberate fresh regeneration of an identical prompt.
      const evidence = (job.reconcile && job.reconcile.sentAt) || (job.localCheckpoint && job.localCheckpoint.sentAt);
      const existing = await A.findSubmittedPrompt(job.promptHash, job.prompt);
      const isLastUserTurn = existing && existing.index === A.userMessages().length - 1;
      if (existing && (evidence || (isLastUserTurn && !job.fresh))) {
        progress(`found the prompt already sent (${existing.match}); recovering its answer instead of resending`, { sent: true, sentAt: new Date().toISOString() });
        const answer = await waitForAnswer(existing.index, config);
        post('complete', { text: answer.text, html: answer.html, conversationUrl: realConversationUrl(), recovered: true, elapsedMs: Date.now() - current.startedAt });
        return;
      }
      if (evidence) {
        throw new JobError('ERROR', 'The app recorded this prompt as sent, but it is not visible in this conversation. Paused for review instead of resending.', { uncertain: true });
      }

      progress('typing the prompt');
      await typeAndVerify(job.prompt);
      await attachFiles(job, config);
      checkCancelled();
      const confirm = await chrome.runtime.sendMessage({ type: 'pre-send-check', jobId: job.id });
      if (confirm && confirm.cancel) throw new JobError('CANCELLED', 'Cancelled before sending');
      const before = A.userMessages().length;
      await chrome.runtime.sendMessage({ type: 'checkpoint', jobId: job.id, operationId: job.operationId, step: 'sending', userTurnsBefore: before }).catch(() => {});
      const userEl = await sendOnce(before);
      const sentAt = new Date().toISOString();
      await chrome.runtime.sendMessage({ type: 'checkpoint', jobId: job.id, operationId: job.operationId, step: 'sent', sentAt, userTurnsBefore: before }).catch(() => {});
      progress('prompt sent', { sent: true, sentAt });
      for (let i = 0; i < 40 && !realConversationUrl(); i++) await sleep(500);
      progress('prompt sent; waiting for the answer', { sent: true, sentAt });
      void userEl;
      const answer = await waitForAnswer(before, config);
      if (!answer.text) throw new JobError('ERROR', 'The answer was empty.');
      post('complete', { text: answer.text, html: answer.html, conversationUrl: realConversationUrl(), recovered: false, elapsedMs: Date.now() - current.startedAt });
    } catch (error) {
      const code = error instanceof JobError ? error.code : 'ERROR';
      const extra = error instanceof JobError ? error.extra : {};
      post('fail', { code, message: String(error && error.message ? error.message : error), retryAfterSec: extra.retryAfterSec ?? null, uncertain: Boolean(extra.uncertain), snapshot: A.snapshot({ step: current && current.step, error: String(error && error.message) }) });
    } finally {
      current = null;
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      sendResponse({ ok: true, version: EXTENSION_VERSION, url: location.href, busy: Boolean(current), state: A.pageState().state, snapshot: A.snapshot() });
      return;
    }
    if (msg.type === 'run') {
      if (current) {
        sendResponse({ ok: false, error: 'busy' });
        return;
      }
      const port = chrome.runtime.connect({ name: `bas-job:${msg.job.id}` });
      port.onMessage.addListener((m) => {
        if (m && m.type === 'cancel' && current && current.job.id === msg.job.id) current.cancelled = true;
      });
      port.onDisconnect.addListener(() => {
        if (current && current.port === port) current.port = null;
      });
      sendResponse({ ok: true });
      void runJob(msg.job, msg.config || {}, port);
      return;
    }
    if (msg.type === 'snapshot') {
      sendResponse(A.snapshot({ busy: Boolean(current), step: current && current.step }));
    }
  });

  // Announce readiness (the background waits for this after navigation).
  chrome.runtime.sendMessage({ type: 'content-ready', url: location.href, version: EXTENSION_VERSION, state: A.pageState().state }).catch(() => {});
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      chrome.runtime.sendMessage({ type: 'url-changed', url: location.href }).catch(() => {});
    }
  }, 1000);
})();
