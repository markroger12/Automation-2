/**
 * Request security for a private, login-free local tool.
 *
 * There are no user accounts (owner decision). Instead:
 *  1. The server binds to 127.0.0.1, so other machines cannot connect.
 *  2. The Host header must be a loopback name (defeats DNS rebinding).
 *  3. State-changing requests must come from the dashboard's own origin AND
 *     carry the double-submit CSRF token, so other websites open in the
 *     owner's browser cannot trigger actions on localhost.
 * The Chrome extension uses its own bearer connection key instead (see
 * src/lib/agent/auth.ts).
 */

export const CSRF_COOKIE = 'bas_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function hostnameOf(hostHeader: string | null): string | null {
  if (!hostHeader) return null;
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(0, end + 1) : null;
  }
  return value.split(':')[0] || null;
}

export function isLoopbackHost(hostHeader: string | null): boolean {
  const name = hostnameOf(hostHeader);
  return name !== null && LOOPBACK_HOSTS.has(name);
}

/** Origin must be http(s)://<loopback>[:port] and match the Host header. */
export function isSameLoopbackOrigin(origin: string | null, hostHeader: string | null): boolean {
  if (!origin || !hostHeader) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (!isLoopbackHost(url.host)) return false;
    return url.host.toLowerCase() === hostHeader.trim().toLowerCase();
  } catch {
    return false;
  }
}

export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export type DashboardRequestCheck = { ok: true } | { ok: false; status: number; message: string };

/** Validate a dashboard (non-extension) request. */
export function checkDashboardRequest(req: Request): DashboardRequestCheck {
  const host = req.headers.get('host');
  if (!isLoopbackHost(host)) {
    return { ok: false, status: 403, message: 'This private dashboard only accepts requests addressed to localhost.' };
  }
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return { ok: true };
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  const sourceOrigin = origin ?? (referer ? safeOrigin(referer) : null);
  if (!isSameLoopbackOrigin(sourceOrigin, host)) {
    return { ok: false, status: 403, message: 'Cross-origin request blocked. Use the dashboard at http://localhost:3000.' };
  }
  const cookieToken = readCookie(req.headers.get('cookie'), CSRF_COOKIE);
  const headerToken = req.headers.get(CSRF_HEADER);
  if (!cookieToken || !headerToken || !timingSafeEqualString(cookieToken, headerToken)) {
    return { ok: false, status: 403, message: 'Security token missing or expired. Reload the page and try again.' };
  }
  return { ok: true };
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
