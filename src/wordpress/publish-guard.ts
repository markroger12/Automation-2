import type { BrowserContext, Route } from 'playwright';
import { db } from '@/lib/db';
import { log } from '@/lib/log';
import { audit } from '@/lib/audit';

/**
 * Site-scoped publication guard. Draft-only is the default for every site.
 *
 * Any request that could put a WordPress post into a publishing state
 * (publish, future, private, pending), or delete a post, is refused unless an
 * explicit, short-lived permit exists for that site and post. Permits are only
 * granted by `withPublishPermit`, which re-reads `canPublish` from the
 * database first; only the approved scheduler flow calls it (M10).
 *
 * Enforced at two boundaries that share one classifier:
 *  1. Service level — every request the app sends itself goes through
 *     `WpClient`, which calls `assertRequestAllowed` before sending.
 *  2. Network level — `installPublishGuard` routes every browser request of
 *     a WordPress profile (editor UI buttons, shortcuts, in-page fetches) and
 *     answers blocked ones with HTTP 403 before they reach WordPress.
 * Hiding the Publish button is not relied upon anywhere.
 */

export const BLOCKED_STATUSES = ['publish', 'future', 'private', 'pending'] as const;

export interface OutgoingRequest {
  method: string;
  url: string;
  body?: string | null;
  contentType?: string | null;
  headers?: Record<string, string>;
}

export interface Classification {
  /** null when the request cannot change publication state. */
  effect: 'status' | 'delete' | 'xmlrpc' | null;
  status?: string;
  postId?: number | null;
  route?: string;
  detail: string;
}

const POST_TYPE_ROUTE = /^\/wp\/v2\/([a-z0-9_-]+)(?:\/(\d+))?\/?$/i;
// Routes under /wp/v2/ that are not post types (cannot publish anything).
const NON_POST_ROUTES = new Set(['users', 'settings', 'categories', 'tags', 'comments', 'taxonomies', 'types', 'statuses', 'search', 'block-renderer', 'block-types', 'themes', 'plugins', 'sidebars', 'widgets', 'widget-types', 'menu-locations', 'global-styles', 'block-directory', 'pattern-directory', 'block-patterns', 'font-collections']);

function lower(s: unknown): string {
  return typeof s === 'string' ? s.toLowerCase() : '';
}

