import { beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

let client: PrismaClient;
let handler: typeof import('@/lib/agent/handler');
let keys: typeof import('@/lib/agent/keys');
let key: string;

const EXT = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

function req(body: unknown, opts: { key?: string | null; origin?: string | null; host?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json', host: opts.host ?? '127.0.0.1:3000' };
  if (opts.origin !== null) headers.origin = opts.origin ?? EXT;
  const k = opts.key === undefined ? key : opts.key;
  if (k) headers.authorization = `Bearer ${k}`;
  return new Request('http://127.0.0.1:3000/api/extension/agent', { method: 'POST', headers, body: JSON.stringify(body) });
}

beforeAll(async () => {
  ({ client } = await setupTestDb());
  const { seedAll } = await import('@/lib/seed');
  await seedAll(client);
  handler = await import('@/lib/agent/handler');
  keys = await import('@/lib/agent/keys');
  key = (await keys.createConnectionKey()).key;
});

describe('extension agent endpoint', () => {
  it('stores only a hash of the key and shows the key once', async () => {
    expect(key).toMatch(/^bas_[A-Za-z0-9_-]{43}$/);
    const row = await client.setting.findUniqueOrThrow({ where: { key: 'extension.connectionKey' } });
    expect(row.value).not.toContain(key);
    expect(row.value).toContain(keys.hashKey(key));
  });

  it('rejects missing/wrong keys, foreign origins and non-loopback hosts', async () => {
    const hello = { action: 'hello', installId: 'inst-1', version: '3.0.0' };
    expect((await handler.handleAgentRequest(req(hello, { key: null }))).status).toBe(401);
    expect((await handler.handleAgentRequest(req(hello, { key: 'bas_' + 'x'.repeat(43) }))).status).toBe(401);
    expect((await handler.handleAgentRequest(req(hello, { origin: 'https://evil.example' }))).status).toBe(403);
    expect((await handler.handleAgentRequest(req(hello, { host: 'evil.example:3000' }))).status).toBe(403);
    const ok = await handler.handleAgentRequest(req(hello));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe(EXT);
  });

  it('validates payloads with Zod', async () => {
    const bad = await handler.handleAgentRequest(req({ action: 'fail', installId: 'inst-1', tabId: 't', jobId: 'j', code: 'NOPE', message: 'x' }));
    expect(bad.status).toBe(400);
    const unknown = await handler.handleAgentRequest(req({ action: 'delete-everything', installId: 'inst-1' }));
    expect(unknown.status).toBe(400);
  });

  it('flags version drift without handing out work (and never asks the extension to reload itself)', async () => {
    const res = await handler.handleAgentRequest(req({ action: 'hello', installId: 'old-ext', version: '2.9.0' }));
    const body = (await res.json()) as { versionOk: boolean; message: string };
    expect(body.versionOk).toBe(false);
    expect(body.message).toMatch(/Reload the unpacked extension once/);
    const claim = await handler.handleAgentRequest(req({ action: 'claim', installId: 'old-ext', tabId: 't1' }));
    expect(((await claim.json()) as { reason: string }).reason).toBe('version-mismatch');
  });

  it('rotating the key invalidates the previous one', async () => {
    const old = key;
    key = (await keys.createConnectionKey()).key;
    expect((await handler.handleAgentRequest(req({ action: 'hello', installId: 'inst-2', version: '3.0.0' }, { key: old }))).status).toBe(401);
    expect((await handler.handleAgentRequest(req({ action: 'hello', installId: 'inst-2', version: '3.0.0' }))).status).toBe(200);
  });

  it('answers CORS preflight only for extension origins', async () => {
    const pre = await handler.handleAgentRequest(new Request('http://127.0.0.1:3000/api/extension/agent', { method: 'OPTIONS', headers: { origin: EXT, host: '127.0.0.1:3000' } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(EXT);
    const evil = await handler.handleAgentRequest(new Request('http://127.0.0.1:3000/api/extension/agent', { method: 'OPTIONS', headers: { origin: 'https://evil.example', host: '127.0.0.1:3000' } }));
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
});
