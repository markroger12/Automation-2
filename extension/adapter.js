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
    userMessage: ['[data-message-author-role="user"]', '[data-testid^="conversation-turn"][data-turn="user"]', 'article[data-turn="user"]'],
    assistantMessage: ['[data-message-author-role="assistant"]', '[data-testid^="conversation-turn"][data-turn="assistant"]', 'article[data-turn="assistant"]'],
    turn: ['[data-testid^="conversation-turn"]', 'article[data-turn]', 'main article'],
    markdown: ['.markdown', '[class*="markdown"]', '.prose'],
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

  function userMessages() {
    return qsAll(SELECTORS.userMessage);
  }

  function assistantMessages() {
    return qsAll(SELECTORS.assistantMessage);
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

  /** Find a user turn whose text is exactly this prompt (normalized SHA-256), newest first. */
  async function findSubmittedPrompt(promptHash, prompt) {
    const users = userMessages();
    for (let i = users.length - 1; i >= 0; i--) {
      const text = normalizeForHash(messageText(users[i]));
      if (!text) continue;
      if ((await sha256Hex(text)) === promptHash) return { element: users[i], index: i, match: 'hash' };
    }
    // Conservative fallback for very long prompts rendered with UI decorations:
    // same 300-char prefix and length within 1%.
    const wanted = normalizeForHash(prompt);
    for (let i = users.length - 1; i >= 0; i--) {
      const text = normalizeForHash(messageText(users[i]));
      if (wanted.length > 2000 && text.slice(0, 300) === wanted.slice(0, 300) && Math.abs(text.length - wanted.length) / wanted.length < 0.01) {
        return { element: users[i], index: i, match: 'prefix' };
      }
    }
    return null;
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
  function genericAnswerAfter(userEl) {
    const turns = qsAll(SELECTORS.turn).filter((t) => userEl.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING && !t.contains(userEl));
    const last = turns[turns.length - 1];
    return last || null;
  }

  // ---------- HTML → Markdown (headings, paragraphs, lists, tables, emphasis, links) ----------

  function inlineMd(node) {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        out += child.textContent.replace(/\s+/g, ' ');
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
    assistantAfter,
    finalAnswerElement,
    genericAnswerAfter,
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
