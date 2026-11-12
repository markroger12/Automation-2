/*
 * Blog Automation Studio — page structure copy (owner request: “save the page's structure when photos are missing, so
 * the real page can be fixed instead of guessed”). An outline of elements only: tag, role, button names, a few
 * attributes, sizes and positions, and picture sizes. Never the text of a chat or page: an element with text says only
 * how many characters it has. Used by content.js (gallery viewer) and gsc.js (Search Console dialog).
 */
'use strict';

(() => {
  if (globalThis.BASOutline) return;

  const MAX_NODES = 350;
  const MAX_DEPTH = 24;
  // Drawing parts of an icon tell nothing about the page: the <svg> itself is kept.
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'PATH', 'G', 'CIRCLE', 'RECT', 'LINE', 'POLYLINE', 'POLYGON', 'ELLIPSE', 'DEFS', 'USE', 'CLIPPATH', 'MASK', 'LINEARGRADIENT', 'RADIALGRADIENT', 'STOP']);

  const cut = (s, n) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };

  /** A picture's address without its query (signed links) and only the end of a long path. */
  function pictureAddress(src) {
    if (!src) return null;
    if (src.startsWith('data:')) return `data:${src.slice(5, src.indexOf(';') > 0 ? src.indexOf(';') : 20)}`;
    if (src.startsWith('blob:')) return 'blob:';
    try {
      const u = new URL(src, location.href);
      const tail = u.pathname.length > 40 ? `…${u.pathname.slice(-40)}` : u.pathname;
      return `${u.host}${tail}`;
    } catch (e) {
      return cut(src, 40);
    }
  }

  /** The name of a button or link as people see it: its label, title, or its own short text (button labels only). */
  function controlName(el) {
    const label = el.getAttribute('aria-label') || el.getAttribute('title');
    if (label) return cut(label, 60);
    if (el.matches('button, [role="button"]')) {
      const text = (el.innerText || '').trim();
      if (text && text.length <= 24) return text;
    }
    return null;
  }

  function ownTextLength(el) {
    let n = 0;
    for (const node of el.childNodes) if (node.nodeType === 3) n += node.textContent.trim().length;
    return n;
  }

  function describe(el, depth) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const d = { d: depth, tag: el.tagName.toLowerCase() };
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 4).join(' ') : '';
    if (el.id) d.id = cut(el.id, 40);
    if (cls) d.class = cut(cls, 80);
    for (const a of ['role', 'data-testid', 'aria-modal', 'aria-hidden', 'aria-disabled', 'aria-current', 'aria-selected', 'aria-pressed', 'tabindex', 'type', 'data-state', 'aria-roledescription']) {
      const v = el.getAttribute(a);
      if (v !== null) d[a] = cut(v, 40);
    }
    // Buttons only: a link's name or address can be a chat's title or address.
    if (el.matches('button, [role="button"], [role="tab"], [role="option"]')) {
      const name = controlName(el);
      if (name) d.name = name;
      if (el.disabled) d.disabled = true;
    }
    if (el.tagName === 'A') {
      try {
        d.href = new URL(el.getAttribute('href') || '', location.href).host;
      } catch (e) {
        d.href = '?';
      }
    }
    if (el.tagName === 'IMG') {
      d.src = pictureAddress(el.currentSrc || el.src);
      d.natural = `${el.naturalWidth}x${el.naturalHeight}`;
      d.complete = el.complete;
      if (el.alt) d.alt = cut(el.alt, 60);
    }
    d.box = `${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) d.hidden = `${cs.display}/${cs.visibility}/${cs.opacity}`;
    if (cs.position === 'fixed' || cs.position === 'absolute') d.pos = cs.position;
    if (cs.zIndex !== 'auto') d.z = cs.zIndex;
    if (cs.transform && cs.transform !== 'none') d.transform = cut(cs.transform, 60);
    if (el.tagName === 'DIALOG') d.open = el.open;
    const text = ownTextLength(el);
    if (text) d.textChars = text;
    return d;
  }

  /** The outline of one element and what is inside it (at most MAX_NODES elements). */
  function outline(root, max = MAX_NODES) {
    const out = [];
    if (!root) return out;
    const walk = (el, depth) => {
      if (out.length >= max || depth > MAX_DEPTH || SKIP.has(el.tagName.toUpperCase())) return;
      out.push(describe(el, depth));
      for (const child of el.children) walk(child, depth + 1);
    };
    walk(root, 0);
    if (out.length >= max) out.push({ more: 'cut here (too many elements)' });
    return out;
  }

  /** Layers over the page: dialogs and elements fixed on top (where a viewer or dialog lives when it is not found). */
  function overlays() {
    const found = [];
    for (const el of document.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"], body > *, [data-radix-portal], [data-headlessui-portal]')) {
      if (found.includes(el) || found.some((f) => f.contains(el))) continue;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const layer = el.matches('dialog, [role="dialog"], [aria-modal="true"]') || ((cs.position === 'fixed' || cs.position === 'absolute') && r.width > 200 && r.height > 150);
      if (layer) found.push(el);
      if (found.length >= 6) break;
    }
    return found.map((el) => outline(el, 160));
  }

  globalThis.BASOutline = { outline, overlays, pictureAddress };
})();
