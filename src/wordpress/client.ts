import type { APIRequestContext, APIResponse, BrowserContext } from 'playwright';
import { FatalError, LoginRequiredError, TransientError } from '@/lib/pipeline-errors';
import { assertRequestAllowed } from './publish-guard';
import type { SiteRef } from './browser';

/**
 * The ONLY place that sends requests to WordPress on the app's behalf. It uses
 * the logged-in admin session of the site's persistent profile (cookies + the
 * REST nonce WordPress hands to logged-in users) — never passwords or
 * Application Passwords — and checks every request with the publish guard
 * before sending it. `tests/unit/publish-guard.test.ts` fails if any other
 * module sends WordPress requests directly.
 */

export interface WpPost {
  id: number;
  status: string;
  type: string;
  slug: string;
  generated_slug?: string;
  link: string;
  date_gmt: string | null;
  modified_gmt: string;
  title: { raw?: string; rendered: string };
  content: { raw?: string; rendered?: string };
  categories: number[];
  tags: number[];
  featured_media: number;
}

export interface WpTerm {
  id: number;
  name: string;
  slug: string;
}

export class WpApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly data: unknown = null,
  ) {
    super(message);
    this.name = 'WpApiError';
  }
}

type RestKind = 'pretty' | 'query';

interface CallOptions {
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  body?: Buffer;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

const decodeEntities = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

export class WpClient {
  private constructor(
    private readonly request: APIRequestContext,
    readonly site: SiteRef,
    private readonly kind: RestKind,
    private nonce: string,
    readonly namespaces: string[],
    private readonly timeoutMs: number,
    private readonly taskId: string | null,
  ) {}

  get siteBase(): string {
    return this.site.adminUrl.replace(/wp-admin\/?$/, '');
  }

  get hasRankMath(): boolean {
    return this.namespaces.includes('rankmath/v1');
  }

  editUrl(postId: number): string {
    return `${this.site.adminUrl}post.php?post=${postId}&action=edit`;
  }

  /** Connect with the profile's session: fetch a REST nonce (proves login) and find the REST root. */
  static async connect(context: BrowserContext, site: SiteRef, options: { timeoutMs?: number; taskId?: string | null } = {}): Promise<WpClient> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const request = context.request;
    const nonce = await fetchNonce(request, site, timeoutMs);
    const siteBase = site.adminUrl.replace(/wp-admin\/?$/, '');
    for (const kind of ['pretty', 'query'] as const) {
      const url = kind === 'pretty' ? `${siteBase}wp-json/?_fields=namespaces,name` : `${siteBase}?rest_route=/&_fields=namespaces,name`;
      const res = await request.get(url, { headers: { 'X-WP-Nonce': nonce }, timeout: timeoutMs, failOnStatusCode: false }).catch(() => null);
      if (!res || !res.ok()) continue;
      const json = (await res.json().catch(() => null)) as { namespaces?: string[] } | null;
      if (json && Array.isArray(json.namespaces) && json.namespaces.includes('wp/v2')) {
        return new WpClient(request, site, kind, nonce, json.namespaces, timeoutMs, options.taskId ?? null);
      }
    }
    throw new FatalError(
      `The WordPress REST API of ${site.name} is not reachable for the logged-in user (tried /wp-json/ and ?rest_route=/). A security plugin may block it.`,
      'Allow the REST API for logged-in users (the block editor needs it too), then Retry.',
    );
  }

