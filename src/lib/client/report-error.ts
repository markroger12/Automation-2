'use client';

import { CSRF_COOKIE, CSRF_HEADER } from '../security';

/**
 * Sends an error of the dashboard page to the app's log (owner report 2026-11-12: a bare “Application error: a
 * client-side exception has occurred” with nothing to send the developer). The log line names where it happened, the
 * message and the first lines of the stack; the server redacts secrets as for every log line. At most 5 a minute, and
 * it never throws.
 */
let sent: number[] = [];

function csrf(): string {
  for (const part of document.cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === CSRF_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export function reportClientError(error: unknown, where: string): void {
  try {
    const now = Date.now();
    sent = sent.filter((t) => now - t < 60_000);
    if (sent.length >= 5) return;
    sent.push(now);
    const e = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error ?? null));
    void fetch('/api/client-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: csrf() },
      credentials: 'same-origin',
      body: JSON.stringify({
        where: where.slice(0, 80),
        message: `${e.name}: ${e.message}`.slice(0, 500),
        stack: (e.stack ?? '').split('\n').slice(0, 15).join('\n').slice(0, 3000),
        path: window.location.pathname.slice(0, 200),
      }),
    }).catch(() => {});
  } catch {
    /* reporting must never break the page */
  }
}
