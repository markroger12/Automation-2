import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

/**
 * SSRF-safe page fetcher for link verification.
 *
 *  - http/https only, default ports only, no credentials in URLs
 *  - every hop (including each redirect) is resolved and checked: private,
 *    loopback, link-local, CGNAT, multicast and reserved addresses are refused
 *  - the connection is pinned to the checked address (no DNS-rebinding window)
 *  - bounded redirects, time and size caps, no cookies sent or kept
 *
 * `trustedHosts` lets the caller fetch its OWN website even when it lives on
 * a private address (e.g. a WordPress on the LAN) — never used for external links.
 */

export type Lookup = (hostname: string) => Promise<{ address: string; family: 4 | 6 }[]>;

const systemLookup: Lookup = async (hostname) => (await dns.promises.lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

let testLookup: Lookup | null = null;
let testTrusted: string[] = [];
/** Tests only: resolve fake hostnames and allow named loopback hosts. */
export function setLinkNetworkForTests(lookup: Lookup | null, trustedLoopbackHosts: string[] = []) {
  testLookup = lookup;
  testTrusted = trustedLoopbackHosts.map((h) => h.toLowerCase());
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

const V4_BLOCKED: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

/** True when the address must never be contacted for an external link. */
export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) {
    const n = ipv4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (ipv4ToInt(base) >>> (32 - bits)));
  }
  if (family === 6) {
    const lower = ip.toLowerCase();
    const mapped = /^(?:0{0,4}:){0,5}(?:0{0,4}:)?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (lower === '::' || lower === '::1') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (lower.startsWith('2001:db8') || lower.startsWith('64:ff9b:') || lower.startsWith('100::')) return true;
    return false;
  }
  return true;
}

export class LinkFetchError extends Error {
  constructor(
    message: string,
    public readonly code: 'SCHEME' | 'PORT' | 'CREDENTIALS' | 'DNS' | 'BLOCKED_ADDRESS' | 'TIMEOUT' | 'TOO_LARGE' | 'TOO_MANY_REDIRECTS' | 'REDIRECT_REFUSED' | 'NETWORK' | 'HTTP',
  ) {
    super(message);
    this.name = 'LinkFetchError';
  }
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  redirects: string[];
  bytes: number;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  acceptLanguage?: string;
  /** Hosts the caller owns (its own website). They may resolve to private addresses. */
  trustedHosts?: string[];
  method?: 'GET' | 'HEAD';
  /** Decide whether a redirect may be followed (checked before contacting the new host). */
  allowRedirect?: (from: URL, to: URL) => boolean;
}

async function resolveChecked(url: URL, trusted: string[]): Promise<{ address: string; family: 4 | 6 }> {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const literal = net.isIP(host);
  const records = literal ? [{ address: host, family: (literal === 6 ? 6 : 4) as 4 | 6 }] : await (testLookup ?? systemLookup)(host).catch(() => []);
  if (!records.length) throw new LinkFetchError(`DNS lookup failed for ${host}`, 'DNS');
  const isTrusted = trusted.includes(host) || testTrusted.includes(host);
  if (!isTrusted) {
    const bad = records.find((r) => isBlockedAddress(r.address));
    if (bad) throw new LinkFetchError(`${host} resolves to a private or reserved address (${bad.address})`, 'BLOCKED_ADDRESS');
  }
  return records[0];
}

function checkUrl(url: URL, trusted: string[]) {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new LinkFetchError(`Scheme ${url.protocol} is not allowed`, 'SCHEME');
  if (url.username || url.password) throw new LinkFetchError('URLs with credentials are not allowed', 'CREDENTIALS');
  const host = url.hostname.toLowerCase();
  const trustedHost = trusted.includes(host) || testTrusted.includes(host);
  if (url.port && !trustedHost && !['80', '443'].includes(url.port)) throw new LinkFetchError(`Port ${url.port} is not allowed`, 'PORT');
}

function requestOnce(url: URL, pinned: { address: string; family: 4 | 6 }, opts: Required<Pick<SafeFetchOptions, 'timeoutMs' | 'maxBytes'>> & SafeFetchOptions): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: opts.method ?? 'GET',
        // Pin the connection to the address that was checked above.
        lookup: ((_host: string, o: { all?: boolean }, cb: (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void) => {
          if (o?.all) cb(null, [{ address: pinned.address, family: pinned.family }]);
          else cb(null, pinned.address, pinned.family);
        }) as unknown as net.LookupFunction,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; BlogAutomationStudio-LinkCheck/3.0)',
          Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
          'Accept-Language': opts.acceptLanguage ?? 'en-US,en;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        timeout: opts.timeoutMs,
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > opts.maxBytes) {
            req.destroy(new LinkFetchError(`Response larger than ${opts.maxBytes} bytes`, 'TOO_LARGE'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    const timer = setTimeout(() => req.destroy(new LinkFetchError(`Timed out after ${opts.timeoutMs} ms`, 'TIMEOUT')), opts.timeoutMs);
    req.on('timeout', () => req.destroy(new LinkFetchError(`Timed out after ${opts.timeoutMs} ms`, 'TIMEOUT')));
    req.on('error', (e) => reject(e instanceof LinkFetchError ? e : new LinkFetchError(e.message, 'NETWORK')));
    req.on('close', () => clearTimeout(timer));
    req.end();
  });
}

function decode(body: Buffer, encoding: string | undefined, maxBytes: number): Buffer {
  const opts = { maxOutputLength: maxBytes };
  try {
    if (encoding === 'gzip') return zlib.gunzipSync(body, opts);
    if (encoding === 'deflate') return zlib.inflateSync(body, opts);
    if (encoding === 'br') return zlib.brotliDecompressSync(body, opts);
  } catch {
    throw new LinkFetchError('Could not decode the response (or it was too large once decompressed)', 'TOO_LARGE');
  }
  return body;
}

export async function safeFetch(rawUrl: string, options: SafeFetchOptions = {}): Promise<FetchedPage> {
  const opts = { timeoutMs: options.timeoutMs ?? 10_000, maxBytes: options.maxBytes ?? 1_500_000, maxRedirects: options.maxRedirects ?? 5, ...options };
  const trusted = (options.trustedHosts ?? []).map((h) => h.toLowerCase());
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LinkFetchError(`Not a valid URL: ${rawUrl.slice(0, 120)}`, 'SCHEME');
  }
  const redirects: string[] = [];
  for (let hop = 0; ; hop++) {
    checkUrl(url, trusted);
    const pinned = await resolveChecked(url, trusted);
    const res = await requestOnce(url, pinned, { ...opts, timeoutMs: opts.timeoutMs, maxBytes: opts.maxBytes });
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      if (hop >= opts.maxRedirects) throw new LinkFetchError(`More than ${opts.maxRedirects} redirects`, 'TOO_MANY_REDIRECTS');
      const next = new URL(res.headers.location, url);
      if (options.allowRedirect && !options.allowRedirect(url, next)) throw new LinkFetchError(`redirects to another site (${next.hostname})`, 'REDIRECT_REFUSED');
      redirects.push(next.toString());
      url = next;
      continue;
    }
    const body = decode(res.body, String(res.headers['content-encoding'] ?? '').toLowerCase() || undefined, opts.maxBytes);
    return {
      url: rawUrl,
      finalUrl: url.toString(),
      status: res.status,
      contentType: String(res.headers['content-type'] ?? ''),
      body: body.toString('utf8'),
      redirects,
      bytes: body.length,
    };
  }
}
