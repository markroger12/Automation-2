'use client';

import { CSRF_COOKIE, CSRF_HEADER } from '../security';

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fieldErrors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  if (typeof document === 'undefined') return '';
  for (const part of document.cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === CSRF_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return '';
}

/** Fetch JSON from the dashboard API with the CSRF header and typed errors. */
export async function api<T = unknown>(url: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(method !== 'GET' ? { [CSRF_HEADER]: csrfToken() } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    throw new ApiClientError(0, 'NETWORK', 'Cannot reach the local server. Is `npm run dev:all` still running?');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = (data as { error?: { code?: string; message?: string; fieldErrors?: Record<string, string[]> } } | null)?.error;
    throw new ApiClientError(res.status, err?.code ?? 'HTTP_' + res.status, err?.message ?? `Request failed (${res.status}).`, err?.fieldErrors);
  }
  return data as T;
}
