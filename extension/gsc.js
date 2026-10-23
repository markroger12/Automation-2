/*
 * Search Console “Request indexing” (owner request), as the owner does it (owner's video): on the property's Search
 * Console page, type the published article's URL into “Inspect any URL in …” and press Enter; when the result shows
 * that URL, click REQUEST INDEXING, wait for the live test, and report what Google answered. Only types that URL and
 * clicks that one button; Google's checks (sign-in, “I'm not a robot”) are left to the owner. English and German.
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
    // Google's own 404 page (owner report: a link with the post's URL as `id` is not found).
    notFound: /^\s*404\.\s*That.s an error|The requested URL was not found on this server/i,
    box: /inspect any url|url .*(prüfen|untersuchen)/i,
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

  /**
   * A check Google really shows: a reCAPTCHA box or challenge on screen, or Google's “unusual traffic” page. Owner
   * report (Michael Consuelos: “Google showed a check” though none was on screen, the tab closed after a minute):
   * Google's pages load an invisible reCAPTCHA, kept hidden or off screen; that is not a check.
   */
  function captcha() {
    if (document.querySelector('#captcha-form')) return true;
    return Array.from(document.querySelectorAll('iframe[src*="recaptcha"], iframe[title*="recaptcha" i]')).some((f) => {
      if (/[?&]size=invisible\b/.test(f.getAttribute('src') || '') || !visible(f)) return false;
      const r = f.getBoundingClientRect();
      return r.width >= 60 && r.height >= 60 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    });
  }

  const duration = (ms) => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);

  /**
   * Google shows a check: the owner completes it (never this extension). The tab comes to the front with a
   * notification, and the request goes on once the check is gone, or as soon as Google's answer is there (`done`);
   * false when the check is still there after the pause.
   */
  async function ownerCompletes(job, done) {
    chrome.runtime.sendMessage({ type: 'gsc-check', jobId: job.jobId }).catch(() => {});
    const until = Date.now() + job.humanWaitMs;
    while (Date.now() < until) {
      await sleep(1000);
      if (!captcha() || done()) return true;
    }
    return false;
  }

  const notCompleted = (job, when) => ({ outcome: 'HUMAN_CHECK', message: `Google showed a check (“I'm not a robot”) ${when}; it was not completed within ${duration(job.humanWaitMs)}.` });

  /** The sentence of the result dialog that matched, for the record. */
  function said(re) {
    const line = text().split('\n').map((l) => l.trim()).find((l) => re.test(l)) || '';
    const next = text().split('\n').map((l) => l.trim()).filter(Boolean);
    const i = next.indexOf(line);
    return [line, next[i + 1] || ''].join(' ').trim().slice(0, 300);
  }

  /** The “Inspect any URL in …” box at the top of Search Console. */
  function searchBox() {
    const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
    return inputs.find((i) => RE.box.test(`${i.getAttribute('aria-label') || ''} ${i.getAttribute('placeholder') || ''}`)) || null;
  }

  /** Type the URL and press Enter, as the owner does. */
  function inspect(input, url) {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, url);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    for (const type of ['keydown', 'keypress', 'keyup']) input.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    const form = input.closest('form');
    if (form && form.requestSubmit) form.requestSubmit();
  }

  const sameUrl = (shown, url) => {
    const n = (u) => u.trim().replace(/\/+$/, '').toLowerCase();
    return n(shown).includes(n(url));
  };

  async function run(job) {
    // Tell the extension every 10 s that the page is still working: Chrome may stop an idle extension background
    // during the minutes Google takes, and the answer would have nowhere to go.
    const alive = setInterval(() => chrome.runtime.sendMessage({ type: 'gsc-alive', jobId: job.jobId }).catch(() => {}), 10_000);
    try {
      return await steps(job);
    } finally {
      clearInterval(alive);
    }
  }

  /** Go on in this tab with another address (a new page runs this script again). */
  function goTo(url) {
    location.href = url;
    return null;
  }

  async function steps(job) {
    const resource = new URLSearchParams(location.search).get('resource_id');
    const home = resource ? `https://search.google.com/search-console?resource_id=${encodeURIComponent(resource)}` : null;
    // 0. Google's 404 (a link it does not know): inspect from the property's page instead, as the owner does.
    if (RE.notFound.test(text())) {
      if (home && job.attempt < 3 && !location.pathname.endsWith('/search-console')) return goTo(home);
      return { outcome: 'ERROR', message: 'Search Console answered “404. That’s an error” for the URL Inspection page.' };
    }
    // 1. Inspect the URL (type it into “Inspect any URL in …”), then wait for Google's result (a few seconds).
    let typed = false;
    let loadUntil = Date.now() + 45_000;
    while (Date.now() < loadUntil) {
      if (captcha()) {
        const started = Date.now();
        if (!(await ownerCompletes(job, () => RE.loaded.test(text()) && Boolean(requestButton())))) return notCompleted(job, 'on the Search Console page');
        loadUntil += Date.now() - started;
      }
      if (RE.noAccess.test(text())) return { outcome: 'NO_ACCESS', message: said(RE.noAccess) };
      if (RE.notInProperty.test(text())) return { outcome: 'NO_ACCESS', message: said(RE.notInProperty) };
      if (RE.loaded.test(text()) && requestButton()) break;
      if (!typed && job.typeUrl && !location.pathname.includes('/inspect')) {
        const box = searchBox();
        if (box) {
          inspect(box, job.typeUrl);
          typed = true;
          loadUntil = Date.now() + 90_000;
        }
      }
      await sleep(1000);
    }
    const button = requestButton();
    if (!button) {
      // The box was not found or did nothing: the inspection link from Google's URL Inspection API, when there is one.
      if (job.altUrl && job.attempt < 3 && location.href !== job.altUrl) return goTo(job.altUrl);
      return { outcome: 'ERROR', message: RE.loaded.test(text()) ? 'The inspection result has no “Request indexing” button.' : typed ? 'The URL Inspection result did not load within 90 seconds after typing the URL.' : 'The “Inspect any URL” box was not found on the Search Console page.' };
    }
    // Never request indexing for another page: the result must show the article's URL.
    if (job.typeUrl && !sameUrl(text(), job.typeUrl)) return { outcome: 'ERROR', message: `Search Console shows another URL than ${job.typeUrl}; nothing was requested.` };
    // 2. Request indexing, as the owner clicks it; Google first tests the live URL (about a minute or two).
    button.scrollIntoView({ block: 'center' });
    button.click();
    let until = Date.now() + 4 * 60_000;
    while (Date.now() < until) {
      await sleep(1000);
      const t = text();
      if (RE.requested.test(t)) return { outcome: 'REQUESTED', message: said(RE.requested) };
      if (RE.quota.test(t)) return { outcome: 'QUOTA', message: said(RE.quota) };
      if (captcha()) {
        const started = Date.now();
        if (!(await ownerCompletes(job, () => RE.requested.test(text()) || RE.quota.test(text())))) return notCompleted(job, 'after “Request indexing”');
        until += Date.now() - started;
        continue;
      }
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
    run({ jobId: msg.jobId, typeUrl: msg.typeUrl || null, altUrl: msg.altUrl || null, attempt: Number(msg.attempt) || 1, humanWaitMs: Number(msg.humanWaitMs) || 10 * 60_000 })
      .catch((e) => ({ outcome: 'ERROR', message: String((e && e.message) || e) }))
      .then((result) => {
        // null: this tab goes on to another address; the next page reports.
        if (result) return chrome.runtime.sendMessage({ type: 'gsc-done', jobId: msg.jobId, outcome: result.outcome, message: result.message });
      })
      .finally(() => (running = false));
  });
  chrome.runtime.sendMessage({ type: 'gsc-ready', url: location.href }).catch(() => {});
})();
