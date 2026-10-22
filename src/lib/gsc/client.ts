import { createSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataPaths } from '../paths';
import { AppError } from '../errors';

/**
 * Google Search Console API with the owner's service account (owner request: live data instead of exports).
 * The key file stays in data/credentials and is never returned, logged or put in a report. Only Google's own API
 * hosts are called (base URLs are overridable for tests only). Scope `webmasters`: read data, resubmit sitemaps.
 */

const SCOPE = 'https://www.googleapis.com/auth/webmasters';
const tokenUrl = () => process.env.GSC_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const apiBase = () => (process.env.GSC_API_BASE || 'https://searchconsole.googleapis.com').replace(/\/+$/, '');

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export function parseKey(raw: string): ServiceAccountKey {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new AppError(400, 'BAD_KEY', 'This is not the JSON key file of a service account.');
  }
  if (json.type !== 'service_account' || typeof json.client_email !== 'string' || typeof json.private_key !== 'string' || !json.private_key.includes('PRIVATE KEY')) {
    throw new AppError(400, 'BAD_KEY', 'This is not a service-account key (type "service_account" with client_email and private_key). In Google Cloud: IAM → Service accounts → Keys → Add key → JSON.');
  }
  return { client_email: json.client_email, private_key: json.private_key, project_id: typeof json.project_id === 'string' ? json.project_id : undefined };
}

export function saveKey(raw: string): ServiceAccountKey {
  const key = parseKey(raw);
  const file = dataPaths.gscKey();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'service_account', ...key }), { mode: 0o600 });
  cached = null;
  return key;
}

export function readKey(): ServiceAccountKey | null {
  try {
    return parseKey(fs.readFileSync(dataPaths.gscKey(), 'utf8'));
  } catch {
    return null;
  }
}

/** Remove the key: the file is overwritten with an empty object (never deleted through a computed path). */
export function forgetKey(): void {
  if (fs.existsSync(dataPaths.gscKey())) fs.writeFileSync(dataPaths.gscKey(), '{}', { mode: 0o600 });
  cached = null;
}

let cached: { token: string; until: number; email: string } | null = null;
/** One token request at a time: a sync runs its queries in parallel and they share the token. */
let pending: Promise<{ token: string; email: string }> | null = null;

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

async function accessToken(): Promise<{ token: string; email: string }> {
  if (pending) return pending;
  pending = fetchToken().finally(() => {
    pending = null;
  });
  return pending;
}

async function fetchToken(): Promise<{ token: string; email: string }> {
  const key = readKey();
  if (!key) throw new AppError(409, 'GSC_NOT_CONNECTED', 'Search Console is not connected: upload the service-account key on the Search Performance page.');
  if (cached && cached.email === key.client_email && cached.until > Date.now() + 60_000) return cached;
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key);
  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(signature)}` }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
  if (!res.ok || !body.access_token) throw new AppError(502, 'GSC_AUTH', `Google refused the service-account key: ${body.error_description || body.error || `HTTP ${res.status}`}. Create a new JSON key in Google Cloud and upload it again.`);
  cached = { token: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000, email: key.client_email };
  return cached;
}

export class GscError extends AppError {}

/** One Search Console API call; 401/403/404/429 become messages that say what to do. */
export async function gsc<T>(method: 'GET' | 'POST' | 'PUT', pathAndQuery: string, body?: unknown, property?: string): Promise<T> {
  const { token, email } = await accessToken();
  const res = await fetch(`${apiBase()}${pathAndQuery}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (res.ok) return (text ? JSON.parse(text) : {}) as T;
  let message = text.slice(0, 300);
  try {
    message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? message;
  } catch {
    // keep the raw text
  }
  if (res.status === 403 || res.status === 401) {
    throw new GscError(403, 'GSC_PERMISSION', `Google says ${email} may not do this${property ? ` for ${property}` : ''} (${message}). In Search Console → Settings → Users and permissions, add ${email} with “Full” permission.`);
  }
  if (res.status === 429) throw new GscError(429, 'GSC_QUOTA', `Search Console API quota reached (${message}); it is tried again later.`);
  throw new GscError(res.status >= 500 ? 502 : 400, 'GSC_API', `Search Console API error ${res.status}: ${message}`);
}

export const siteSegment = (property: string) => encodeURIComponent(property);

export async function listProperties(): Promise<{ siteUrl: string; permissionLevel: string }[]> {
  const res = await gsc<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>('GET', '/webmasters/v3/sites');
  return res.siteEntry ?? [];
}

export interface AnalyticsRow {
  keys?: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

/** searchAnalytics.query with paging (25,000 rows per page), up to `maxRows`. */
export async function searchAnalytics(property: string, body: { startDate: string; endDate: string; dimensions: string[]; dataState?: string; type?: string }, maxRows = 25_000): Promise<{ rows: AnalyticsRow[]; firstIncompleteDate?: string; firstIncompleteHour?: string }> {
  const rows: AnalyticsRow[] = [];
  let meta: { firstIncompleteDate?: string; firstIncompleteHour?: string } = {};
  for (let startRow = 0; startRow < maxRows; startRow += 25_000) {
    const rowLimit = Math.min(25_000, maxRows - startRow);
    const res = await gsc<{ rows?: AnalyticsRow[]; metadata?: { firstIncompleteDate?: string; firstIncompleteHour?: string } }>('POST', `/webmasters/v3/sites/${siteSegment(property)}/searchAnalytics/query`, { type: 'web', ...body, rowLimit, startRow }, property);
    if (res.metadata) meta = res.metadata;
    rows.push(...(res.rows ?? []));
    if ((res.rows ?? []).length < rowLimit) break;
  }
  return { rows, ...meta };
}

export interface InspectionResult {
  verdict?: string; // PASS | PARTIAL | FAIL | NEUTRAL | VERDICT_UNSPECIFIED
  coverageState?: string;
  indexingState?: string;
  lastCrawlTime?: string;
  googleCanonical?: string;
  pageFetchState?: string;
}

export async function inspectUrl(property: string, url: string): Promise<{ result: InspectionResult; link: string | null }> {
  const res = await gsc<{ inspectionResult?: { inspectionResultLink?: string; indexStatusResult?: InspectionResult } }>('POST', '/v1/urlInspection/index:inspect', { inspectionUrl: url, siteUrl: property }, property);
  return { result: res.inspectionResult?.indexStatusResult ?? {}, link: res.inspectionResult?.inspectionResultLink ?? null };
}

/** For tests: forget the cached token. */
export function resetGscToken(): void {
  cached = null;
}
