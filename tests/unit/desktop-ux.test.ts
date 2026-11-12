import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { contextMenuTemplate, restoreBounds, debounce, updatedFrom, SHORTCUTS } = require('../../desktop/ux.cjs');

type Item = { role?: string; label?: string; type?: string; enabled?: boolean; click?: () => void };
const names = (items: Item[]) => items.map((i) => i.role || i.label || i.type);
const act = () => ({ openExternal: vi.fn(), copyText: vi.fn() });

describe('the right-click menu', () => {
  it('a text box: undo, redo, cut, copy, paste, select all (each only when it can)', () => {
    const items: Item[] = contextMenuTemplate({ isEditable: true, selectionText: '', editFlags: { canPaste: true, canSelectAll: true } }, act());
    expect(names(items)).toEqual(['undo', 'redo', 'separator', 'cut', 'copy', 'paste', 'separator', 'selectAll']);
    expect(items.find((i) => i.role === 'paste')?.enabled).toBe(true);
    expect(items.find((i) => i.role === 'cut')?.enabled).toBe(false);
  });

  it('selected text: Copy; nothing selected and no link: no menu', () => {
    expect(names(contextMenuTemplate({ isEditable: false, selectionText: 'Hello' }, act()))).toEqual(['copy']);
    expect(contextMenuTemplate({ isEditable: false, selectionText: '   ' }, act())).toEqual([]);
  });

  it('a website link: copy its address and open it in the browser; a dashboard link: only copy', () => {
    const a = act();
    const items: Item[] = contextMenuTemplate({ isEditable: false, selectionText: '', linkURL: 'https://example.com/post' }, a);
    expect(names(items)).toEqual(['Copy link address', 'Open link in browser']);
    items[1].click?.();
    expect(a.openExternal).toHaveBeenCalledWith('https://example.com/post');
    items[0].click?.();
    expect(a.copyText).toHaveBeenCalledWith('https://example.com/post');
    expect(names(contextMenuTemplate({ isEditable: false, linkURL: 'http://localhost:3000/articles/1' }, act()))).toEqual(['Copy link address']);
    // Never a menu item for other schemes.
    expect(contextMenuTemplate({ isEditable: false, linkURL: 'javascript:alert(1)' }, act())).toEqual([]);
  });
});

describe("the window's size and place", () => {
  const screens = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];

  it('comes back where it was, and maximized if it was', () => {
    expect(restoreBounds({ x: 100, y: 80, width: 1500, height: 900, maximized: true }, screens)).toEqual({ x: 100, y: 80, width: 1500, height: 900, maximized: true });
  });

  it('never smaller than the minimum', () => {
    expect(restoreBounds({ x: 0, y: 0, width: 300, height: 200 }, screens)).toMatchObject({ width: 1024, height: 640 });
  });

  it('a place on a screen that is gone (or nothing saved): the default size, centred', () => {
    expect(restoreBounds({ x: 2500, y: 100, width: 1400, height: 900 }, screens)).toBeNull();
    expect(restoreBounds({ x: 1850, y: 100, width: 1400, height: 900 }, screens)).toBeNull(); // 70 px left on screen
    expect(restoreBounds(undefined, screens)).toBeNull();
    expect(restoreBounds({ x: Number.NaN, y: 0, width: 1400, height: 900 }, screens)).toBeNull();
  });

  it('a second screen on the left counts', () => {
    const two = [...screens, { workArea: { x: -1600, y: 0, width: 1600, height: 860 } }];
    expect(restoreBounds({ x: -1500, y: 20, width: 1200, height: 800 }, two)).toMatchObject({ x: -1500, y: 20 });
  });

  it('is saved once, after the last change', () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const later = debounce(save, 500);
    later(1);
    later(2);
    vi.advanceTimersByTime(499);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(2);
    later.flush(3);
    expect(save).toHaveBeenLastCalledWith(3);
    vi.useRealTimers();
  });
});

describe("what's new after an update", () => {
  it('only on the first start of a newer version', () => {
    expect(updatedFrom('3.3.18', '3.3.19')).toBe('3.3.18');
    expect(updatedFrom('3.2.0', '3.3.19')).toBe('3.2.0');
    expect(updatedFrom('3.3.19', '3.3.19')).toBeNull();
    expect(updatedFrom(undefined, '3.3.19')).toBeNull(); // a new install
    expect(updatedFrom('3.3.20', '3.3.19')).toBeNull(); // an older installer run over a newer one
    expect(updatedFrom('3.3.9', '3.3.10')).toBe('3.3.9'); // numbers, not text
  });

  it('the shortcuts the tab bar names are in the list', () => {
    expect(SHORTCUTS.map(([keys]: string[]) => keys)).toEqual(expect.arrayContaining(['Ctrl+1', 'Ctrl+2', 'Ctrl+3', 'Ctrl+K']));
  });
});
