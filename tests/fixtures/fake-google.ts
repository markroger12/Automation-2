import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createVerify, generateKeyPairSync, type KeyObject } from 'node:crypto';

/**
 * FAKE Google token endpoint + Search Console API for tests (nothing reaches Google). The token endpoint checks the
 * service-account JWT signature with the test key's public half, like Google does.
 */

export function makeServiceAccount(email = 'bas-sync@test-project.iam.gserviceaccount.com') {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    json: JSON.stringify({ type: 'service_account', project_id: 'test-project', client_email: email, private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: 'https://oauth2.googleapis.com/token' }),
    publicKey,
    email,
  };
}

export interface AnalyticsBody {
  startDate: string;
  endDate: string;
  dimensions: string[];
  dataState?: string;
  rowLimit: number;
  startRow: number;
}

export interface FakeGoogle {
  url: string;
  tokens: number;
  calls: { method: string; path: string; body?: unknown }[];
  submitted: string[];
  inspected: string[];
  close: () => Promise<void>;
}

export async function startFakeGoogle(opts: {
  publicKey: KeyObject;
  email: string;
  properties: { siteUrl: string; permissionLevel: string }[];
  analytics: (body: AnalyticsBody, site: string) => { rows: { keys: string[]; clicks: number; impressions: number; ctr: number; position: number }[]; metadata?: Record<string, string | undefined> };
  sitemaps?: string[];
  inspection: (url: string) => Record<string, string | undefined>;
}): Promise<FakeGoogle> {
  const state: Omit<FakeGoogle, 'url' | 'close'> = { tokens: 0, calls: [], submitted: [], inspected: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      const path = decodeURIComponent((req.url ?? '').split('?')[0]);
      if (req.method === 'POST' && path === '/token') {
        const form = new URLSearchParams(raw);
        const [h, p, sig] = (form.get('assertion') ?? '').split('.');
        const ok = Boolean(h && p && sig) && createVerify('RSA-SHA256').update(`${h}.${p}`).verify(opts.publicKey, Buffer.from(sig, 'base64url'));
        const claims = ok ? (JSON.parse(Buffer.from(p, 'base64url').toString()) as { iss: string; scope: string }) : null;
        if (!ok || claims?.iss !== opts.email || form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return send(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' });
        state.tokens++;
        return send(200, { access_token: 'test-token', expires_in: 3600, token_type: 'Bearer' });
      }
      if (req.headers.authorization !== 'Bearer test-token') return send(401, { error: { message: 'Request had invalid authentication credentials.' } });
      const body = raw ? JSON.parse(raw) : undefined;
      state.calls.push({ method: req.method ?? '', path, body });
      if (req.method === 'GET' && path === '/webmasters/v3/sites') return send(200, { siteEntry: opts.properties });
      const site = /^\/webmasters\/v3\/sites\/(.+?)\/(searchAnalytics\/query|sitemaps(?:\/(.+))?)$/.exec(path);
      if (site) {
        if (!opts.properties.some((p) => p.siteUrl === site[1])) return send(403, { error: { message: `User does not have sufficient permission for site '${site[1]}'.` } });
        if (site[2] === 'searchAnalytics/query') return send(200, opts.analytics(body as AnalyticsBody, site[1]));
        if (req.method === 'GET') return send(200, { sitemap: (opts.sitemaps ?? []).map((p) => ({ path: p })) });
        if (req.method === 'PUT') {
          state.submitted.push(site[3]);
          return send(200);
        }
      }
      if (req.method === 'POST' && path === '/v1/urlInspection/index:inspect') {
        const { inspectionUrl, siteUrl } = body as { inspectionUrl: string; siteUrl: string };
        if (!opts.properties.some((p) => p.siteUrl === siteUrl)) return send(403, { error: { message: 'You do not own this site, or the inspected URL is not part of this property.' } });
        state.inspected.push(inspectionUrl);
        return send(200, { inspectionResult: { inspectionResultLink: 'https://search.google.com/search-console/inspect?x', indexStatusResult: opts.inspection(inspectionUrl) } });
      }
      send(404, { error: { message: `not found: ${path}` } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake = Object.assign(state as FakeGoogle, { url, close: () => new Promise<void>((r) => server.close(() => r())) });
  return fake;
}
