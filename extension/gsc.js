/*
 * Search Console “Request indexing” (owner request): on the URL Inspection page Automation Chrome opened for a published
 * article, wait for Google's result, click REQUEST INDEXING as the owner does, and report what Google answered.
 * Only reads the page text and clicks that one button; Google's checks (sign-in, “I'm not a robot”) are left to the
 * owner. English and German Search Console.
 */
(function () {
  'use strict';
  if (window.__basGscLoaded) return;
  window.__basGscLoaded = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = () => (document.body && document.body.innerText) || '';
  const RE = {
    // The inspection result has loaded (any verdict).
    loaded: /URL is (not )?on Google|URL is unknown to Google|Page is (not )?indexed|URL ist (nicht )?(bei|auf) Google|URL ist Google nicht bekannt|Seite (ist|wird) (nicht )?indexiert/i,
    button: /^\s*(request indexing|indexierung beantragen)\s*$/i,
    testing: /Testing if live URL can be indexed|Es wird getestet, ob die Live-URL indexiert werden kann/i,
    requested: /Indexing requested|Indexierung beantragt/i,
    quota: /Quota exceeded|Kontingent überschritten/i,
    noAccess: /You don.t have access to (this )?property|do not have permission|keine Berechtigung|Sie haben keinen Zugriff/i,
    notInProperty: /URL is not in property|URL gehört nicht zur Property/i,
    failed: /Something went wrong|Ein Problem ist aufgetreten|Ein Fehler ist aufgetreten|could not request indexing/i,
  };

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** The REQUEST INDEXING control: the innermost clickable element whose own text is exactly that. */
  function requestButton() {
    const els = Array.from(document.querySelectorAll('[role="button"], button, a, span, div')).filter((el) => RE.button.test(el.textContent || '') && visible(el));
    if (!els.length) return null;
    const inner = els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
    const pick = inner[0];
    return pick.closest('[role="button"], button, a') || pick;
  }

  function captcha() {
    return Boolean(document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"], #captcha-form'));
  }

  /** The sentence of the result dialog that matched, for the record. */
  function said(re) {
    const line = text().split('\n').map((l) => l.trim()).find((l) => re.test(l)) || '';
    const next = text().split('\n').map((l) => l.trim()).filter(Boolean);
    const i = next.indexOf(line);
    return [line, next[i + 1] || ''].join(' ').trim().slice(0, 300);
  }

  async function run(jobId) {
    // Tell the extension every 10 s that the page is still working: Chrome may stop an idle extension background
    // during the minutes Google takes, and the answer would have nowhere to go.
    const alive = setInterval(() => chrome.runtime.sendMessage({ type: 'gsc-alive', jobId }).catch(() => {}), 10_000);
    try {
      return await steps();
    } finally {
      clearInterval(alive);
    }
  }

  async function steps() {
    // 1. The inspection result (Google takes a few seconds).
    const loadUntil = Date.now() + 90_000;
    while (Date.now() < loadUntil) {
      if (captcha()) return { outcome: 'HUMAN_CHECK', message: 'Google showed a check on the Search Console page.' };
      if (RE.noAccess.test(text())) return { outcome: 'NO_ACCESS', message: said(RE.noAccess) };
      if (RE.notInProperty.test(text())) return { outcome: 'NO_ACCESS', message: said(RE.notInProperty) };
      if (RE.loaded.test(text()) && requestButton()) break;
      await sleep(1000);
    }
    const button = requestButton();
    if (!button) return { outcome: 'ERROR', message: RE.loaded.test(text()) ? 'The inspection result has no “Request indexing” button.' : 'The URL Inspection result did not load within 90 seconds.' };
    // 2. Request indexing, as the owner clicks it; Google first tests the live URL (about a minute or two).
    button.scrollIntoView({ block: 'center' });
    button.click();
    const until = Date.now() + 4 * 60_000;
    while (Date.now() < until) {
      await sleep(1000);
      const t = text();
      if (RE.requested.test(t)) return { outcome: 'REQUESTED', message: said(RE.requested) };
      if (RE.quota.test(t)) return { outcome: 'QUOTA', message: said(RE.quota) };
      if (captcha()) return { outcome: 'HUMAN_CHECK', message: 'Google showed a check after “Request indexing”.' };
      if (RE.failed.test(t) && !RE.testing.test(t)) return { outcome: 'ERROR', message: said(RE.failed) };
    }
    return { outcome: 'ERROR', message: 'No answer from Search Console within 4 minutes after “Request indexing”.' };
  }

  let running = false;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'gsc-run') return;
    if (running) {
      sendResponse({ ok: false, error: 'busy' });
      return;
    }
    running = true;
    sendResponse({ ok: true });
    run(msg.jobId)
      .catch((e) => ({ outcome: 'ERROR', message: String((e && e.message) || e) }))
      .then((result) => chrome.runtime.sendMessage({ type: 'gsc-done', jobId: msg.jobId, outcome: result.outcome, message: result.message }))
      .finally(() => (running = false));
  });
  chrome.runtime.sendMessage({ type: 'gsc-ready', url: location.href }).catch(() => {});
})();
