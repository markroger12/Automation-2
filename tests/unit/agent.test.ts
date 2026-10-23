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

  it("the desktop app's ChatGPT tab: its own key and install id, prompts only to it while connected, never Search Console", async () => {
    const { EXPECTED_EXTENSION_VERSION } = await import('@/lib/agent/version');
    const { enqueue } = await import('@/lib/queue');
    const app = 'k'.repeat(43);
    const version = EXPECTED_EXTENSION_VERSION;
    const payload = { operationId: 'diag:desktop', taskId: null, stageKey: 'DIAGNOSTIC', prompt: 'Reply with OK', promptHash: 'h', conversationUrl: null, newChat: true, attachments: [], expectImages: false, timeoutSec: 60, language: 'en' };
    const { job } = await enqueue({ queue: 'chatgpt', kind: 'chatgpt.diagnostic', idempotencyKey: 'chatgpt:diag:desktop', priority: 100, maxAttempts: 2, payload });
    process.env.BAS_DESKTOP_AGENT_KEY = app;
    try {
      const appHello = { action: 'hello', installId: 'desktop-app', version };
      // The app's key works only with its install id, and the extension's key never with it.
      expect((await handler.handleAgentRequest(req(appHello, { key: app, origin: null }))).status).toBe(200);
      expect((await handler.handleAgentRequest(req({ action: 'hello', installId: 'inst-3', version }, { key: app }))).status).toBe(403);
      expect((await handler.handleAgentRequest(req(appHello))).status).toBe(403);
      expect((await handler.handleAgentRequest(req(appHello, { key: 'x'.repeat(43), origin: null }))).status).toBe(401);
      // While the app is connected, Automation Chrome's extension is told so and gets no prompt.
      const extHello = (await (await handler.handleAgentRequest(req({ action: 'hello', installId: 'inst-3', version }))).json()) as { config: { chatgptInApp: boolean } };
      expect(extHello.config.chatgptInApp).toBe(true);
      const refused = (await (await handler.handleAgentRequest(req({ action: 'claim', installId: 'inst-3', tabId: '17' }))).json()) as { job: null; reason: string };
      expect(refused).toMatchObject({ job: null, reason: 'in-app' });
      // The app gets it; Search Console requests are never handed to the app.
      const claimed = (await (await handler.handleAgentRequest(req({ action: 'claim', installId: 'desktop-app', tabId: 'app-1' }, { key: app, origin: null }))).json()) as { job: { id: string } | null };
      expect(claimed.job?.id).toBe(job.id);
      const gsc = (await (await handler.handleAgentRequest(req({ action: 'gsc-claim', installId: 'desktop-app' }, { key: app, origin: null }))).json()) as { job: null; reason: string };
      expect(gsc).toMatchObject({ job: null, reason: 'not-here' });
      // Gone for 75 s+ (app closed): the extension takes ChatGPT again.
      await client.workerStatus.update({ where: { id: 'extension:desktop-app' }, data: { lastSeenAt: new Date(Date.now() - 80_000) } });
      const again = (await (await handler.handleAgentRequest(req({ action: 'hello', installId: 'inst-3', version }))).json()) as { config: { chatgptInApp: boolean } };
      expect(again.config.chatgptInApp).toBe(false);
      // Paused in the app (ChatGPT switched to Automation Chrome): at once.
      await handler.handleAgentRequest(req({ ...appHello, claimsPaused: true }, { key: app, origin: null }));
      const paused = (await (await handler.handleAgentRequest(req({ action: 'hello', installId: 'inst-3', version }))).json()) as { config: { chatgptInApp: boolean } };
      expect(paused.config.chatgptInApp).toBe(false);
    } finally {
      delete process.env.BAS_DESKTOP_AGENT_KEY;
    }
    // Without the app (npm run start:all), nobody can use its install id.
    expect((await handler.handleAgentRequest(req({ action: 'hello', installId: 'desktop-app', version }, { key: app, origin: null }))).status).toBe(401);
  });

  it('answers CORS preflight only for extension origins', async () => {
    const pre = await handler.handleAgentRequest(new Request('http://127.0.0.1:3000/api/extension/agent', { method: 'OPTIONS', headers: { origin: EXT, host: '127.0.0.1:3000' } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(EXT);
    const evil = await handler.handleAgentRequest(new Request('http://127.0.0.1:3000/api/extension/agent', { method: 'OPTIONS', headers: { origin: 'https://evil.example', host: '127.0.0.1:3000' } }));
    expect(evil.headers.get('access-control-allow-origin')).toBeNull();
  });
});
