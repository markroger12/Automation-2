/*
 * Blog Automation Studio — ChatGPT page adapter.
 *
 * ALL selectors and DOM heuristics for chatgpt.com live in this one file so
 * they can be maintained and fixture-tested (tests/integration/extension.test.ts
 * runs them against fake ChatGPT pages). Read-only except for the composer and
 * the explicit Send / Continue buttons. No private endpoints are used: answers
 * are read from the rendered conversation, with a generic fallback based on
 * the page's own visible conversation representation.
 */
(function () {
  'use strict';

  const SELECTORS = {
    composer: [
      // Chat/Work layout (Sept 2026): no #prompt-textarea; a ProseMirror textbox inside the composer form.
      'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
      '#prompt-textarea[contenteditable="true"]',
      'div[contenteditable="true"]#prompt-textarea',
      'div.ProseMirror[contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
      'textarea#prompt-textarea',
      'form textarea[placeholder]',
      'main textarea',
    ],
    // Canvas / writing-block editors must never be mistaken for the chat composer.
    composerExclusions: ['[data-testid*="canvas"]', '[class*="canvas"]', '[data-writing-block]', '.writing-block', '[aria-label*="Canvas"]'],
    sendButton: [
      'button[data-testid="send-button"]',
      'form[data-chatgpt-composer] button[type="submit"]',
      '#composer-submit-button',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Prompt senden"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="Senden"]',
    ],
    stopButton: [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="Stopp"]',
      'button[aria-label*="Anhalten"]',
    ],
    // The Chat/Work layout rolled out from Sept 2026 has no data-message-author-role / conversation-turn markers:
    // the user's text sits in [data-user-message-bubble] inside a "…:user" search unit, the answer in
    // [data-markdown-text-style="assistant-message"] inside a "…:assistant" unit, each turn in [data-turn-key].
    // Several selectors may match one turn; userMessages()/assistantMessages() keep the innermost match.
    userMessage: [
      '[data-message-author-role="user"]',
      '[data-testid^="conversation-turn"][data-turn="user"]',
      'article[data-turn="user"]',
      '[data-user-message-bubble]',
      '[data-content-search-unit-key$=":user"]',
      '[data-chatgpt-search-unit-key$=":user"]',
      '[data-message-role="user"]',
    ],
    assistantMessage: [
      '[data-message-author-role="assistant"]',
      '[data-testid^="conversation-turn"][data-turn="assistant"]',
      'article[data-turn="assistant"]',
      '[data-markdown-text-style="assistant-message"]',
      '[data-content-search-unit-key$=":assistant"]',
      '[data-chatgpt-search-unit-key$=":assistant"]',
      '[data-message-role="assistant"]',
    ],
    turn: ['[data-testid^="conversation-turn"]', 'article[data-turn]', '[data-turn-key]', 'main article'],
    markdown: ['.markdown', '[class*="markdown"]', '.prose', '[data-markdown-text-style="assistant-message"]'],
    nonAnswer: [
      '[data-testid*="reasoning"]',
      '[data-testid*="thinking"]',
      '[data-testid*="tool"]',
      '[class*="thinking"]',
      '[class*="reasoning"]',
      'details',
      'button',
      'svg',
      '[data-testid="webpage-citation-pill"]',
      '[class*="citation"]',
      '[aria-hidden="true"]',
    ],
    attachmentChip: ['[data-testid*="attachment"]', '[data-testid*="file-tile"]', '[class*="attachment"]'],
    // Images ChatGPT generated in an answer (not avatars or icons).
    generatedImage: ['img[src*="/backend-api/estuary/content"]', 'img[src*="oaiusercontent.com"]', 'img[src*="oaidalleapiprodscus"]', 'img[alt^="Generated image"]', 'img[alt^="Generiertes Bild"]'],
    fileInput: ['input[type="file"]'],
    loginButton: ['[data-testid="login-button"]', 'a[href*="/auth/login"]', 'button[data-testid="log-in-button"]'],
    challenge: ['iframe[src*="challenges.cloudflare.com"]', '#challenge-stage', '#cf-challenge-running', '#challenge-form', '[data-testid="human-verification"]'],
  };

  const TEXT = {
    continue: [/^continue generating$/i, /^continue$/i, /^weiter generieren$/i, /^fortfahren$/i],
    login: [/^log in$/i, /^anmelden$/i, /^sign up$/i],
    challenge: [/verify you are human/i, /bestätigen sie, dass sie ein mensch sind/i, /checking if the site connection is secure/i, /just a moment/i],
    usageLimit: [
      /you(?:'|’)ve reached (?:the|our|your) (?:current )?(?:usage cap|limit)/i,
      /you(?:'|’)ve hit (?:the|your) (?:\w+ )?limit/i,
      /too many requests/i,
      /you have sent too many messages/i,
      /usage limit/i,
      /rate limit/i,
      /limit resets/i,
      /du hast (?:dein|das) limit erreicht/i,
      /zu viele anfragen/i,
    ],
    lost: [/unable to load conversation/i, /conversation not found/i, /this conversation (?:is|was) (?:deleted|not available)/i, /konversation nicht gefunden/i],
    networkError: [/network error/i, /something went wrong/i, /netzwerkfehler/i],
    pastedText: [/pasted text/i, /eingefügter text/i],
  };

  function qsAll(selectors, root) {
    const out = [];
    for (const sel of selectors) {
      try {
        for (const el of (root || document).querySelectorAll(sel)) if (!out.includes(el)) out.push(el);
      } catch (e) {
        /* invalid selector override */
      }
    }
    return out;
  }

  function qs(selectors, root) {
    return qsAll(selectors, root)[0] || null;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function insideExcluded(el) {
    return SELECTORS.composerExclusions.some((sel) => {
      try {
        return Boolean(el.closest(sel));
      } catch (e) {
        return false;
      }
    });
  }

  const PROMPT_PLACEHOLDER = /ask chatgpt|ask anything|message chatgpt|nachricht an chatgpt|frag chatgpt|frage chatgpt/i;

  /** The form around a textbox when it is the chat's composer form (it holds the send, submit or voice button). */
  function composerFormOf(el) {
    const form = el.closest('form');
    if (!form) return null;
    const button = form.querySelector([...SELECTORS.sendButton, ...SELECTORS.stopButton, 'button[type="submit"]', 'button[aria-label*="voice" i]', 'button[aria-label*="dictat" i]', 'button[data-testid*="composer"]'].join(','));
    return button ? form : null;
  }

  function placeholderOf(el) {
    const inner = el.querySelector && el.querySelector('[data-placeholder]');
    return `${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('data-placeholder') || ''} ${inner ? inner.getAttribute('data-placeholder') : ''}`;
  }

  /**
   * The chat composer. Owner report (FINAL_ARTICLE, “Chat composer not found” for hours): in ChatGPT's “Work”
   * layout the whole page can sit in a canvas-styled container, and the canvas exclusion (meant for document editors)
   * then refused the real composer. A textbox in the composer form (with the send/voice button) is always the
   * composer; a writing block never is.
   */
  function findComposer() {
    const candidates = qsAll(SELECTORS.composer).filter((el) => isVisible(el));
    const inForm = candidates.find((el) => composerFormOf(el) && !el.closest('[data-writing-block], .writing-block'));
    if (inForm) return inForm;
    for (const el of candidates) if (!insideExcluded(el)) return el;
    // Last resort: a visible textbox whose placeholder says it is the chat prompt (“Ask ChatGPT”).
    for (const el of document.querySelectorAll('[contenteditable="true"], textarea')) {
      if (isVisible(el) && PROMPT_PLACEHOLDER.test(placeholderOf(el)) && !el.closest('[data-writing-block], .writing-block')) return el;
    }
    return null;
  }

  /** What the page offers as text boxes, for the “composer not found” message (no text content). */
  function composerDiagnostics() {
    const boxes = Array.from(document.querySelectorAll('[contenteditable="true"], textarea')).slice(0, 5);
    if (!boxes.length) return 'no editable text box on the page';
    return boxes
      .map((el) => {
        const excluded = SELECTORS.composerExclusions.find((sel) => {
          try {
            return Boolean(el.closest(sel));
          } catch (e) {
            return false;
          }
        });
        const ph = placeholderOf(el).replace(/\s+/g, ' ').trim().slice(0, 30);
        return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''}${isVisible(el) ? '' : ' hidden'}${el.closest('form') ? ' in form' : ''}${composerFormOf(el) ? ' (composer form)' : ''}${excluded ? ` excluded by ${excluded}` : ''}${ph ? ` “${ph}”` : ''}`;
      })
      .join('; ');
  }

  function findButtonByText(patterns) {
    for (const btn of document.querySelectorAll('button')) {
      const text = (btn.innerText || btn.textContent || '').trim();
      if (text && patterns.some((re) => re.test(text)) && isVisible(btn)) return btn;
    }
    return null;
  }

  function findSendButton() {
    return qsAll(SELECTORS.sendButton).find((b) => isVisible(b)) || null;
  }

  function findStopButton() {
    return qsAll(SELECTORS.stopButton).find((b) => isVisible(b)) || null;
  }

  function bodyText() {
    return (document.body && document.body.innerText) || '';
  }

  function matchAny(patterns, text) {
    for (const re of patterns) {
      const m = text.match(re);
      if (m) return m;
    }
    return null;
  }

  /** Classify the page: ready | login | challenge | usage-limit | lost | offline | loading. */
  function pageState() {
    const text = bodyText();
    if (qs(SELECTORS.challenge) || (matchAny(TEXT.challenge, text) && !findComposer())) return { state: 'challenge' };
    const path = location.pathname || '/';
    if (/^\/(auth|login)/.test(path)) return { state: 'login' };
    const composer = findComposer();
    if (!composer && (qs(SELECTORS.loginButton) || findButtonByText(TEXT.login))) return { state: 'login' };
    if (matchAny(TEXT.lost, text)) return { state: 'lost' };
    const limit = limitInfo();
    if (limit) return { state: 'usage-limit', ...limit };
    if (navigator.onLine === false) return { state: 'offline' };
    if (composer) return { state: 'ready' };
    return { state: 'loading' };
  }

  /** Detect a usage-limit / 429 notice and parse when to retry (seconds). */
  function limitInfo() {
    const candidates = Array.from(document.querySelectorAll('[role="alert"], [data-testid*="limit"], [class*="limit"], [class*="error"], .text-token-text-error, main div'))
      .filter((el) => el.childElementCount < 6)
      .map((el) => (el.innerText || '').trim())
      .filter((t) => t.length > 0 && t.length < 400);
    for (const text of candidates) {
      if (!matchAny(TEXT.usageLimit, text)) continue;
      return { message: text.slice(0, 300), retryAfterSec: parseRetryAfter(text) };
    }
    return null;
  }

  function parseRetryAfter(text) {
    const mins = text.match(/(?:in|after|nach)\s+(\d{1,3})\s*(?:minutes?|mins?|minuten)/i);
    if (mins) return Number(mins[1]) * 60;
    const hours = text.match(/(?:in|after|nach)\s+(\d{1,2})\s*(?:hours?|stunden)/i);
    if (hours) return Number(hours[1]) * 3600;
    const clock = text.match(/(?:after|at|um|nach)\s+(\d{1,2}):(\d{2})\s*(am|pm)?/i);
    if (clock) {
      let h = Number(clock[1]);
      const m = Number(clock[2]);
      const ap = (clock[3] || '').toLowerCase();
      if (ap === 'pm' && h < 12) h += 12;
      if (ap === 'am' && h === 12) h = 0;
      const now = new Date();
      const target = new Date(now);
      target.setHours(h, m, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      return Math.round((target - now) / 1000);
    }
    return null;
  }

  /**
   * One element per turn, in page order. The selectors are alternatives, but one page can match several
   * (a turn <article data-turn="user"> around a <div data-message-author-role="user">): keep the innermost
   * match, otherwise every turn counts twice and indexes point at the wrong turn.
   */
  function turnElements(selectors) {
    const all = qsAll(selectors);
    return all
      .filter((el) => !all.some((other) => other !== el && el.contains(other)))
      .sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }

  function userMessages() {
    return turnElements(SELECTORS.userMessage);
  }

  function assistantMessages() {
    return turnElements(SELECTORS.assistantMessage);
  }

  function messageText(el) {
    const pre = el.querySelector('.whitespace-pre-wrap') || el;
    return (pre.innerText || pre.textContent || '').trim();
  }

  function normalizeForHash(text) {
    return String(text).replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
  }

  async function sha256Hex(text) {
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Looser text for comparing a prompt with how the page shows it: no whitespace at all, Unicode compatibility
   * forms (NBSP, full-width), and one form of quotes, dashes and ellipses.
   */
  function looseText(text) {
    return String(text)
      .normalize('NFKC')
      .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  const LOOSE_PREFIX = 200;

  /**
   * Does this user turn show this prompt? Exact: normalized SHA-256, or for very long prompts the same 300-char
   * prefix and length within 1%. With evidence — the app recorded that it sent this prompt — the page's own
   * rendering may differ: a loose match of the whole text, or (only for the newest user turn) the prompt's first
   * 200 loose characters, as when a long prompt is shown shortened or with extra UI text.
   */
  async function promptTurnMatch(el, promptHash, prompt, opts) {
    const text = normalizeForHash(messageText(el));
    if (!text) return null;
    if ((await sha256Hex(text)) === promptHash) return 'hash';
    const wanted = normalizeForHash(prompt);
    if (wanted.length > 2000 && text.slice(0, 300) === wanted.slice(0, 300) && Math.abs(text.length - wanted.length) / wanted.length < 0.01) return 'prefix';
    if (!(opts && opts.evidence)) return null;
    const loose = looseText(prompt);
    const shown = looseText(text);
    if (shown === loose) return 'loose';
    const k = Math.min(LOOSE_PREFIX, loose.length);
    if (opts.isLast && k > 0 && shown.length >= k && shown.slice(0, k) === loose.slice(0, k)) return 'last-turn-prefix';
    return null;
  }

  /** Find the user turn that is this prompt, newest first (see promptTurnMatch for what counts). */
  async function findSubmittedPrompt(promptHash, prompt, opts) {
    const users = userMessages();
    // Exact matches first (any turn), then the evidence-only loose rules.
    for (let i = users.length - 1; i >= 0; i--) {
      const match = await promptTurnMatch(users[i], promptHash, prompt, null);
      if (match) return { element: users[i], index: i, match };
    }
    if (!(opts && opts.evidence)) return null;
    for (let i = users.length - 1; i >= 0; i--) {
      const match = await promptTurnMatch(users[i], promptHash, prompt, { evidence: true, isLast: i === users.length - 1 });
      if (match) return { element: users[i], index: i, match };
    }
    return null;
  }

  /**
   * A stable key for a turn, independent of which turns the page currently renders (long conversations keep only
   * the last turns in the DOM, so positions shift): the search-unit key, the message id or the turn's test id.
   */
  function turnKey(el) {
    const holder = el.closest('[data-content-search-unit-key], [data-chatgpt-search-unit-key], [data-message-id], [data-testid^="conversation-turn"]');
    if (!holder) return null;
    return holder.getAttribute('data-content-search-unit-key') || holder.getAttribute('data-chatgpt-search-unit-key') || holder.getAttribute('data-message-id') || holder.getAttribute('data-testid');
  }

  /**
   * The user turn of a prompt this tab just sent: the newest turn showing the prompt that was not on the page before
   * sending (by turn key). Falls back to the newest new turn, then to the position counted before sending.
   */
  async function sentPromptTurn(promptHash, prompt, opts) {
    const users = userMessages();
    const isNew = (el) => {
      const key = turnKey(el);
      return !key || !opts.priorKeys || !opts.priorKeys.includes(key);
    };
    for (let i = users.length - 1; i >= 0; i--) {
      if (!isNew(users[i])) continue;
      if (await promptTurnMatch(users[i], promptHash, prompt, { evidence: true, isLast: i === users.length - 1 })) return users[i];
    }
    const newest = users[users.length - 1];
    if (newest && opts.priorKeys && turnKey(newest) && isNew(newest)) return newest;
    return users[opts.fallbackIndex] || null;
  }

  // ---------- Image-search gallery (celebrity photos, as in the owner's earlier tool) ----------

  /** Hosts whose pictures the background may read (they are in the manifest's host permissions). */
  function isPictureHost(url) {
    const u = typeof url === 'string' ? new URL(url, location.href) : url;
    if (u.protocol !== 'https:') return false;
    return u.hostname === 'chatgpt.com' || u.hostname === 'images.openai.com' || /(^|\.)oaiusercontent\.com$/.test(u.hostname) || /(^|\.)mm\.bing\.net$/.test(u.hostname) || u.hostname === 'oaidalleapiprodscus.blob.core.windows.net';
  }

  /** Picture thumbnails ChatGPT shows after this user turn (not avatars, icons, logos or the composer). */
  function galleryThumbs(userEl) {
    return Array.from(document.images).filter((img) => {
      const src = img.currentSrc || img.src || '';
      if (!/^(https?:|blob:)/.test(src)) return false;
      if (userEl && (userEl.contains(img) || !(userEl.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING))) return false;
      if (img.closest('form, nav, aside, [role="dialog"], [data-testid*="composer"]')) return false;
      const r = img.getBoundingClientRect();
      // Avatars, site icons and logos are small; a large picture is a photo even when its caption says “style icon”.
      if ((r.width < 120 || r.height < 120) && /avatar|favicon|logo|icon/i.test(`${img.alt || ''} ${src} ${img.className || ''}`)) return false;
      if (r.width >= 60 && r.height >= 60) return true;
      // Owner report: a picture the page could not load shows as a small broken-picture icon with its alt text, while
      // its address works (“Open image in new tab”). It is still a gallery picture: the app downloads it from there.
      return brokenPicture(img) && (img.alt || '').trim().length >= 3 && r.width > 0;
    });
  }

  function brokenPicture(img) {
    return img.complete && img.naturalWidth === 0 && /^https?:/i.test(img.currentSrc || img.src || '');
  }

  /**
   * The picture viewer. Owner report with a screen recording (Sira Martínez: 3 tiles with “10”, 3 photos used): ChatGPT
   * keeps other, hidden dialogs in its page, and its viewer is a full-screen layer. So: a dialog on screen with a large
   * picture; else the full-screen fixed layer around a large picture; else a dialog on screen.
   */
  function galleryDialog() {
    const shown = qsAll(['[role="dialog"]', '[aria-modal="true"]', 'dialog[open]']).filter(isVisible);
    const withPicture = shown.filter((d) => Array.from(d.querySelectorAll('img')).some((img) => isVisible(img) && img.getBoundingClientRect().width >= 200));
    return withPicture[withPicture.length - 1] || viewerLayer() || shown[shown.length - 1] || null;
  }

  /** A fixed layer covering most of the window around a large picture (a viewer that is not marked as a dialog). */
  function viewerLayer() {
    for (const img of Array.from(document.images)) {
      if (!isVisible(img) || img.getBoundingClientRect().width < 200) continue;
      for (let p = img.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).position !== 'fixed') continue;
        const b = p.getBoundingClientRect();
        if (b.width >= innerWidth * 0.6 && b.height >= innerHeight * 0.6) return p;
      }
    }
    return null;
  }

  /** The viewer's own count, e.g. “1 of 10” at the bottom of ChatGPT's viewer. */
  function viewerCounter(dialog) {
    const m = /(?:^|\s)(\d{1,3})\s*(?:of|von|\/)\s*(\d{1,3})(?:\s|$)/i.exec(dialog.innerText || '');
    const at = m ? Number(m[1]) : 0;
    const of = m ? Number(m[2]) : 0;
    return at >= 1 && of >= at && of <= 100 ? { at, of } : null;
  }

  /**
   * How many pictures the gallery says it has, when that is more than the tiles on the page. Owner report (3 tiles,
   * the third with a stacked-pictures icon and “5”): the count sits on the last tile; the others are only in the viewer.
   */
  function galleryCount(thumbs) {
    if (!thumbs.length) return null;
    let box = thumbs[0].parentElement;
    for (let up = 0; box && up < 4 && !thumbs.every((t) => box.contains(t)); up++) box = box.parentElement;
    if (!box) return null;
    let best = null;
    for (const el of box.querySelectorAll('span, div, p, button')) {
      const m = /^\+?\s*(\d{1,2})$/.exec((el.textContent || '').trim());
      if (!m || el.querySelector('img')) continue;
      // “+2” over the last tile: two more than the tiles; “5”: five in all.
      const n = (el.textContent || '').trim().startsWith('+') ? thumbs.length + Number(m[1]) : Number(m[1]);
      if (n > thumbs.length && (!best || n > best)) best = n;
    }
    return best;
  }

  /**
   * How much of an element is really on screen: the part inside the window and inside every parent that clips it,
   * times how opaque it is (a fading viewer stacks its pictures and shows one).
   */
  function shownArea(el) {
    const r = el.getBoundingClientRect();
    let left = Math.max(r.left, 0);
    let top = Math.max(r.top, 0);
    let right = Math.min(r.right, innerWidth);
    let bottom = Math.min(r.bottom, innerHeight);
    let opacity = 1;
    for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
      const style = getComputedStyle(p);
      opacity *= Number(style.opacity) || 0;
      if (p !== el && (style.overflowX !== 'visible' || style.overflowY !== 'visible')) {
        const q = p.getBoundingClientRect();
        left = Math.max(left, q.left);
        top = Math.max(top, q.top);
        right = Math.min(right, q.right);
        bottom = Math.min(bottom, q.bottom);
      }
      if (right <= left || bottom <= top || opacity < 0.1) return 0;
    }
    return (right - left) * (bottom - top) * opacity;
  }

  /**
   * The picture the viewer shows now: visible, loaded, the largest on screen. Owner report (3 thumbnails, “+10”): the
   * viewer keeps its other pictures in the page, hidden; taking the largest file there gave the same picture each time.
   * Owner report (ChatGPT showed about 6 photos, 2 were used): a viewer that slides its pictures side by side keeps the
   * others beside the window, so only the part really on screen counts.
   */
  function shownPicture(dialog) {
    let best = null;
    let bestArea = 0;
    for (const img of dialog.querySelectorAll('img')) {
      if (!img.complete || (img.naturalWidth || 0) < 200 || !isVisible(img)) continue;
      const area = shownArea(img);
      if (area > bestArea) {
        best = img;
        bestArea = area;
      }
    }
    return best;
  }

  function galleryNextButton(dialog) {
    const named = qs(['button[aria-label*="Next" i]', 'button[aria-label*="Weiter" i]', 'button[aria-label*="Nächste" i]', 'button[data-testid*="next" i]', 'button[title*="Next" i]', 'button[aria-label*="forward" i]'], dialog);
    if (named) return named;
    // Owner report (3 tiles with “5”, 3 photos used): a Next with no name — an icon-only button at the viewer's right
    // edge, halfway down (Close, Download and Share sit at the top and have names).
    const box = dialog.getBoundingClientRect();
    const left = Math.max(box.left, 0);
    const right = Math.min(box.right, innerWidth);
    const top = Math.max(box.top, 0);
    const bottom = Math.min(box.bottom, innerHeight);
    let best = null;
    for (const b of dialog.querySelectorAll('button, [role="button"]')) {
      if (!isVisible(b)) continue;
      const name = `${b.getAttribute('aria-label') || ''} ${b.getAttribute('title') || ''} ${b.textContent || ''}`;
      if (/[a-zäöü]{2,}/i.test(name)) continue;
      const r = b.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (r.width > 120 || r.height > 120 || cx < left + (right - left) * 0.75 || cy < top + (bottom - top) * 0.3 || cy > top + (bottom - top) * 0.7) continue;
      if (!best || cx > best.getBoundingClientRect().left) best = b;
    }
    return best;
  }

  /** The arrow keys of a viewer that has no Next button (as a person would press them). */
  function pressViewerKey(dialog, key) {
    const code = key === 'ArrowRight' ? 39 : 37;
    for (const type of ['keydown', 'keyup']) dialog.dispatchEvent(new KeyboardEvent(type, { key, code: key, keyCode: code, which: code, bubbles: true, cancelable: true }));
  }

  /**
   * A row of small pictures inside the viewer (each shows that picture large), in page order. At least three, and
   * never one that links to another site (it would open a new tab).
   */
  function viewerStrip(dialog) {
    const shown = shownPicture(dialog);
    const big = shown ? shown.getBoundingClientRect().width : 0;
    const strip = Array.from(dialog.querySelectorAll('img')).filter((img) => {
      if (img === shown || !isVisible(img)) return false;
      const r = img.getBoundingClientRect();
      if (r.width < 24 || r.height < 24 || (big && r.width > big * 0.5)) return false;
      const a = img.closest('a[href]');
      return !(a && new URL(a.href, location.href).origin !== location.origin);
    });
    return strip.length >= 3 ? strip : [];
  }

  function closeGalleryDialog() {
    const viewer = galleryDialog();
    const close = viewer && qs(['button[aria-label*="Close" i]', 'button[aria-label*="Schließen" i]'], viewer);
    if (close) close.click();
    else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  // Markers of the ChatGPT layouts this adapter knows, counted for the owner when nothing matches.
  const LAYOUT_MARKERS = {
    'data-message-author-role': '[data-message-author-role]',
    'conversation-turn': '[data-testid^="conversation-turn"]',
    'data-turn': '[data-turn]',
    'data-turn-key': '[data-turn-key]',
    'search-unit': '[data-content-search-unit-key], [data-chatgpt-search-unit-key]',
    'user-bubble': '[data-user-message-bubble]',
    'markdown-text-style': '[data-markdown-text-style]',
    'data-message-role': '[data-message-role]',
    article: 'main article',
  };

  function layoutMarkers() {
    const found = [];
    for (const [name, sel] of Object.entries(LAYOUT_MARKERS)) {
      const n = document.querySelectorAll(sel).length;
      if (n) found.push(`${name} ${n}`);
    }
    return found.length ? found.join(', ') : 'none of the known markers';
  }

  /** Where the prompt's first words sit in the page: tag and data-* attribute names of up to 8 ancestors (no text). */
  function promptLocation(prompt) {
    const needle = normalizeForHash(prompt).slice(0, 40);
    if (!needle) return null;
    const walker = document.createTreeWalker(document.querySelector('main') || document.body, NodeFilter.SHOW_TEXT);
    let node = null;
    while ((node = walker.nextNode())) if (normalizeForHash(node.textContent).includes(needle)) break;
    if (!node) return 'prompt text not on the page';
    const chain = [];
    for (let el = node.parentElement; el && chain.length < 8 && el !== document.body; el = el.parentElement) {
      const attrs = Array.from(el.attributes)
        .filter((a) => a.name.startsWith('data-') || a.name === 'role')
        .map((a) => (/^(data-turn|data-message-author-role|data-message-role|data-markdown-text-style|data-user-message-bubble|role)$/.test(a.name) ? `${a.name}=${a.value.slice(0, 20)}` : a.name));
      chain.push(el.tagName.toLowerCase() + (attrs.length ? `[${attrs.join(' ')}]` : ''));
    }
    return `prompt text in ${chain.join(' < ')}`;
  }

  /** Why no user turn matched (for the owner and Diagnostics): counts, lengths, the first difference, the layout. */
  function promptMismatchReport(prompt) {
    const users = userMessages();
    const parts = [`page ${location.pathname}`, `${users.length} user turn(s)`, `${assistantMessages().length} answer(s)`];
    if (users.length) {
      const shown = normalizeForHash(messageText(users[users.length - 1]));
      const wanted = normalizeForHash(prompt);
      let i = 0;
      while (i < shown.length && i < wanted.length && shown[i] === wanted[i]) i++;
      const cut = (t) => JSON.stringify(t.slice(i, i + 24));
      parts.push(`last user turn ${shown.length} chars vs prompt ${wanted.length}`);
      if (i < Math.max(shown.length, wanted.length)) parts.push(`first difference at char ${i}: page ${cut(shown)} vs prompt ${cut(wanted)}`);
    } else {
      parts.push(`markers: ${layoutMarkers()}`);
      const where = promptLocation(prompt);
      if (where) parts.push(where);
    }
    return parts.join('; ');
  }

  /** The next user turn after this one (where this prompt's answer ends), or null. */
  function nextUserAfter(userEl) {
    return userMessages().find((u) => u !== userEl && !u.contains(userEl) && !userEl.contains(u) && userEl.compareDocumentPosition(u) & Node.DOCUMENT_POSITION_FOLLOWING) || null;
  }

  /**
   * Is the element part of this prompt's answer: after the user turn and before the next one? Owner report: a
   * recovered image job took a later prompt's answer (another article's humanizer text) as its own, because
   * “the last answer after the prompt” was used.
   */
  function inAnswerOf(userEl, el) {
    if (!(userEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) || userEl.contains(el)) return false;
    const next = nextUserAfter(userEl);
    return !next || (Boolean(el.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING) && !el.contains(next));
  }

  /** Assistant turn(s) that answer the given user turn (after it, before the next user turn). */
  function assistantAfter(userEl) {
    return assistantMessages().filter((a) => inAnswerOf(userEl, a));
  }

  /** The final user-facing answer element of an assistant turn (skips reasoning/tool blocks). */
  function finalAnswerElement(assistantEl) {
    const blocks = qsAll(SELECTORS.markdown, assistantEl).filter((el) => !SELECTORS.nonAnswer.slice(0, 6).some((sel) => el.closest(sel)));
    const outer = blocks.filter((b) => !blocks.some((o) => o !== b && o.contains(b)));
    if (outer.length) return outer[outer.length - 1];
    return null;
  }

  /**
   * Pictures ChatGPT created in the answer to this user turn, one per address. As in the owner's earlier tool: any
   * picture in that answer counts when it has loaded at 700×350 or more (icons, avatars and previews are smaller),
   * besides the known generated-image addresses — the page's image markup changes.
   */
  function generatedImagesAfter(userEl) {
    const scope = document.querySelector('main') || document.body;
    const known = new Set(qsAll(SELECTORS.generatedImage, scope));
    const users = userMessages();
    const found = new Map();
    for (const img of scope.querySelectorAll('img')) {
      if (!inAnswerOf(userEl, img) || img.closest('form') || users.some((u) => u.contains(img))) continue;
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith('data:image/svg')) continue;
      const big = img.complete && img.naturalWidth >= 700 && img.naturalHeight >= 350;
      if (!known.has(img) && !big) continue;
      const prev = found.get(src);
      if (!prev || img.naturalWidth > prev.naturalWidth) found.set(src, img);
    }
    return [...found.values()];
  }

  /** ChatGPT is still drawing a picture for this prompt: a composer Stop button, or “Creating image” in its answer. */
  function imageInProgress(userEl) {
    if (document.querySelector('button[data-testid="stop-button"]')) return true;
    const form = (findComposer() && findComposer().closest('form')) || null;
    if (form && Array.from(form.querySelectorAll('button')).some((b) => isVisible(b) && /\bstop/i.test(`${b.getAttribute('data-testid') || ''} ${b.getAttribute('aria-label') || ''}`))) return true;
    const turns = qsAll(SELECTORS.turn).filter((t) => inAnswerOf(userEl, t));
    return turns.some((t) => /creating image|generating image|bild wird erstellt|image is being (created|generated)/i.test(t.innerText || ''));
  }

  function genericAnswerAfter(userEl) {
    const turns = qsAll(SELECTORS.turn).filter((t) => inAnswerOf(userEl, t));
    const last = turns[turns.length - 1];
    return last || null;
  }

  // ---------- HTML → Markdown (headings, paragraphs, lists, tables, emphasis, links) ----------

  /** True when the page shows this element's text newlines as line breaks (CSS white-space pre / pre-wrap / pre-line). */
  function keepsLineBreaks(el) {
    try {
      return Boolean(el) && /^(pre|pre-wrap|pre-line|break-spaces)$/.test(getComputedStyle(el).whiteSpace);
    } catch (e) {
      return false;
    }
  }

  function inlineMd(node) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        // The Chat/Work layout renders a paragraph's soft line breaks as newlines kept by CSS, not as <br>:
        // keep the lines the page shows ("QUESTION: …" / "ANSWER: …"), collapse other whitespace.
        out += keepsLineBreaks(child.parentElement) ? child.textContent.replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n') : child.textContent.replace(/\s+/g, ' ');
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child;
      if (SELECTORS.nonAnswer.slice(4).some((sel) => el.matches(sel))) continue;
      const tag = el.tagName.toLowerCase();
      const inner = inlineMd(el);
      if (tag === 'strong' || tag === 'b') out += inner.trim() ? `**${inner.trim()}**` : '';
      else if (tag === 'em' || tag === 'i') out += inner.trim() ? `*${inner.trim()}*` : '';
      else if (tag === 'code') out += `\`${el.textContent}\``;
      else if (tag === 'a') {
        const href = el.getAttribute('href') || '';
        out += /^https?:/i.test(href) ? `[${inner.trim()}](${href})` : inner;
      } else if (tag === 'br') out += '\n';
      else if (tag === 'sup' && /^\[?\d+\]?$/.test(el.textContent.trim())) continue;
      else out += inner;
    }
    return out;
  }

  function tableMd(table) {
    const rows = Array.from(table.querySelectorAll('tr')).map((tr) => Array.from(tr.children).map((c) => inlineMd(c).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()));
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r) => r.concat(Array(width - r.length).fill(''));
    const [head, ...body] = rows.map(pad);
    return [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...body.map((r) => `| ${r.join(' | ')} |`)].join('\n');
  }

  /** The “Writing” label ChatGPT shows above a writing block (owner report: it stood under every article's title). */
  function writingLabel(el) {
    return /^(?:writing|schreiben)$/i.test((el.textContent || '').trim()) && !el.querySelector('p, h1, h2, h3, li, table');
  }

  function blockMd(root, depth) {
    const parts = [];
    for (const child of root.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent.trim();
        if (t) parts.push(t);
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const el = child;
      if (SELECTORS.nonAnswer.some((sel) => el.matches(sel))) continue;
      const tag = el.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) parts.push(`${'#'.repeat(Number(tag[1]))} ${inlineMd(el).trim()}`);
      else if (tag === 'p') {
        const t = inlineMd(el).trim();
        if (t) parts.push(t);
      } else if (tag === 'ul' || tag === 'ol') {
        const items = Array.from(el.children).filter((li) => li.tagName.toLowerCase() === 'li');
        parts.push(
          items
            .map((li, i) => {
              const nested = Array.from(li.children).filter((c) => /^(ul|ol)$/i.test(c.tagName));
              const clone = li.cloneNode(true);
              clone.querySelectorAll('ul,ol').forEach((n) => n.remove());
              const line = `${'  '.repeat(depth)}${tag === 'ol' ? `${i + 1}.` : '-'} ${inlineMd(clone).trim()}`;
              return [line, ...nested.map((n) => blockMd({ childNodes: [n] }, depth + 1))].join('\n');
            })
            .join('\n'),
        );
      } else if (tag === 'table') parts.push(tableMd(el));
      else if (tag === 'pre') parts.push('```\n' + el.textContent.replace(/\n$/, '') + '\n```');
      else if (tag === 'blockquote') parts.push(blockMd(el, depth).split('\n').map((l) => `> ${l}`).join('\n'));
      else if (tag === 'hr') parts.push('---');
      else if (writingLabel(el)) continue;
      else if (tag === 'div' || tag === 'section' || tag === 'span' || tag === 'article') {
        const inner = blockMd(el, depth);
        if (inner.trim()) parts.push(inner);
      } else {
        const t = inlineMd(el).trim();
        if (t) parts.push(t);
      }
    }
    return parts.join('\n\n');
  }

  function toMarkdown(el) {
    return blockMd(el, 0)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ---------- Composer text entry ----------

  function composerText(composer) {
    if (composer.tagName === 'TEXTAREA') return composer.value;
    return composer.innerText || '';
  }

  function attachmentChips() {
    return qsAll(SELECTORS.attachmentChip).filter((el) => isVisible(el));
  }

  function pastedTextChips() {
    return attachmentChips().filter((el) => matchAny(TEXT.pastedText, el.innerText || ''));
  }

  function clearComposer(composer) {
    composer.focus();
    if (composer.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(composer, '');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
  }

  /**
   * Type the prompt as TEXT (never as a pasted file): paragraphs via
   * insertText + insertParagraph so long prompts are not converted into a
   * "Pasted text" attachment and Enter is never pressed.
   */
  function insertPrompt(composer, text) {
    composer.focus();
    if (composer.tagName === 'TEXTAREA') {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(composer, text);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    lines.forEach((line, i) => {
      if (i > 0) document.execCommand('insertParagraph', false);
      if (line) document.execCommand('insertText', false, line);
    });
  }

  /**
   * The composer holds the prompt. Whitespace-only differences count as a match: ChatGPT's composer puts a space
   * between “](” and a pasted address (owner report: “]( https://…”), which markdown reads the same way.
   */
  function composerMatches(composer, text) {
    const have = composerText(composer);
    if (normalizeForHash(have) === normalizeForHash(text)) return true;
    const strip = (s) => String(s).replace(/\s+/g, '');
    return strip(have) === strip(text);
  }

  /** Where the composer's text differs from the prompt, for the error message (owner report: “could not place”). */
  function composerMismatch(composer, text) {
    const want = normalizeForHash(text);
    const have = composer ? normalizeForHash(composerText(composer)) : '';
    let i = 0;
    while (i < want.length && i < have.length && want[i] === have[i]) i++;
    const cut = (s) => JSON.stringify(s.slice(Math.max(0, i - 20), i + 40));
    return `the composer showed ${have.length} of ${want.length} characters; first difference at character ${i}: expected ${cut(want)} but found ${cut(have)}`;
  }

  function isGenerating() {
    return Boolean(findStopButton()) || Boolean(document.querySelector('.result-streaming, [data-testid*="streaming"]'));
  }

  function snapshot(extra) {
    const composer = findComposer();
    const send = findSendButton();
    const answers = assistantMessages();
    const last = answers[answers.length - 1];
    let variant = 'generic';
    if (document.querySelector('[data-message-author-role]') || document.querySelector('#prompt-textarea')) variant = 'standard';
    else if (document.querySelector('article[data-turn]') || document.querySelector('main textarea')) variant = 'alternate';
    return Object.assign(
      {
        url: location.href,
        variant,
        title: document.title.slice(0, 80),
        state: pageState().state,
        composerFound: Boolean(composer),
        composerKind: composer ? (composer.tagName === 'TEXTAREA' ? 'textarea' : 'contenteditable') : null,
        composerLength: composer ? composerText(composer).length : 0,
        textBoxes: composerDiagnostics(),
        sendVisible: Boolean(send),
        sendEnabled: Boolean(send && !send.disabled && send.getAttribute('aria-disabled') !== 'true'),
        stopVisible: Boolean(findStopButton()),
        generating: isGenerating(),
        userTurns: userMessages().length,
        layoutMarkers: layoutMarkers(),
        assistantTurns: answers.length,
        lastAnswerLength: last ? (last.innerText || '').length : 0,
        attachmentChips: attachmentChips().length,
        continueVisible: Boolean(findButtonByText(TEXT.continue)),
      },
      extra || {},
    );
  }

  const api = {
    SELECTORS,
    TEXT,
    qs,
    qsAll,
    isVisible,
    findComposer,
    findSendButton,
    findStopButton,
    findContinueButton: () => findButtonByText(TEXT.continue),
    pageState,
    limitInfo,
    parseRetryAfter,
    userMessages,
    assistantMessages,
    messageText,
    normalizeForHash,
    sha256Hex,
    findSubmittedPrompt,
    sentPromptTurn,
    turnKey,
    isPictureHost,
    galleryThumbs,
    brokenPicture,
    galleryDialog,
    shownPicture,
    galleryNextButton,
    galleryCount,
    viewerCounter,
    pressViewerKey,
    viewerStrip,
    closeGalleryDialog,
    promptMismatchReport,
    looseText,
    assistantAfter,
    finalAnswerElement,
    genericAnswerAfter,
    generatedImagesAfter,
    composerDiagnostics,
    imageInProgress,
    toMarkdown,
    composerText,
    composerMismatch,
    clearComposer,
    insertPrompt,
    composerMatches,
    attachmentChips,
    pastedTextChips,
    isGenerating,
    snapshot,
    fileInput: () => qs(SELECTORS.fileInput),
  };
  globalThis.BASAdapter = api;
})();
