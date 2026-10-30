/*
 * FAKE ChatGPT page for extension integration tests. NOT the real site.
 * Configured by window.__FAKE (injected by the test route handler).
 * Conversations persist in localStorage so reloads behave like the real app.
 */
(function () {
  'use strict';
  const C = Object.assign(
    {
      variant: 'standard', // standard | alternate | broken
      mode: 'normal', // normal | login | challenge | challenge-clears | usage-limit | late | multipart | tool-preamble
      answerDelayMs: 300,
      chunkMs: 40,
      chunkSize: 60,
      challengeClearsAfterMs: 4000,
      answers: null, // optional array of markdown answers (by send order)
    },
    window.__FAKE || {},
  );
  const S = {
    get convs() {
      return JSON.parse(localStorage.getItem('fake:convs') || '{}');
    },
    set convs(v) {
      localStorage.setItem('fake:convs', JSON.stringify(v));
    },
    get sends() {
      return Number(localStorage.getItem('fake:sends') || '0');
    },
    set sends(v) {
      localStorage.setItem('fake:sends', String(v));
    },
  };
  // Owner report (FINAL_ARTICLE after LONG_ARTICLE): the page stops working after an answer, until it is reloaded.
  window.__fakeStick = (kind, persists) => {
    window.__stuck = kind;
    if (persists) localStorage.setItem('fake:stuck', kind);
    render();
  };
  window.__fakeStats = () => ({ sends: S.sends, convs: S.convs, lastPrompt: localStorage.getItem('fake:lastPrompt'), lastFiles: localStorage.getItem('fake:lastFiles') });

  const std = C.variant === 'standard';
  const root = document.getElementById('root');

  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }
  function inline(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2">$1</a>');
  }
  function md(text) {
    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^#{2,3} /.test(line)) {
        const n = line.startsWith('###') ? 3 : 2;
        out.push(`<h${n}>${inline(line.replace(/^#+ /, ''))}</h${n}>`);
        i++;
      } else if (/^\|/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(rows[0]);
        const body = rows.slice(2).map(cells);
        out.push(`<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      } else if (/^- /.test(line)) {
        const items = [];
        while (i < lines.length && /^- /.test(lines[i])) items.push(lines[i++].slice(2));
        out.push(`<ul>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</ul>`);
      } else if (line.trim() === '') {
        i++;
      } else {
        const para = [];
        while (i < lines.length && lines[i].trim() && !/^(#{2,3} |\||- )/.test(lines[i])) para.push(lines[i++]);
        // softBreaks: a paragraph's single newlines stay newlines, shown by CSS (as reported for the Chat/Work layout).
        out.push(C.softBreaks ? `<p style="white-space:pre-wrap">${para.map(inline).join('\n')}</p>` : `<p>${inline(para.join(' '))}</p>`);
      }
    }
    return out.join('');
  }

  function answerFor(prompt, index) {
    if (Array.isArray(C.answers) && C.answers[index] !== undefined) return C.answers[index];
    const first = prompt.split('\n')[0].slice(0, 60);
    return `## Answer heading\n\nThis is the answer to: ${first}\n\n| Attribute | Details |\n| --- | --- |\n| Full Name | Example Person |\n| Profession | Writer |\n\nA **bold** final paragraph with a [link](https://example.org/page).`;
  }

  function convId() {
    const m = location.pathname.match(/^\/c\/([0-9a-f-]+)$/i);
    return m ? m[1] : null;
  }

  function render() {
    if (C.mode === 'login') {
      root.innerHTML = `<div class="login"><h1>Welcome back</h1><button data-testid="login-button">Log in</button><button>Sign up</button></div>`;
      return;
    }
    if (C.mode === 'challenge' || (C.mode === 'challenge-clears' && !window.__challengeCleared)) {
      document.title = 'Just a moment...';
      root.innerHTML = `<div id="challenge-stage"><p>Verify you are human by completing the action below.</p><iframe src="about:blank" title="challenge"></iframe></div>`;
      if (C.mode === 'challenge-clears') setTimeout(() => {
        window.__challengeCleared = true;
        document.title = 'ChatGPT';
        render();
      }, C.challengeClearsAfterMs);
      return;
    }
    const id = convId();
    const convs = S.convs;
    if (id && !convs[id]) {
      root.innerHTML = `<main><div class="error">Unable to load conversation ${esc(id)}</div></main>`;
      return;
    }
    const turns = id && !window.__historyHidden ? convs[id].turns : [];
    // virtualize: like a long real conversation, only the last N turns are in the DOM (indexes stay absolute).
    const first = C.virtualize ? Math.max(0, turns.length - C.virtualize) : 0;
    const turnHtml = turns
      .map((t, i) => {
        if (i < first) return '';
        if (t.role === 'user') {
          const shortened = C.userDisplay === 'short' && t.text.length > 300;
          const body = shortened ? `<div class="whitespace-pre-wrap">${esc(t.text.slice(0, 300))}…</div><button type="button">Show more</button>` : `<div class="whitespace-pre-wrap">${esc(t.text)}</div>`;
          if (C.turnMarkup === 'article') return `<article data-testid="conversation-turn-${i}" data-turn="user"><h5 class="sr-only">You said:</h5><div data-message-author-role="user">${body}</div></article>`;
          if (C.turnMarkup === 'units') {
            const bubble = shortened ? `${esc(t.text.slice(0, 300))}…` : esc(t.text);
            return `<div data-turn-key="turn-${i}"><div data-content-search-unit-key="${id}:${i}:user"><div class="flex"><div data-user-message-bubble="true" style="white-space:pre-wrap">${bubble}</div></div>${shortened ? '<button type="button">Show more</button>' : ''}</div></div>`;
          }
          return std
            ? `<div data-testid="conversation-turn-${i}"><div data-message-author-role="user">${body}</div></div>`
            : `<article data-turn="user">${body}</article>`;
        }
        if (t.error) return `<div data-testid="conversation-turn-${i}"><div role="alert" class="text-token-text-error">${esc(t.error)}</div></div>`;
        const tool = t.tool ? `<div data-testid="tool-call-block">Searching the web for sources…</div><details><summary>Thought for 3s</summary><div class="markdown">Planning: I will search first.</div></details>` : '';
        const isLast = i === turns.length - 1;
        // imageMarkup 'unknown': the picture's address and alt text match none of the known generated-image markers.
        const imgTag = C.imageMarkup === 'unknown' ? `<img alt="" src="${t.image ? t.image.replace('/backend-api/estuary/content?id=', '/backend-api/files/download?f=') : ''}">` : `<img alt="Generated image" src="${t.image}" width="1024" height="576">`;
        const img = t.image ? (isLast && window.__generating ? '<div class="image-placeholder">Creating image…</div>' : imgTag) : '';
        const doneStreaming = !(isLast && window.__generating);
        const gallery =
          t.gallery && doneStreaming
            ? `<div class="image-gallery">${Array.from({ length: Math.min(t.gallery, C.galleryShown || t.gallery) }, (_, k) => {
                const tile = `<img class="gal-thumb" data-k="${k}" src="/backend-api/estuary/content?id=gal_${k + 1}&thumb=1" width="160" height="90" alt="Photo ${k + 1}">`;
                const tiles = Math.min(t.gallery, C.galleryShown || t.gallery);
                // galleryBadge: the count over the last tile, as in the owner's screenshot (an icon and “5”).
                return C.galleryBadge && k === tiles - 1 && t.gallery > tiles
                  ? `<span class="gal-tile" style="position:relative;display:inline-block">${tile}<span class="gal-count" style="position:absolute;right:6px;bottom:6px;pointer-events:none"><svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="3" width="8" height="8"/></svg>${t.gallery}</span></span>`
                  : tile;
              }).join('')}${C.galleryShown && t.gallery > C.galleryShown && !C.galleryBadge ? `<span class="more">${t.gallery}</span>` : ''}${(t.galleryLinks || []).map((u) => `<img class="gal-link" src="${esc(u)}" width="160" height="90" alt="Linked photo">`).join('')}</div>`
            : '';
        // galleryBroken: captioned cards whose pictures the page cannot load (a broken-picture icon with its alt text).
        const cards =
          t.galleryBroken && t.galleryBroken.length && doneStreaming
            ? `<div class="grid" style="display:grid;grid-template-columns:1fr 1fr;gap:16px">${t.galleryBroken.map((u, k) => `<div><div style="width:470px;height:280px;display:flex;align-items:center;justify-content:center;background:#eee;border-radius:12px"><img src="${esc(u)}" alt="Photo ${k + 1} of the person"></div><div>${k + 1}. Photo ${k + 1}</div></div>`).join('')}</div>`
            : '';
        const content = `${tool}${img}<div class="${std ? 'markdown prose' : 'prose'}">${md(t.text || '')}</div>${gallery}${cards}`;
        if (C.turnMarkup === 'article') return `<article data-testid="conversation-turn-${i}" data-turn="assistant"><h6 class="sr-only">ChatGPT said:</h6><div data-message-author-role="assistant">${content}</div></article>`;
        if (C.turnMarkup === 'units') {
          // writingBlock: the answer inside ChatGPT's writing block, under its “Writing” label (owner report).
          const answerHtml = C.writingBlock ? `<div data-writing-block="true"><div class="wb-header"><span>Writing</span><button aria-label="Copy">⧉</button><button aria-label="Expand">⤢</button></div>${md(t.text || '')}</div>` : md(t.text || '');
          return `<div data-turn-key="turn-${i}"><div data-content-search-unit-key="${id}:${i}:assistant">${tool}${img}<div data-markdown-text-style="assistant-message">${answerHtml}</div>${gallery}${cards}<div class="turn-action-controls"><button aria-label="Copy">⧉</button></div></div></div>`;
        }
        return std
          ? `<div data-testid="conversation-turn-${i}"><div data-message-author-role="assistant">${content}</div></div>`
          : `<article data-turn="assistant">${content}</article>`;
      })
      .join('');
    const generating = Boolean(window.__generating);
    // Stuck page (set by a test with __fakeStick): 'composer' hides the composer, 'send' leaves a Stop button where
    // Send should be. A reload clears it unless it was made to persist.
    const stuck = window.__stuck || localStorage.getItem('fake:stuck');
    const composer =
      C.variant === 'broken'
        ? '<div class="nothing-here"></div>'
        : std
          ? `<div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>`
          : `<textarea placeholder="Message ChatGPT" rows="3"></textarea>`;
    const button = generating || stuck === 'send'
      ? std
        ? `<button data-testid="stop-button" aria-label="Stop streaming">■</button>`
        : `<button aria-label="Stop streaming">■</button>`
      : std
        ? `<button data-testid="send-button" id="composer-submit-button" aria-label="Send prompt">↑</button>`
        : `<button aria-label="Send prompt">↑</button>`;
    const cont = window.__canContinue && !generating ? `<button class="continue">Continue generating</button>` : '';
    const files = `<input type="file" multiple style="display:block">`;
    const chips = (window.__chips || []).map((n) => `<div data-testid="attachment-tile">${esc(n)}</div>`).join('');
    const keepDraft = document.querySelector('#prompt-textarea, textarea');
    const draft = keepDraft ? (keepDraft.tagName === 'TEXTAREA' ? keepDraft.value : keepDraft.innerHTML) : '';
    const dlg = window.__dlg;
    const dialog =
      dlg && dlg.count
        ? C.galleryViewer === 'strip'
          ? `<div role="dialog" class="viewer">${Array.from({ length: dlg.count }, (_, i) => `<img src="/backend-api/estuary/content?id=gal_${i + 1}" width="800" height="450" alt="Large photo ${i + 1}"${i === dlg.shown ? '' : ' style="display:none"'}>`).join('')}<button aria-label="Next" ${dlg.k >= dlg.count - 1 ? 'disabled' : ''}>›</button><button aria-label="Close">×</button></div>`
          : C.galleryViewer === 'carousel'
            ? `<div role="dialog" class="viewer"><div style="width:800px;height:450px;overflow:hidden"><div style="display:flex;width:${dlg.count * 800}px;transform:translateX(-${dlg.shown * 800}px)">${Array.from({ length: dlg.count }, (_, i) => `<img src="/backend-api/estuary/content?id=gal_${i + 1}" width="800" height="450" style="flex:none" alt="Large photo ${i + 1}">`).join('')}</div></div><button aria-label="Next" ${dlg.k >= dlg.count - 1 ? 'disabled' : ''}>›</button><button aria-label="Close">×</button></div>`
            : C.galleryViewer === 'fade'
              ? `<div role="dialog" class="viewer"><div style="position:relative;width:800px;height:450px">${Array.from({ length: dlg.count }, (_, i) => `<img src="/backend-api/estuary/content?id=gal_${i + 1}" width="800" height="450" style="position:absolute;left:0;top:0;opacity:${i === dlg.shown ? 1 : 0}" alt="Large photo ${i + 1}">`).join('')}</div><button aria-label="Next" ${dlg.k >= dlg.count - 1 ? 'disabled' : ''}>›</button><button aria-label="Close">×</button></div>`
              : C.galleryViewer === 'lightbox' || C.galleryViewer === 'keys'
              ? `<div role="dialog" class="viewer"><img src="/backend-api/estuary/content?id=gal_${dlg.k + 1}" width="800" height="450" alt="Large photo ${dlg.k + 1}"><button aria-label="Close">×</button></div>`
              : C.galleryViewer === 'arrows'
              ? `<div role="dialog" class="viewer" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#000c"><button class="gal-prev" style="position:absolute;left:16px;top:50%"><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="M13 4 7 10l6 6"/></svg></button><img src="/backend-api/estuary/content?id=gal_${dlg.k + 1}" width="800" height="450" alt="Large photo ${dlg.k + 1}"><button class="gal-next" style="position:absolute;right:16px;top:50%"><svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4 6 6-6 6"/></svg></button><button aria-label="Close" style="position:absolute;right:16px;top:16px">×</button></div>`
              : C.galleryViewer === 'overlay'
              ? `<div class="viewer-overlay" style="position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:50"><div style="position:absolute;top:12px;left:12px;right:12px;display:flex;justify-content:space-between"><button>Image ▾</button><span><button>74%</button> <button aria-label="Download"><svg width="16" height="16" aria-hidden="true"><path d="M8 2v9"/></svg></button> <button aria-label="Close">×</button></span></div>${dlg.k > 0 ? `<button class="ov-prev" style="position:absolute;left:12px;top:50%;width:36px;height:36px;border-radius:50%"><svg width="16" height="16" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg></button>` : ''}${dlg.loading ? '' : `<img src="/backend-api/estuary/content?id=gal_${dlg.k + 1}" alt="" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:800px;height:450px">`}<button class="ov-next" style="position:absolute;right:12px;top:50%;width:36px;height:36px;border-radius:50%"><svg width="16" height="16" aria-hidden="true"><path d="m6 3 5 5-5 5"/></svg></button><div style="position:absolute;bottom:16px;left:0;right:0;text-align:center;color:#fff"><span>${dlg.k + 1} of ${dlg.count}</span> <a href="https://news.example/story-${dlg.k + 1}" target="_blank" rel="noreferrer">news.example · Story ${dlg.k + 1}</a></div></div>`
              : C.galleryViewer === 'filmstrip'
              ? `<div role="dialog" class="viewer"><img src="/backend-api/estuary/content?id=gal_${dlg.k + 1}" width="800" height="450" alt="Large photo ${dlg.k + 1}"><div class="film">${Array.from({ length: dlg.count }, (_, i) => `<img class="film-thumb" data-k="${i}" src="/backend-api/estuary/content?id=gal_${i + 1}&thumb=1" width="80" height="45" alt="">`).join('')}</div><button aria-label="Close">×</button></div>`
              : `<div role="dialog" class="viewer"><img src="/backend-api/estuary/content?id=gal_${dlg.k + 1}" width="800" height="450" alt="Large photo ${dlg.k + 1}"><button aria-label="Next" ${dlg.k >= dlg.count - 1 ? 'disabled' : ''}>›</button><button aria-label="Close">×</button></div>`
        : '';
    // staleStreaming: a page-wide “streaming” marker that stays after the picture is finished (owner report).
    const stale = C.staleStreaming ? '<div data-testid="image-gen-streaming-status" hidden></div>' : '';
    // workLayout: the conversation shown in a “Work”/canvas layout — the whole page sits in a canvas-classed container
    // (suspected for the owner's “Chat composer not found” after the long article).
    const hiddenDialog = C.galleryViewer === 'overlay' ? '<div role="dialog" aria-label="Search chats" style="display:none"><img src="/backend-api/estuary/content?id=gal_1" alt=""></div>' : '';
    const page = `${hiddenDialog}<main><div class="thread">${turnHtml}</div>${cont}<form class="composer"${stuck === 'composer' ? ' style="display:none"' : ''}>${chips}${files}${composer}${button}</form>${stale}</main>${dialog}`;
    root.innerHTML = C.workLayout ? `<div class="work-canvas-layout bg-token-canvas">${page}</div>` : page;
    const ed = document.querySelector('#prompt-textarea, textarea');
    if (ed && draft && !generating) {
      if (ed.tagName === 'TEXTAREA') ed.value = draft;
      else ed.innerHTML = draft;
    }
    wire();
  }

  function composerText() {
    const ed = document.querySelector('#prompt-textarea, textarea');
    if (!ed) return '';
    return ed.tagName === 'TEXTAREA' ? ed.value : ed.innerText;
  }

  // Gallery viewer: a thumbnail opens it, Next steps through the pictures, Close / Escape closes it.
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const thumb = t.closest('.gal-thumb');
    if (thumb) {
      const imgs = document.querySelectorAll('.gal-thumb');
      const k = Number(thumb.getAttribute('data-k'));
      window.__dlg = { k, shown: k, count: C.galleryShown ? C.galleryCount : imgs.length };
      window.__galleryOpened = (window.__galleryOpened || 0) + 1;
      render();
      return;
    }
    // 'overlay': the next picture loads for a moment (nothing shown meanwhile), then shows; at the end it comes round.
    if (t.closest('.viewer-overlay .ov-next, .viewer-overlay .ov-prev') && window.__dlg) {
      const step = t.closest('.ov-next') ? 1 : -1;
      window.__dlg = { ...window.__dlg, k: (window.__dlg.k + step + window.__dlg.count) % window.__dlg.count, loading: true };
      window.__dlg.shown = window.__dlg.k;
      render();
      setTimeout(() => {
        if (!window.__dlg) return;
        window.__dlg = { ...window.__dlg, loading: false };
        render();
      }, 900);
      return;
    }
    if (t.closest('.viewer-overlay button[aria-label="Close"]')) {
      window.__dlg = null;
      render();
      return;
    }
    // 'arrows': icon-only Previous/Next; 'filmstrip': a small picture in the viewer shows that one.
    if (t.closest('[role="dialog"] .gal-next, [role="dialog"] .gal-prev') && window.__dlg) {
      const step = t.closest('.gal-next') ? 1 : -1;
      window.__dlg = { ...window.__dlg, k: (window.__dlg.k + step + window.__dlg.count) % window.__dlg.count };
      window.__dlg.shown = window.__dlg.k;
      render();
      return;
    }
    if (t.closest('[role="dialog"] .film-thumb') && window.__dlg) {
      const k = Number(t.closest('.film-thumb').getAttribute('data-k'));
      window.__dlg = { ...window.__dlg, k, shown: k };
      render();
      return;
    }
    if (t.closest('[role="dialog"] button[aria-label="Next"]') && window.__dlg) {
      window.__dlg = { ...window.__dlg, k: Math.min(window.__dlg.count - 1, window.__dlg.k + 1) };
      // 'strip' and 'carousel': the picture shown changes a moment after the click (a slide), the old one stays
      // visible meanwhile.
      if (C.galleryViewer === 'strip' || C.galleryViewer === 'carousel' || C.galleryViewer === 'fade') {
        setTimeout(() => {
          if (!window.__dlg) return;
          window.__dlg = { ...window.__dlg, shown: window.__dlg.k };
          render();
        }, 700);
      } else window.__dlg = { ...window.__dlg, shown: window.__dlg.k };
      render();
      return;
    }
    if (t.closest('[role="dialog"] button[aria-label="Close"]')) {
      window.__dlg = null;
      render();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && window.__dlg) {
      window.__dlg = null;
      render();
    }
    // 'keys' (and 'arrows'): the arrow keys step through the viewer, coming back round at the end.
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && window.__dlg && (C.galleryViewer === 'keys' || C.galleryViewer === 'arrows')) {
      const step = e.key === 'ArrowRight' ? 1 : -1;
      window.__dlg = { ...window.__dlg, k: (window.__dlg.k + step + window.__dlg.count) % window.__dlg.count };
      window.__dlg.shown = window.__dlg.k;
      render();
    }
  });

  function wire() {
    const send = document.querySelector('[data-testid="send-button"], button[aria-label="Send prompt"]');
    if (send) send.addEventListener('click', onSend);
    const cont = document.querySelector('button.continue');
    if (cont) cont.addEventListener('click', onContinue);
    const input = document.querySelector('input[type=file]');
    if (input) input.addEventListener('change', () => {
      window.__chips = Array.from(input.files).map((f) => f.name);
      localStorage.setItem('fake:lastFiles', JSON.stringify(Array.from(input.files).map((f) => ({ name: f.name, size: f.size, type: f.type }))));
      render();
    });
    const ed = document.querySelector('#prompt-textarea');
    if (ed && C.markdownLinks) {
      ed.addEventListener('input', () => {
        const html = ed.innerHTML;
        const next = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>');
        if (next === html) return;
        ed.innerHTML = next;
        // Keep typing at the end, like the editor's caret after an input rule.
        const range = document.createRange();
        range.selectNodeContents(ed);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
    }
    if (ed && C.linkParenSpace) {
      // Like the real composer (owner report): a space appears between “](” and an address typed after it.
      ed.addEventListener('input', () => {
        const walker = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
        let node;
        let changed = false;
        while ((node = walker.nextNode())) {
          if (/\]\(https?:/.test(node.textContent)) {
            node.textContent = node.textContent.replace(/\]\((https?:)/g, ']( $1');
            changed = true;
          }
        }
        if (!changed) return;
        const range = document.createRange();
        range.selectNodeContents(ed);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
    }
    if (ed) ed.addEventListener('paste', (e) => {
      const text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (text && text.length > 4000) {
        e.preventDefault();
        window.__chips = (window.__chips || []).concat(['Pasted text']);
        render();
      }
    });
  }

  function save(id, turns) {
    const convs = S.convs;
    convs[id] = { turns };
    S.convs = convs;
  }

  function onSend(e) {
    e.preventDefault();
    const text = composerText().replace(/ /g, ' ');
    if (!text.trim() && !(window.__chips || []).length) return;
    S.sends = S.sends + 1;
    localStorage.setItem('fake:lastPrompt', text);
    let id = convId();
    if (!id) {
      id = crypto.randomUUID();
      history.pushState({}, '', `/c/${id}`);
    }
    const turns = (S.convs[id] && S.convs[id].turns) || [];
    turns.push({ role: 'user', text });
    window.__chips = [];
    const ed = document.querySelector('#prompt-textarea, textarea');
    if (ed) {
      if (ed.tagName === 'TEXTAREA') ed.value = '';
      else ed.innerHTML = '';
    }
    if (C.mode === 'usage-limit') {
      turns.push({ role: 'assistant', error: "You've reached our limit of messages per hour. Please try again after 11:55 PM." });
      save(id, turns);
      render();
      return;
    }
    const index = turns.filter((t) => t.role === 'user').length - 1;
    let full = answerFor(text, S.sends - 1 + index * 0);
    // "IMAGE:" answers simulate image generation: a placeholder while generating, then the image.
    let image = null;
    if (full.startsWith('IMAGE:')) {
      image = `/backend-api/estuary/content?id=file_${S.sends}&sig=test`;
      full = full.slice(6).trim();
    }
    const galleryAnswer = (C.galleryCount || C.galleryBroken) && /image gallery/i.test(text);
    if (galleryAnswer) full = 'Here are recent photos.';
    turns.push({ role: 'assistant', text: '', tool: C.mode === 'tool-preamble', target: full, pos: 0, image, gallery: galleryAnswer ? C.galleryCount || 0 : 0, galleryLinks: galleryAnswer ? C.galleryLinks || [] : [], galleryBroken: galleryAnswer ? C.galleryBroken || [] : [] });
    save(id, turns);
    window.__generating = true;
    render();
    const delay = C.mode === 'late' ? 6000 : C.answerDelayMs;
    setTimeout(() => stream(id), delay);
  }

  function stream(id) {
    const convs = S.convs;
    const turns = convs[id].turns;
    const t = turns[turns.length - 1];
    const stopAt = C.mode === 'multipart' && !t.continued ? Math.floor(t.target.length / 2) : t.target.length;
    if (t.pos < stopAt) {
      t.pos = Math.min(stopAt, t.pos + C.chunkSize);
      t.text = t.target.slice(0, t.pos);
      save(id, turns);
      window.__generating = true;
      render();
      setTimeout(() => stream(id), C.chunkMs);
      return;
    }
    window.__generating = false;
    window.__canContinue = t.pos < t.target.length;
    render();
  }

  function onContinue() {
    const id = convId();
    const convs = S.convs;
    const turns = convs[id].turns;
    turns[turns.length - 1].continued = true;
    save(id, turns);
    window.__canContinue = false;
    window.__generating = true;
    render();
    setTimeout(() => stream(id), 200);
  }

  // Like the real app: the composer is ready before a loaded conversation's turns are rendered.
  if (C.historyDelayMs && convId()) {
    window.__historyHidden = true;
    setTimeout(() => {
      window.__historyHidden = false;
      render();
    }, C.historyDelayMs);
  }

  // After a reload mid-generation the "server" keeps generating (like the real app).
  const id = convId();
  if (id && S.convs[id]) {
    const turns = S.convs[id].turns;
    const last = turns[turns.length - 1];
    if (last && last.role === 'assistant' && last.target && last.pos < last.target.length && !(C.mode === 'multipart' && !last.continued && last.pos >= Math.floor(last.target.length / 2))) {
      window.__generating = true;
      setTimeout(() => stream(id), 300);
    }
  }
  window.addEventListener('popstate', render);
  render();
})();
