'use strict';
/**
 * The window's everyday behaviour, as in other desktop programs (owner request 2026-11-12: “professional, smooth,
 * advanced and user friendly”): a right-click menu, the window's size and place remembered, and the keyboard
 * shortcuts. Plain functions, so they are tested without Electron (tests/unit/desktop-ux.test.ts).
 */

/** The keyboard shortcuts, as the Help menu lists them (main.cjs uses the same accelerators). */
const SHORTCUTS = [
  ['Ctrl+1', 'Dashboard'],
  ['Ctrl+2', 'ChatGPT'],
  ['Ctrl+3', 'Search Console'],
  ['Ctrl+K', 'Search pages and actions (in the dashboard)'],
  ['Ctrl+R', 'Reload the page shown'],
  ['Ctrl+Plus / Ctrl+Minus / Ctrl+0', 'Zoom in / out / reset (the page shown)'],
  ['F11', 'Full screen'],
  ['Ctrl+Q', 'Quit (the work stops safely first)'],
];

/**
 * The right-click menu of a page (Electron's `context-menu` params): Cut, Copy, Paste in a text box, Copy for a
 * selection, the link's address, and Open in browser for a website link. Without a word to offer: no menu.
 * @param {object} p  Electron's context-menu params (isEditable, selectionText, linkURL, editFlags)
 * @param {{ openExternal: (url: string) => void, copyText: (text: string) => void }} act
 */
function contextMenuTemplate(p, act) {
  const items = [];
  const flags = p.editFlags || {};
  const selected = String(p.selectionText || '').trim();
  if (p.isEditable) {
    items.push(
      { role: 'undo', enabled: Boolean(flags.canUndo) },
      { role: 'redo', enabled: Boolean(flags.canRedo) },
      { type: 'separator' },
      { role: 'cut', enabled: Boolean(flags.canCut) },
      { role: 'copy', enabled: Boolean(flags.canCopy) },
      { role: 'paste', enabled: Boolean(flags.canPaste) },
      { type: 'separator' },
      { role: 'selectAll', enabled: Boolean(flags.canSelectAll) },
    );
  } else if (selected) {
    items.push({ role: 'copy' });
  }
  const link = String(p.linkURL || '');
  if (/^https?:\/\//i.test(link)) {
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: 'Copy link address', click: () => act.copyText(link) });
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(link)) items.push({ label: 'Open link in browser', click: () => act.openExternal(link) });
  }
  return items;
}

/**
 * The window's last size and place, if it still fits on a screen of this computer (a screen may have been
 * unplugged): at least 200 × 120 pixels of it on one screen's work area. Else null (the default size, centred).
 * @param {{x:number,y:number,width:number,height:number,maximized?:boolean}|undefined} saved
 * @param {{workArea:{x:number,y:number,width:number,height:number}}[]} displays
 */
function restoreBounds(saved, displays, min = { width: 1024, height: 640 }) {
  if (!saved || ![saved.x, saved.y, saved.width, saved.height].every(Number.isFinite)) return null;
  const width = Math.max(min.width, Math.round(saved.width));
  const height = Math.max(min.height, Math.round(saved.height));
  const x = Math.round(saved.x);
  const y = Math.round(saved.y);
  const visible = displays.some(({ workArea: a }) => {
    const w = Math.min(x + width, a.x + a.width) - Math.max(x, a.x);
    const h = Math.min(y + height, a.y + a.height) - Math.max(y, a.y);
    return w >= 200 && h >= 120;
  });
  return visible ? { x, y, width, height, maximized: Boolean(saved.maximized) } : null;
}

/** Calls `fn` once `ms` after the last call (the window's size is saved once the owner stops dragging). */
function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

/** “What's new”: the version the app ran last time, when this start is the first of a newer one; else null. */
function updatedFrom(lastVersion, version) {
  if (!lastVersion || lastVersion === version) return null;
  const parts = (v) => String(v).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [a, b] = [parts(lastVersion), parts(version)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((b[i] || 0) > (a[i] || 0)) return lastVersion;
    if ((b[i] || 0) < (a[i] || 0)) return null;
  }
  return null;
}

module.exports = { SHORTCUTS, contextMenuTemplate, restoreBounds, debounce, updatedFrom };
