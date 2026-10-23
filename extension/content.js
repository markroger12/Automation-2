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

  const EXTENSION_VERSION = '3.4.5';
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

  function connectJobPort(jobId) {
    const port = chrome.runtime.connect({ name: `bas-job:${jobId}` });
    port.onMessage.addListener((m) => {
      if (m && m.type === 'cancel' && current && current.job.id === jobId) current.cancelled = true;
    });
    port.onDisconnect.addListener(() => {
      if (current && current.port === port) current.port = null;
    });
    return port;
  }

  function post(type, data) {
    if (!current) return;
    // The background service worker may have been restarted by Chrome (its end of the port is gone):
    // reconnect instead of silently dropping progress or the finished answer.
    if (!current.port) {
      try {
        current.port = connectJobPort(current.job.id);
      } catch (e) {
        return;
      }
    }
    try {
      current.port.postMessage(Object.assign({ type, jobId: current.job.id }, data || {}));
    } catch (e) {
      current.port = null;
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
    throw new JobError('ERROR', `ChatGPT composer did not become ready within ${readySec} seconds (the page layout may have changed; text boxes on the page: ${A.composerDiagnostics()}).`, { pageStuck: true });
  }

  async function typeAndVerify(prompt) {
    let lastProblem = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const composer = A.findComposer();
      if (!composer) throw new JobError('ERROR', `Chat composer not found (text boxes on the page: ${A.composerDiagnostics()}).`, { pageStuck: true });
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
        lastProblem = `ChatGPT turned the ${prompt.length}-character prompt into a "Pasted text" attachment`;
        progress(`prompt became a "Pasted text" attachment (attempt ${attempt}); retrying as typed text`);
        continue;
      }
      if (fresh && A.composerMatches(fresh, prompt)) return;
      lastProblem = A.composerMismatch(fresh, prompt);
      progress(`composer content mismatch after entry (attempt ${attempt}): ${lastProblem}; retrying`);
      await sleep(500);
    }
    throw new JobError('ERROR', `Could not place the complete prompt in the composer as text (verified 3 times): ${lastProblem}.`);
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
    if (!send || send.disabled) throw new JobError('ERROR', `Send button not available (text boxes on the page: ${A.composerDiagnostics()}).`, { pageStuck: true });
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
  /**
   * `anchor` = { job, priorKeys, fallbackIndex }: the prompt's user turn is found by its text (and, after a send, by a
   * turn key that was not on the page before), never by position alone — long conversations keep only their last
   * turns in the page, so positions shift.
   */
  async function waitForAnswer(anchor, config, expectImages) {
    const timeoutMs = (config.generationTimeoutSec || 600) * 1000;
    const started = Date.now();
    let lastText = '';
    let lastImages = '';
    let stable = 0;
    let continues = 0;
    let lastProgress = 0;
    let lastFront = 0;
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
      const userEl = await A.sentPromptTurn(anchor.job.promptHash, anchor.job.prompt, anchor);
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
      // Image answers (owner's earlier tool): done when ChatGPT is no longer drawing (composer Stop button, “Creating
      // image”) and the pictures have stayed the same for 6 seconds. A page-wide “streaming” marker is not used here:
      // it stayed on after the picture was finished (owner report: 600 s “generating (0 chars)” with the image shown).
      const images = expectImages && userEl ? A.generatedImagesAfter(userEl) : [];
      const imagesReady = images.length > 0 && images.every((img) => img.complete && img.naturalWidth >= 256);
      const imageSig = images.map((img) => `${img.currentSrc || img.src}:${img.naturalWidth}`).join('|');
      const drawing = expectImages ? Boolean(userEl && A.imageInProgress(userEl)) : generating;
      const settled = expectImages ? (imagesReady && imageSig === lastImages) || (!images.length && text && text === lastText && Date.now() - started > 45000) : text && text === lastText;
      if (!drawing && settled) stable++;
      else stable = 0;
      // ChatGPT draws a picture only while its tab is visible: bring the tab to the front (as the earlier tool did).
      if (expectImages && document.hidden && Date.now() - lastFront > 20000) {
        lastFront = Date.now();
        chrome.runtime.sendMessage({ type: 'come-to-front' }).catch(() => {});
      }
      lastText = text;
      lastImages = imageSig;
      if (Date.now() - lastProgress > 5000) {
        lastProgress = Date.now();
        progress(expectImages ? (drawing ? 'ChatGPT is creating the image' : images.length ? `checking that the image is finished (${images.length} found)` : 'waiting for the image') : generating ? `generating (${text.length} chars so far)` : text ? 'checking that the answer is complete' : 'waiting for the answer to start');
      }
      const composerReady = Boolean(A.findComposer()) && (expectImages ? !drawing : !A.findStopButton());
      if (stable >= (expectImages && imagesReady ? 6 : 3) && composerReady) return { text, html: answerEl ? answerEl.innerHTML : null, images: imagesReady ? images : [] };
      await sleep(1000);
    }
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  }

  /** Read each generated image (same-origin fetch, or via the background for the image CDN) and upload it to the dashboard. */
  async function uploadImages(job, images) {
    const ids = [];
    for (const [i, img] of images.slice(0, 4).entries()) {
      const src = img.currentSrc || img.src;
      let base64 = '';
      let mime = 'image/png';
      const url = new URL(src, location.href);
      if (url.origin === location.origin || url.protocol === 'blob:' || url.protocol === 'data:') {
        const res = await fetch(src, { credentials: 'include' });
        if (!res.ok) throw new JobError('ERROR', `Could not read generated image ${i + 1} (HTTP ${res.status}).`);
        const blob = await res.blob();
        mime = blob.type || mime;
        base64 = await blobToBase64(blob);
      } else {
        const res = await chrome.runtime.sendMessage({ type: 'fetch-image', url: src });
        if (!res || !res.ok) throw new JobError('ERROR', `Could not read generated image ${i + 1}: ${res && res.error}`);
        base64 = res.base64;
        mime = res.mime || mime;
      }
      if (!/^image\/(png|jpeg|webp|gif)$/.test(mime)) mime = 'image/png';
      const up = await chrome.runtime.sendMessage({ type: 'upload-image', jobId: job.id, name: `generated-${i + 1}`, mime, dataBase64: base64, sourceUrl: src.startsWith('data:') ? null : src.slice(0, 1900) });
      if (!up || !up.ok) throw new JobError('ERROR', `Uploading generated image ${i + 1} failed: ${up && up.error}`);
      ids.push({ mediaAssetId: up.mediaAssetId });
    }
    return ids;
  }

  /** Bytes of a displayed picture: same-origin/blob/data in the page, ChatGPT's image hosts through the background. */
  async function readPicture(src) {
    const url = new URL(src, location.href);
    if (url.origin === location.origin || url.protocol === 'blob:' || url.protocol === 'data:') {
      const res = await fetch(src, { credentials: 'include' });
      if (!res.ok) return null;
      const blob = await res.blob();
      return { base64: await blobToBase64(blob), mime: blob.type || 'image/jpeg' };
    }
    if (!A.isPictureHost(url)) return null;
    const res = await chrome.runtime.sendMessage({ type: 'fetch-image', url: src });
    return res && res.ok ? { base64: res.base64, mime: res.mime || 'image/jpeg' } : null;
  }

  /** The picture the gallery viewer shows, once it differs from `previous` (up to 6 s; then whatever it shows). */
  async function viewerPicture(previous) {
    const deadline = Date.now() + 6000;
    let shown = null;
    while (Date.now() < deadline) {
      checkCancelled();
      const dialog = A.galleryDialog();
      if (!dialog) return null;
      shown = A.shownPicture(dialog);
      if (shown && (shown.currentSrc || shown.src) !== previous) return shown;
      await sleep(250);
    }
    return shown;
  }

  /** Wait (up to `ms`) for the gallery viewer to open; null if it does not. */
  async function openedViewer(ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const dialog = A.galleryDialog();
      if (dialog) return dialog;
      await sleep(200);
    }
    return null;
  }

  /** Close the gallery viewer and wait (up to 3 s) until it is gone. */
  async function closeViewer() {
    A.closeGalleryDialog();
    const deadline = Date.now() + 3000;
    while (A.galleryDialog() && Date.now() < deadline) await sleep(200);
    await sleep(300);
  }

  /**
   * Image search (as in the owner's earlier tool): open the picture gallery ChatGPT shows with its answer, step through
   * it with “Next” like a person (or open each picture when the viewer has no “Next”) and save up to 10 large pictures,
   * plus the thumbnails. Pictures this extension may not read are reported as links; the app downloads those through
   * its own safe fetcher. Returns { images, imageLinks, note, report }.
   */
  async function collectGallery(job, userEl, config) {
    const deadline = Date.now() + (config.galleryWaitSec || 90) * 1000;
    const turn = async () => {
      if (!userEl || !userEl.isConnected) userEl = (await A.sentPromptTurn(job.promptHash, job.prompt, { priorKeys: null, fallbackIndex: -1 })) || userEl;
      return userEl;
    };
    let thumbs = A.galleryThumbs(userEl);
    while (!thumbs.length && Date.now() < deadline) {
      checkCancelled();
      progress(`waiting for the picture gallery (${document.images.length} picture(s) on the page)`);
      await sleep(2000);
      userEl = (await A.sentPromptTurn(job.promptHash, job.prompt, { priorKeys: null, fallbackIndex: -1 })) || userEl;
      thumbs = A.galleryThumbs(userEl);
    }
    if (!thumbs.length) return { images: [], imageLinks: [], note: 'ChatGPT showed no picture gallery.' };
    const picked = [];
    const seen = new Set();
    const add = (img) => {
      const src = img.currentSrc || img.src;
      if (!src || seen.has(src) || picked.length >= 10) return false;
      seen.add(src);
      picked.push({ src, width: img.naturalWidth || 0, height: img.naturalHeight || 0 });
      return true;
    };
    const openable = thumbs.filter((img) => !A.brokenPicture(img)).length;
    let large = 0;
    try {
      // Open the viewer from a picture the page shows (a broken one may be a link that opens another tab).
      const opener = thumbs.find((img) => !A.brokenPicture(img));
      if (!opener) throw new Error('no picture to open');
      opener.click();
      await sleep(1200);
      // One picture per step: wait until the viewer shows a different one after “Next” (it may slide), stop when it
      // shows nothing new or comes back to a picture already taken.
      let previous = null;
      // Whether the viewer went through all its pictures: “Next” turned off at the last one, or it came back round.
      let walked = false;
      for (let step = 0; step < 12 && picked.length < 10; step++) {
        const img = await viewerPicture(previous);
        if (!img) break;
        const src = img.currentSrc || img.src;
        if (step > 0 && (src === previous || seen.has(src))) {
          walked = src !== previous;
          break;
        }
        if (add(img)) large++;
        previous = src;
        const dialog = A.galleryDialog();
        const next = dialog && A.galleryNextButton(dialog);
        walked = Boolean(next && next.disabled);
        if (!next || next.disabled) break;
        next.click();
      }
      await closeViewer();
      // Owner report (ChatGPT showed about 6 photos, the article got 2): a viewer without “Next”, or one whose picture
      // stopped changing, gave fewer large pictures than the gallery has; then each picture is opened by itself, as a
      // person would.
      if (!walked && large < openable) {
        // Never a picture that links to another site (it would open a new tab).
        const opensSite = (img) => {
          const a = img.closest('a[href]');
          return Boolean(a && new URL(a.href, location.href).origin !== location.origin);
        };
        let last = null;
        let misses = 0;
        for (let k = 0; k < openable && picked.length < 10; k++) {
          checkCancelled();
          const tile = A.galleryThumbs(await turn()).filter((img) => !A.brokenPicture(img))[k];
          if (!tile) break;
          if (opensSite(tile)) continue;
          progress(`opening gallery picture ${k + 1} of ${openable}`);
          tile.click();
          if (!(await openedViewer(3000))) {
            if (++misses >= 2) break;
            continue;
          }
          const img = await viewerPicture(last);
          if (img) {
            last = img.currentSrc || img.src;
            if (add(img)) large++;
          }
          await closeViewer();
        }
      }
    } catch (e) {
      /* the thumbnails are enough */
      if (A.galleryDialog()) A.closeGalleryDialog();
    }
    thumbs.forEach(add);
    const images = [];
    const imageLinks = [];
    for (const [i, p] of picked.entries()) {
      checkCancelled();
      progress(`saving gallery pictures (${i + 1}/${picked.length})`);
      let data = null;
      try {
        data = await readPicture(p.src);
      } catch (e) {
        data = null;
      }
      if (!data) {
        if (/^https?:/i.test(p.src)) imageLinks.push({ url: p.src.slice(0, 1900), width: p.width, height: p.height });
        continue;
      }
      const mime = /^image\/(png|jpeg|webp|gif)$/.test(data.mime) ? data.mime : 'image/jpeg';
      const up = await chrome.runtime.sendMessage({ type: 'upload-image', jobId: job.id, name: `gallery-${i + 1}`, mime, dataBase64: data.base64, sourceUrl: /^https?:/i.test(p.src) ? p.src.slice(0, 1900) : null });
      if (up && up.ok) images.push({ mediaAssetId: up.mediaAssetId });
      else if (/^https?:/i.test(p.src)) imageLinks.push({ url: p.src.slice(0, 1900), width: p.width, height: p.height });
    }
    const report = `${thumbs.length} picture(s) in the gallery (${thumbs.length - openable} not shown by the page), ${large} opened large, ${images.length} saved, ${imageLinks.length} reported as link(s).`;
    return { images, imageLinks: imageLinks.slice(0, 20), note: null, report };
  }

  /** Poll (bounded) for a prompt the app recorded as sent; null if it never shows up. */
  async function waitForSubmittedPrompt(job, config) {
    const deadline = Date.now() + (config.reconcileWaitSec || 30) * 1000;
    while (Date.now() < deadline) {
      checkCancelled();
      await sleep(1000);
      const found = await A.findSubmittedPrompt(job.promptHash, job.prompt, { evidence: true });
      if (found) return found;
    }
    return null;
  }

  /** The conversation the prompt was sent in, if the app recorded it. */
  function recordedConversationUrl(job) {
    const url = (job.reconcile && job.reconcile.conversationUrl) || (job.localCheckpoint && job.localCheckpoint.conversationUrl) || null;
    return url && /^https:\/\/chatgpt\.com\/c\/[0-9a-f-]{20,}$/i.test(url) ? url : null;
  }

  /** Reload the page for this job once (the background runs the job again when the page is back). False if done before. */
  async function reloadOnce(job, why) {
    const key = `bas-fresh-page:${job.id}`;
    if (sessionStorage.getItem(key)) return false;
    sessionStorage.setItem(key, new Date().toISOString());
    progress(`the ChatGPT page stopped working (${why.slice(0, 120)}); reloading it once`);
    await chrome.runtime.sendMessage({ type: 'checkpoint', jobId: job.id, operationId: job.operationId, step: 'reloading' }).catch(() => {});
    location.reload();
    return true;
  }

  async function runJob(job, config, port) {
    current = { job, port, cancelled: false, step: 'start', startedAt: Date.now(), pausedMs: 0 };
    let typed = false;
    try {
      progress('checking the ChatGPT page');
      await waitForReady(config);
      checkCancelled();

      // Exactly-once: recover an already-submitted prompt instead of resending.
      // Evidence = server "sent" record or this browser's own checkpoint. Without
      // evidence, only the LAST user turn may be ours (crash right after Send),
      // and never for a deliberate fresh regeneration of an identical prompt.
      const evidence = (job.reconcile && job.reconcile.sentAt) || (job.localCheckpoint && job.localCheckpoint.sentAt);
      let existing = await A.findSubmittedPrompt(job.promptHash, job.prompt, { evidence: Boolean(evidence) });
      if (!existing && evidence) {
        // After a reload the real ChatGPT shows the composer before the conversation's turns: give them time to render.
        progress('looking for the already-sent prompt in this conversation');
        existing = await waitForSubmittedPrompt(job, config);
        // Restarted on another page (e.g. a new chat): open the recorded conversation once; the reloaded page resumes the job.
        const recorded = recordedConversationUrl(job);
        const navKey = `bas-reconcile-nav:${job.id}`;
        if (!existing && recorded && location.origin + location.pathname !== recorded && !sessionStorage.getItem(navKey)) {
          sessionStorage.setItem(navKey, '1');
          progress('opening the conversation the prompt was sent in');
          location.assign(recorded);
          return;
        }
      }
      const isLastUserTurn = existing && existing.index === A.userMessages().length - 1;
      if (existing && (evidence || (isLastUserTurn && !job.fresh))) {
        progress(`found the prompt already sent (${existing.match}); recovering its answer instead of resending`, { sent: true, sentAt: new Date().toISOString() });
        const answer = await waitForAnswer({ job, priorKeys: null, fallbackIndex: existing.index }, config, job.expectImages);
        const gallery = job.expectGallery ? await collectGallery(job, existing.element, config) : null;
        const images = gallery ? gallery.images : job.expectImages ? await uploadImages(job, answer.images) : [];
        post('complete', { text: answer.text, html: answer.html, images, imageLinks: gallery ? gallery.imageLinks : undefined, galleryReport: gallery ? gallery.report : undefined, conversationUrl: realConversationUrl(), recovered: true, elapsedMs: Date.now() - current.startedAt });
        return;
      }
      if (evidence) {
        const why = `restarted after: ${job.resumedBy || 'a new claim'}; ${A.promptMismatchReport(job.prompt)}`;
        throw new JobError('ERROR', `The app recorded this prompt as sent, but it is not visible in this conversation (${why}). Paused for review instead of resending.`, { uncertain: true });
      }

      progress('typing the prompt');
      typed = true;
      await typeAndVerify(job.prompt);
      await attachFiles(job, config);
      checkCancelled();
      const confirm = await chrome.runtime.sendMessage({ type: 'pre-send-check', jobId: job.id });
      if (confirm && confirm.cancel) throw new JobError('CANCELLED', 'Cancelled before sending');
      const before = A.userMessages().length;
      const priorKeys = A.userMessages().map(A.turnKey).filter(Boolean);
      await chrome.runtime.sendMessage({ type: 'checkpoint', jobId: job.id, operationId: job.operationId, step: 'sending', userTurnsBefore: before }).catch(() => {});
      const userEl = await sendOnce(before);
      const sentAt = new Date().toISOString();
      await chrome.runtime.sendMessage({ type: 'checkpoint', jobId: job.id, operationId: job.operationId, step: 'sent', sentAt, userTurnsBefore: before }).catch(() => {});
      progress('prompt sent', { sent: true, sentAt });
      for (let i = 0; i < 40 && !realConversationUrl(); i++) await sleep(500);
      progress('prompt sent; waiting for the answer', { sent: true, sentAt });
      void userEl;
      const answer = await waitForAnswer({ job, priorKeys, fallbackIndex: before }, config, job.expectImages);
      const gallery = job.expectGallery ? await collectGallery(job, await A.sentPromptTurn(job.promptHash, job.prompt, { priorKeys, fallbackIndex: before }), config) : null;
      const images = gallery ? gallery.images : job.expectImages && answer.images.length ? await uploadImages(job, answer.images) : [];
      const imageLinks = gallery ? gallery.imageLinks : [];
      if (!answer.text && !images.length && !imageLinks.length) throw new JobError('ERROR', 'The answer was empty.');
      post('complete', { text: answer.text || (gallery && gallery.note) || '', html: answer.html, images, imageLinks: gallery ? imageLinks : undefined, galleryReport: gallery ? gallery.report : undefined, conversationUrl: realConversationUrl(), recovered: false, elapsedMs: Date.now() - current.startedAt });
    } catch (error) {
      const code = error instanceof JobError ? error.code : 'ERROR';
      const extra = error instanceof JobError ? error.extra : {};
      let message = String(error && error.message ? error.message : error);
      if (extra.pageStuck) {
        // Owner report (FINAL_ARTICLE after LONG_ARTICLE): the page stopped working — no composer, or no Send button —
        // and every retry ran on the same stuck page. Nothing was sent (these errors all come before Send): reload the
        // page once, as a person would, and run the job again there; the prompt is typed afresh.
        const composer = typed ? A.findComposer() : null;
        if (composer) A.clearComposer(composer);
        if (await reloadOnce(job, message)) return;
        message = `${message} The ChatGPT page was reloaded once and it still did not work.`;
      }
      post('fail', { code, message, retryAfterSec: extra.retryAfterSec ?? null, uncertain: Boolean(extra.uncertain), freshPage: Boolean(extra.pageStuck), snapshot: A.snapshot({ step: current && current.step, error: message }) });
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
      const port = connectJobPort(msg.job.id);
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