  url(route: string, query: CallOptions['query'] = {}): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) params.set(k, String(v));
    const qs = params.toString();
    if (this.kind === 'pretty') return `${this.siteBase}wp-json${route}${qs ? `?${qs}` : ''}`;
    return `${this.siteBase}?rest_route=${encodeURIComponent(route)}${qs ? `&${qs}` : ''}`;
  }

  async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', route: string, options: CallOptions = {}): Promise<{ status: number; data: T; headers: Record<string, string> }> {
    const url = this.url(route, options.query);
    const bodyText = options.json !== undefined ? JSON.stringify(options.json) : options.body ? '[binary]' : null;
    const contentType = options.json !== undefined ? 'application/json' : (options.headers?.['Content-Type'] ?? null);
    await assertRequestAllowed(this.site.id, { method, url, body: bodyText, contentType, headers: options.headers }, this.taskId);
    let res: APIResponse;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await this.request.fetch(url, {
          method,
          headers: { 'X-WP-Nonce': this.nonce, Accept: 'application/json', ...(options.headers ?? {}) },
          ...(options.json !== undefined ? { data: options.json } : options.body ? { data: options.body } : {}),
          timeout: options.timeoutMs ?? this.timeoutMs,
          failOnStatusCode: false,
          maxRedirects: method === 'GET' ? 5 : 0,
        });
      } catch (error) {
        throw new TransientError(`WordPress request ${method} ${route} failed: ${(error as Error).message.split('\n')[0]}`);
      }
      const status = res.status();
      if ((status === 401 || status === 403) && attempt === 0) {
        const code = ((await res.json().catch(() => ({}))) as { code?: string }).code;
        if (code === 'rest_cookie_invalid_nonce') {
          this.nonce = await fetchNonce(this.request, this.site, this.timeoutMs);
          continue;
        }
      }
      break;
    }
    const status = res.status();
    const text = await res.text().catch(() => '');
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (status >= 200 && status < 300) return { status, data: data as T, headers: res.headers() };
    const err = (data ?? {}) as { code?: string; message?: string; data?: unknown };
    if (status === 401 || err.code === 'rest_not_logged_in') {
      throw new LoginRequiredError('wordpress', `${this.site.name}: the WordPress session expired (${err.code ?? status}).`, this.site.id);
    }
    if (status >= 500 || status === 429 || status === 408) {
      throw new TransientError(`WordPress answered ${status} for ${method} ${route}${err.message ? `: ${stripTags(err.message)}` : ''}`);
    }
    throw new WpApiError(`WordPress answered ${status} for ${method} ${route}: ${stripTags(err.message ?? text.slice(0, 200))}`, status, err.code ?? null, err.data ?? null);
  }

  // ---------------- posts ----------------

  async getPost(id: number): Promise<WpPost | null> {
    try {
      const { data } = await this.call<WpPost>('GET', `/wp/v2/posts/${id}`, { query: { context: 'edit' } });
      return data;
    } catch (error) {
      if (error instanceof WpApiError && (error.status === 404 || error.status === 410)) return null;
      throw error;
    }
  }

  async findPosts(query: { search?: string; slug?: string; modifiedAfter?: string; perPage?: number }): Promise<WpPost[]> {
    const { data } = await this.call<WpPost[]>('GET', '/wp/v2/posts', {
      query: {
        context: 'edit',
        status: 'draft,pending,future,private,publish',
        per_page: query.perPage ?? 20,
        orderby: 'date',
        order: 'desc',
        search: query.search,
        slug: query.slug,
        modified_after: query.modifiedAfter,
      },
    });
    return Array.isArray(data) ? data : [];
  }

  /** Create a post as a DRAFT. `status` is fixed here; callers cannot change it. */
  async createDraft(fields: { title: string; content: string; slug?: string; categories?: number[]; tags?: number[]; featured_media?: number; excerpt?: string }, timeoutMs?: number): Promise<WpPost> {
    const { data } = await this.call<WpPost>('POST', '/wp/v2/posts', { json: { ...fields, status: 'draft' }, timeoutMs });
    return data;
  }

  /** Update content/metadata of an existing post. Never sends a status. */
  async updatePost(id: number, fields: { title?: string; content?: string; slug?: string; categories?: number[]; tags?: number[]; featured_media?: number }, timeoutMs?: number): Promise<WpPost> {
    const { status: _ignored, ...safe } = fields as Record<string, unknown>;
    const { data } = await this.call<WpPost>('POST', `/wp/v2/posts/${id}`, { json: safe, timeoutMs });
    return data;
  }

  /**
   * Schedule a draft for a future time (the ONLY status change this client
   * sends). The publish guard refuses it unless the caller holds a permit
   * from withPublishPermit for this site and post (canPublish + acknowledgement).
   */
  async scheduleFuture(id: number, at: Date): Promise<WpPost> {
    const dateGmt = at.toISOString().replace(/\.\d+Z$/, '');
    const { data } = await this.call<WpPost>('POST', `/wp/v2/posts/${id}`, { json: { status: 'future', date_gmt: dateGmt } });
    return data;
  }

  // ---------------- terms ----------------

  /** Find a tag by exact name (case-insensitive), creating it when allowed. */
  async ensureTag(name: string, create: boolean): Promise<{ id: number | null; created: boolean; error?: string }> {
    const wanted = name.trim().toLowerCase();
    const { data } = await this.call<WpTerm[]>('GET', '/wp/v2/tags', { query: { search: name.trim(), per_page: 100, _fields: 'id,name,slug' } });
    const hit = (Array.isArray(data) ? data : []).find((t) => decodeEntities(t.name).trim().toLowerCase() === wanted);
    if (hit) return { id: hit.id, created: false };
    if (!create) return { id: null, created: false, error: `Tag “${name}” does not exist (creating tags is turned off).` };
    try {
      const res = await this.call<WpTerm>('POST', '/wp/v2/tags', { json: { name: name.trim() } });
      return { id: res.data.id, created: true };
    } catch (error) {
      if (error instanceof WpApiError) {
        const termId = (error.data as { term_id?: number } | null)?.term_id;
        if (error.code === 'term_exists' && termId) return { id: termId, created: false };
        return { id: null, created: false, error: `Tag “${name}” could not be created (${error.code ?? error.status}).` };
      }
      throw error;
    }
  }

  async categoryExists(id: number): Promise<boolean> {
    try {
      await this.call('GET', `/wp/v2/categories/${id}`, { query: { _fields: 'id' } });
      return true;
    } catch (error) {
      if (error instanceof WpApiError && (error.status === 404 || error.status === 400)) return false;
      throw error;
    }
  }

  // ---------------- media ----------------

  async uploadMedia(file: { bytes: Buffer; filename: string; mime: string; altText?: string | null; title?: string | null }): Promise<{ id: number; url: string }> {
    const safeName = file.filename.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 120) || 'image';
    const { data } = await this.call<{ id: number; source_url: string }>('POST', '/wp/v2/media', {
      body: file.bytes,
      headers: { 'Content-Type': file.mime, 'Content-Disposition': `attachment; filename="${safeName}"` },
      timeoutMs: Math.max(this.timeoutMs, 120_000),
    });
    if (file.altText || file.title) {
      await this.call('POST', `/wp/v2/media/${data.id}`, { json: { ...(file.altText ? { alt_text: file.altText } : {}), ...(file.title ? { title: file.title } : {}) } });
    }
    return { id: data.id, url: data.source_url };
  }

  async getMedia(id: number): Promise<{ id: number; source_url: string; alt_text: string } | null> {
    try {
      const { data } = await this.call<{ id: number; source_url: string; alt_text: string }>('GET', `/wp/v2/media/${id}`, { query: { context: 'edit', _fields: 'id,source_url,alt_text' } });
      return data;
    } catch (error) {
      if (error instanceof WpApiError && (error.status === 404 || error.status === 410)) return null;
      throw error;
    }
  }

  /**
   * Media item by its exact slug. WordPress derives an attachment's slug from
   * the uploaded file name, so a unique upload name finds an upload whose
   * answer was lost (timeout) instead of uploading it twice.
   */
  async findMediaBySlug(slug: string): Promise<{ id: number; source_url: string; alt_text: string } | null> {
    const { data } = await this.call<{ id: number; source_url: string; alt_text: string; slug: string }[]>('GET', '/wp/v2/media', { query: { slug, context: 'edit', _fields: 'id,source_url,alt_text,slug', per_page: 5 } });
    const hit = Array.isArray(data) ? data.find((m) => m.slug === slug) : undefined;
    return hit ? { id: hit.id, source_url: hit.source_url, alt_text: hit.alt_text } : null;
  }

  async updateMediaAlt(id: number, altText: string): Promise<void> {
    await this.call('POST', `/wp/v2/media/${id}`, { json: { alt_text: altText } });
  }

  /** The signed-in account (name, roles and capabilities; WordPress returns these to the account itself). */
  async currentUser(): Promise<{ id: number; name: string; roles: string[]; capabilities: Record<string, boolean> }> {
    const { data } = await this.call<{ id: number; name: string; roles?: string[]; capabilities?: Record<string, boolean> }>('GET', '/wp/v2/users/me', { query: { context: 'edit', _fields: 'id,name,roles,capabilities' } });
    return { id: data.id, name: data.name, roles: data.roles ?? [], capabilities: data.capabilities ?? {} };
  }

  // ---------------- Rank Math ----------------

  /** Rank Math's own REST endpoint used by its editor sidebar. */
  async rankMathUpdateMeta(postId: number, meta: Record<string, string>): Promise<void> {
    await this.call('POST', '/rankmath/v1/updateMeta', { json: { objectType: 'post', objectID: postId, meta } });
  }
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '').trim();
}

async function fetchNonce(request: APIRequestContext, site: SiteRef, timeoutMs: number): Promise<string> {
  let res: APIResponse;
  try {
    res = await request.get(`${site.adminUrl}admin-ajax.php?action=rest-nonce`, { timeout: timeoutMs, failOnStatusCode: false, maxRedirects: 0 });
  } catch (error) {
    throw new TransientError(`${site.name}: WordPress is not reachable (${(error as Error).message.split('\n')[0]}).`);
  }
  const text = (await res.text().catch(() => '')).trim();
  // WordPress nonces are short hex strings; "0" / "-1" mean "not logged in".
  if (res.ok() && /^[a-z0-9]{6,40}$/i.test(text)) return text;
  if (res.status() >= 500) throw new TransientError(`${site.name}: WordPress answered ${res.status()} while checking the session.`);
  throw new LoginRequiredError('wordpress', `${site.name}: not logged in to WordPress (session missing or expired).`, site.id);
}
