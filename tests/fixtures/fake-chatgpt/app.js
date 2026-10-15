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
        out.push(`<p>${inline(para.join(' '))}</p>`);
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
    const turnHtml = turns
      .map((t, i) => {
        if (t.role === 'user') {
          return std
            ? `<div data-testid="conversation-turn-${i}"><div data-message-author-role="user"><div class="whitespace-pre-wrap">${esc(t.text)}</div></div></div>`
            : `<article data-turn="user"><div class="whitespace-pre-wrap">${esc(t.text)}</div></article>`;
        }
        if (t.error) return `<div data-testid="conversation-turn-${i}"><div role="alert" class="text-token-text-error">${esc(t.error)}</div></div>`;
        const tool = t.tool ? `<div data-testid="tool-call-block">Searching the web for sources…</div><details><summary>Thought for 3s</summary><div class="markdown">Planning: I will search first.</div></details>` : '';
        const isLast = i === turns.length - 1;
        const img = t.image ? (isLast && window.__generating ? '<div class="image-placeholder">Creating image…</div>' : `<img alt="Generated image" src="${t.image}" width="1024" height="576">`) : '';
        const content = `${tool}${img}<div class="${std ? 'markdown prose' : 'prose'}">${md(t.text || '')}</div>`;
        return std
          ? `<div data-testid="conversation-turn-${i}"><div data-message-author-role="assistant">${content}</div></div>`
          : `<article data-turn="assistant">${content}</article>`;
      })
      .join('');
    const generating = Boolean(window.__generating);
    const composer =
      C.variant === 'broken'
        ? '<div class="nothing-here"></div>'
        : std
          ? `<div id="prompt-textarea" class="ProseMirror" contenteditable="true"></div>`
          : `<textarea placeholder="Message ChatGPT" rows="3"></textarea>`;
    const button = generating
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
    root.innerHTML = `<main><div class="thread">${turnHtml}</div>${cont}<form class="composer">${chips}${files}${composer}${button}</form></main>`;
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
    turns.push({ role: 'assistant', text: '', tool: C.mode === 'tool-preamble', target: full, pos: 0, image });
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
