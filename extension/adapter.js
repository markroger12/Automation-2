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

  function findComposer() {
    for (const el of qsAll(SELECTORS.composer)) {
      if (isVisible(el) && !insideExcluded(el)) return el;
    }
    return null;
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

  /** Assistant turn(s) that come after the given user turn in document order. */
  function assistantAfter(userEl) {
    return assistantMessages().filter((a) => userEl.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
  }

  /** The final user-facing answer element of an assistant turn (skips reasoning/tool blocks). */
  function finalAnswerElement(assistantEl) {
    const blocks = qsAll(SELECTORS.markdown, assistantEl).filter((el) => !SELECTORS.nonAnswer.slice(0, 6).some((sel) => el.closest(sel)));
    const outer = blocks.filter((b) => !blocks.some((o) => o !== b && o.contains(b)));
    if (outer.length) return outer[outer.length - 1];
    return null;
  }

  /** Generic fallback: the page's own visible conversation representation (last turn after the user turn). */
  /** Generated images in the answer(s) after a user turn, de-duplicated by URL. */
  function generatedImagesAfter(userEl) {
    const scopes = assistantAfter(userEl);
    if (!scopes.length) {
      const generic = genericAnswerAfter(userEl);
      if (generic) scopes.push(generic);
    }
    const seen = new Set();
    const out = [];
    for (const scope of scopes) {
      for (const img of qsAll(SELECTORS.generatedImage, scope)) {
        const src = img.currentSrc || img.src;
        if (!src || seen.has(src)) continue;
        seen.add(src);
        out.push(img);
      }
    }
    return out;
  }

  function genericAnswerAfter(userEl) {
    const turns = qsAll(SELECTORS.turn).filter((t) => userEl.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING && !t.contains(userEl));
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

  function composerMatches(composer, text) {
    return normalizeForHash(composerText(composer)) === normalizeForHash(text);
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
    promptMismatchReport,
    looseText,
    assistantAfter,
    finalAnswerElement,
    genericAnswerAfter,
    generatedImagesAfter,
    toMarkdown,
    composerText,
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
