'use client';

import { useEffect } from 'react';

/** The theme and the folded menu, from what the owner chose (the same rule as the script in app/layout.tsx). */
export function applySavedLook(): void {
  try {
    const root = document.documentElement;
    const saved = localStorage.getItem('bas-theme');
    const dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    root.classList.toggle('dark', dark);
    root.classList.toggle('sb-collapsed', localStorage.getItem('bas-sidebar') === 'collapsed');
  } catch {
    /* storage unavailable: keep what is there */
  }
}

/**
 * Keeps dark mode (owner QA report, 3.3.34: History came up light in dark mode). When React has to rebuild a page
 * after a hydration mismatch, it sets <html>'s attributes from the server again, which drops the `dark` class the
 * start script added. This puts it back at once whenever the class list changes, and on every start.
 */
export function ThemeKeeper() {
  useEffect(() => {
    applySavedLook();
    const root = document.documentElement;
    let applying = false;
    const observer = new MutationObserver(() => {
      if (applying) return;
      applying = true;
      applySavedLook();
      queueMicrotask(() => {
        applying = false;
      });
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  return null;
}