function parseBody(body: string | null | undefined, contentType: string | null | undefined): Record<string, unknown> {
  if (!body) return {};
  const ct = lower(contentType);
  if (ct.includes('json') || /^\s*[{[]/.test(body)) {
    try {
      const v = JSON.parse(body);
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    } catch {
      /* fall through to form parsing */
    }
  }
  if (ct.includes('multipart/form-data')) {
    const out: Record<string, unknown> = {};
    for (const m of body.matchAll(/name="([^"]+)"\r?\n(?:[^\r\n]+\r?\n)*\r?\n([^\r\n]*)/g)) out[m[1]] = m[2];
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

/** The REST route of a URL in either form: /wp-json/<route> or ?rest_route=<route>. */
export function restRouteOf(url: URL): string | null {
  const q = url.searchParams.get('rest_route');
  // A malformed "?rest_route=/x?y=1" still targets route /x for safety purposes.
  if (q !== null) {
    const route = q.split('?')[0];
    return route.startsWith('/') ? route : `/${route}`;
  }
  const i = url.pathname.indexOf('/wp-json/');
  if (i >= 0) return url.pathname.slice(i + '/wp-json'.length) || '/';
  return null;
}

function classifyRest(method: string, route: string, url: URL, body: Record<string, unknown>): Classification {
  const statusFrom = (src: Record<string, unknown>) => lower(src.status);
  if (/^\/batch\/v1\/?$/i.test(route) && method !== 'GET') {
    const requests = Array.isArray(body.requests) ? (body.requests as Record<string, unknown>[]) : [];
    for (const r of requests) {
      const sub = classifyRequest({ method: String(r.method ?? 'POST'), url: new URL(`/?rest_route=${encodeURIComponent(String(r.path ?? ''))}`, url).toString(), body: JSON.stringify(r.body ?? {}), contentType: 'application/json' });
      if (sub.effect) return { ...sub, detail: `batch: ${sub.detail}` };
    }
    return { effect: null, route, detail: 'batch without publishing changes' };
  }
  const m = POST_TYPE_ROUTE.exec(route);
  if (!m || NON_POST_ROUTES.has(m[1].toLowerCase())) return { effect: null, route, detail: 'not a post route' };
  const postId = m[2] ? Number(m[2]) : null;
  if (method === 'DELETE') return { effect: 'delete', postId, route, detail: `DELETE ${route}` };
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return { effect: null, route, detail: 'read-only' };
  // REST accepts arguments from the query string as well as the body.
  const status = statusFrom(body) || lower(url.searchParams.get('status'));
  if ((BLOCKED_STATUSES as readonly string[]).includes(status)) return { effect: 'status', status, postId, route, detail: `${method} ${route} status=${status}` };
  return { effect: null, route, detail: status ? `status=${status}` : 'no status change' };
}

function classifyAdmin(method: string, url: URL, body: Record<string, unknown>): Classification {
  const path = url.pathname.toLowerCase();
  const q = Object.fromEntries(url.searchParams) as Record<string, unknown>;
  const all = { ...q, ...body };
  const blocked = (v: unknown) => (BLOCKED_STATUSES as readonly string[]).includes(lower(v));
  const postId = Number(all.post_ID ?? all.post ?? all.post_id ?? 0) || null;
  if (path.endsWith('/xmlrpc.php') && method !== 'GET') return { effect: 'xmlrpc', postId: null, detail: 'XML-RPC write request' };
  if (path.endsWith('/wp-admin/post.php') || path.endsWith('/wp-admin/post-new.php')) {
    if (method === 'GET') {
      const action = lower(q.action);
      if (action === 'delete' || action === 'trash') return { effect: 'delete', postId, detail: `post.php?action=${action}` };
      return { effect: null, detail: 'editor page' };
    }
    if ('publish' in all) return { effect: 'status', status: 'publish', postId, detail: 'Classic editor Publish/Schedule button' };
    if (blocked(all.post_status)) return { effect: 'status', status: lower(all.post_status), postId, detail: `post_status=${lower(all.post_status)}` };
    if (lower(all.visibility) === 'private') return { effect: 'status', status: 'private', postId, detail: 'visibility=private' };
    if (lower(all.action) === 'delete') return { effect: 'delete', postId, detail: 'post.php action=delete' };
    return { effect: null, detail: 'draft save' };
  }
  if (path.endsWith('/wp-admin/admin-ajax.php')) {
    const action = lower(all.action);
    if (action === 'inline-save' && blocked(all._status)) return { effect: 'status', status: lower(all._status), postId, detail: `Quick Edit _status=${lower(all._status)}` };
    if (action === 'inline-save' && lower(all.keep_private) === 'private') return { effect: 'status', status: 'private', postId, detail: 'Quick Edit private' };
    if (action === 'delete-post' || action === 'trash-post') return { effect: 'delete', postId, detail: `admin-ajax ${action}` };
    return { effect: null, detail: `admin-ajax ${action || '?'}` };
  }
  if (path.endsWith('/wp-admin/edit.php')) {
    if (blocked(all._status) && ('bulk_edit' in all || lower(all.action) === 'edit' || lower(all.action2) === 'edit')) return { effect: 'status', status: lower(all._status), postId: null, detail: `Bulk edit _status=${lower(all._status)}` };
    const action = lower(all.action) || lower(all.action2);
    if (action === 'delete' || action === 'trash') return { effect: 'delete', postId: null, detail: `bulk ${action}` };
    return { effect: null, detail: 'posts list' };
  }
  return { effect: null, detail: 'other' };
}

/** Classify a request by what it could do to publication state. Pure and side-effect free. */
export function classifyRequest(req: OutgoingRequest): Classification {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { effect: null, detail: 'invalid url' };
  }
  const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let method = (req.method || 'GET').toUpperCase();
  const override = headers['x-http-method-override'] || url.searchParams.get('_method');
  if (method === 'POST' && override) method = override.toUpperCase();
  const body = parseBody(req.body, req.contentType ?? headers['content-type']);
  const route = restRouteOf(url);
  if (route !== null) return classifyRest(method, route, url, body);
  return classifyAdmin(method, url, body);
}

// ---------------------------------------------------------------- permits

interface Permit {
  siteId: string;
  postId: number;
  purpose: string;
  expiresAt: number;
}
const permits = new Map<string, Permit>();

export class PublishNotAllowedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PublishNotAllowedError';
  }
}

function activePermit(siteId: string, postId: number | null | undefined, where: 'service' | 'network'): Permit | null {
  const p = permits.get(siteId);
  if (!p) return null;
  if (p.expiresAt < Date.now()) {
    permits.delete(siteId);
    return null;
  }
  // The owner's own visible window (postId 0) covers clicks in that browser only — never the app's own requests.
  if (p.postId === 0) return where === 'network' ? p : null;
  return postId && p.postId === postId ? p : null;
}

/**
 * The owner's visible “Open browser” window: when (and only when) the site
 * allows publishing, the owner may publish by hand there. Deleting stays
 * blocked in every app-controlled browser.
 */
export async function withOwnerWindowPermit<T>(siteId: string, fn: () => Promise<T>): Promise<{ result: T; publishingAllowed: boolean }> {
  const site = await db.website.findUnique({ where: { id: siteId }, select: { canPublish: true, canPublishAcknowledgedAt: true } });
  const allowed = Boolean(site?.canPublish && site.canPublishAcknowledgedAt);
  if (allowed) permits.set(siteId, { siteId, postId: 0, purpose: 'owner-window', expiresAt: Date.now() + 31 * 60_000 });
  try {
    return { result: await fn(), publishingAllowed: allowed };
  } finally {
    if (allowed) permits.delete(siteId);
  }
}

/**
 * Run `fn` with permission to change the publication state of ONE post. Only
 * the approved scheduler flow uses this. `canPublish` and its acknowledgement
 * are re-read from the database first.
 */
export async function withPublishPermit<T>(siteId: string, postId: number, purpose: string, fn: () => Promise<T>, ttlMs = 5 * 60_000): Promise<T> {
  const site = await db.website.findUnique({ where: { id: siteId }, select: { canPublish: true, canPublishAcknowledgedAt: true, name: true } });
  if (!site?.canPublish || !site.canPublishAcknowledgedAt) throw new PublishNotAllowedError(`Publishing is not allowed for ${site?.name ?? 'this site'} (drafts only).`);
  permits.set(siteId, { siteId, postId, purpose, expiresAt: Date.now() + ttlMs });
  await audit('publish.permit', 'Website', siteId, { postId, purpose });
  try {
    return await fn();
  } finally {
    permits.delete(siteId);
  }
}

export interface GuardDecision {
  allowed: boolean;
  classification: Classification;
  reason?: string;
}

export function decide(siteId: string, req: OutgoingRequest, where: 'service' | 'network' = 'service'): GuardDecision {
  const classification = classifyRequest(req);
  if (!classification.effect) return { allowed: true, classification };
  if (classification.effect === 'status' && activePermit(siteId, classification.postId, where)) return { allowed: true, classification };
  const what = classification.effect === 'delete' ? 'deleting posts' : classification.effect === 'xmlrpc' ? 'XML-RPC writes' : `setting a post to “${classification.status}”`;
  return { allowed: false, classification, reason: `Blocked by Blog Automation Studio: ${what} is not allowed here (drafts only; publishing only through the approved scheduler with per-site permission).` };
}

async function recordBlocked(siteId: string, decision: GuardDecision, where: 'service' | 'network', taskId?: string | null) {
  await log({ level: 'warn', category: 'wordpress', taskId: taskId ?? null, message: `Publish guard (${where}) blocked: ${decision.classification.detail}`, details: { siteId, ...decision.classification } });
  await audit('publish.blocked', 'Website', siteId, { where, ...decision.classification }).catch(() => {});
}

/** Service-level check used by WpClient for every request the app sends. */
export async function assertRequestAllowed(siteId: string, req: OutgoingRequest, taskId?: string | null): Promise<void> {
  const decision = decide(siteId, req);
  if (decision.allowed) return;
  await recordBlocked(siteId, decision, 'service', taskId);
  throw new PublishNotAllowedError(decision.reason!);
}

// Only requests that can change publication state are routed; assets are untouched.
export const GUARDED_URL = /\/wp-json\/|[?&]rest_route=|\/wp-admin\/(?:post|post-new|edit|admin-ajax)\.php|\/xmlrpc\.php/i;

/** Network-level guard: installed on every WordPress browser context. */
export async function installPublishGuard(context: BrowserContext, siteId: string): Promise<void> {
  await context.route(GUARDED_URL, async (route: Route) => {
    const request = route.request();
    const decision = decide(
      siteId,
      { method: request.method(), url: request.url(), body: request.postData(), contentType: request.headers()['content-type'] ?? null, headers: request.headers() },
      'network',
    );
    if (decision.allowed) return route.fallback();
    await recordBlocked(siteId, decision, 'network').catch(() => {});
    const isRest = decision.classification.route !== undefined;
    return route.fulfill({
      status: 403,
      contentType: isRest ? 'application/json' : 'text/html; charset=utf-8',
      body: isRest ? JSON.stringify({ code: 'bas_publish_blocked', message: decision.reason, data: { status: 403 } }) : `<!doctype html><title>Blocked</title><p>${decision.reason}</p>`,
    });
  });
}
