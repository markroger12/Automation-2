import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The desktop app's ChatGPT agent (desktop/chatgpt-agent.cjs) with a fake tab and a fake dashboard: the parts that do
 * not need a page (the page itself runs in tests/integration/desktop-chatgpt.test.ts).
 */
const require = createRequire(import.meta.url);
const { createChatGPTAgent } = require(path.resolve(__dirname, '..', '..', 'desktop', 'chatgpt-agent.cjs')) as { createChatGPTAgent: (deps: Record<string, unknown>) => Agent };

interface Agent {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  tick: () => Promise<void>;
  setPaused: (v: boolean) => Promise<void>;
  onMessage: (msg: unknown) => Promise<unknown>;
  onPortOpen: (id: string, name: string) => void;
  onPortMessage: (id: string, msg: unknown) => void;
  status: () => { connected: boolean; paused: boolean };
}

function harness(opts: { url?: string; down?: boolean; claim?: unknown } = {}) {
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  let down = Boolean(opts.down);
  let stored: Record<string, unknown> = {};
  const tab = { url: opts.url ?? 'https://chatgpt.com/', reloads: 0, loads: [] as string[] };
  const agent = createChatGPTAgent({
    origin: () => 'http://127.0.0.1:3999',
    key: 'k'.repeat(43),
    version: '3.4.6',
    tab: { load: (u: string) => tab.loads.push(u), reload: () => tab.reloads++, url: () => tab.url, send: async () => ({ ok: true, state: 'ready' }), post: () => {}, front: () => {} },
    fetchImage: async () => ({ ok: false, status: 404, mime: '', bytes: Buffer.alloc(0) }),
    store: { read: () => stored, write: (s: Record<string, unknown>) => void (stored = JSON.parse(JSON.stringify(s))) },
    notify: () => {},
    fetch: async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ action: String(body.action), body });
      if (down) throw new TypeError('fetch failed');
      const answer = body.action === 'hello' ? { ok: true, versionOk: true, config: { pollIdleSec: 30, pollBusySec: 3 } } : body.action === 'claim' ? (opts.claim ?? { job: null, reason: 'empty' }) : { ok: true };
      return new Response(JSON.stringify(answer), { status: 200 });
    },
  });
  return { agent, calls, tab, store: () => stored, setDown: (v: boolean) => void (down = v) };
}

afterEach(() => vi.useRealTimers());

describe("the desktop app's ChatGPT agent", () => {
  it("never reloads OpenAI's sign-in page (the owner may be typing); a ChatGPT page that never got ready is reloaded", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const signIn = harness({ url: 'https://auth.openai.com/log-in' });
    await signIn.agent.start();
    vi.setSystemTime(Date.now() + 60_000);
    await signIn.agent.tick();
    expect(signIn.tab.reloads).toBe(0);
    await signIn.agent.stop();

    const stuck = harness({ url: 'https://chatgpt.com/' });
    await stuck.agent.start();
    vi.setSystemTime(Date.now() + 60_000);
    await stuck.agent.tick();
    expect(stuck.tab.reloads).toBe(1);
    await stuck.agent.stop();
  });

  it('says hello with its own install id, and only claims on a ready ChatGPT page', async () => {
    const h = harness();
    await h.agent.start();
    await vi.waitFor(() => expect(h.calls.some((c) => c.action === 'hello')).toBe(true));
    expect(h.calls[0].body).toMatchObject({ action: 'hello', installId: 'desktop-app', version: '3.4.6' });
    expect(h.calls.some((c) => c.action === 'claim')).toBe(false); // the page has not announced itself yet
    await h.agent.onMessage({ type: 'content-ready', url: 'https://chatgpt.com/' });
    await h.agent.tick();
    expect(h.calls.some((c) => c.action === 'claim' && c.body.tabId === 'app-1')).toBe(true);
    await h.agent.stop();
  });

  it('an answer the dashboard could not take waits on disk and goes out later, once', async () => {
    const h = harness({ down: true });
    h.agent.onPortOpen('p1', 'bas-job:job-1');
    h.agent.onPortMessage('p1', { type: 'complete', text: 'The answer', conversationUrl: 'https://chatgpt.com/c/11111111-2222-4333-8444-555555555555' });
    await vi.waitFor(() => expect((h.store().outbox as unknown[]).length).toBe(1));
    h.setDown(false);
    await h.agent.start();
    await vi.waitFor(() => expect(h.calls.filter((c) => c.action === 'complete' && c.body.text === 'The answer')).toHaveLength(2)); // one failed while down, one delivered
    await vi.waitFor(() => expect(h.store().outbox).toEqual([]));
    await h.agent.stop();
  });

  it('a job left from an app closed mid-job goes back to the queue at start (it is reconciled, never sent twice)', async () => {
    const h = harness();
    h.agent.onPortOpen('p1', 'bas-job:job-7');
    // The page recorded the send, then the app was closed.
    await h.agent.onMessage({ type: 'checkpoint', jobId: 'job-7', step: 'sent', sentAt: '2026-10-23T10:00:00.000Z' });
    expect(Object.keys(h.store().checkpoints as object)).toEqual(['job-7']);
    const next = harness();
    // The same file on disk, read by the app's next start.
    const saved = h.store();
    const again = createChatGPTAgent({ ...(next as unknown as { agent: unknown }), origin: () => 'http://127.0.0.1:3999', key: 'k'.repeat(43), version: '3.4.6', tab: { load: () => {}, reload: () => {}, url: () => 'https://chatgpt.com/', send: async () => null, post: () => {}, front: () => {} }, fetchImage: async () => ({}), store: { read: () => saved, write: (s: Record<string, unknown>) => Object.assign(saved, s) }, notify: () => {}, fetch: async (_u: string, init: { body: string }) => (next.calls.push({ action: JSON.parse(init.body).action, body: JSON.parse(init.body) }), new Response('{"ok":true}', { status: 200 })) });
    await again.start();
    expect(next.calls.find((c) => c.action === 'release')?.body).toMatchObject({ jobId: 'job-7', tabId: 'app-1' });
    expect(saved.checkpoints).toEqual({});
    await again.stop();
  });

  it('switched to Automation Chrome by the owner: says so to the dashboard at once (claimsPaused) and claims nothing', async () => {
    const h = harness();
    await h.agent.start();
    await h.agent.onMessage({ type: 'content-ready', url: 'https://chatgpt.com/' });
    h.calls.length = 0;
    await h.agent.setPaused(true);
    expect(h.calls[0]).toMatchObject({ action: 'hello', body: { claimsPaused: true } });
    await h.agent.tick();
    expect(h.calls.some((c) => c.action === 'claim')).toBe(false);
    expect(h.agent.status().paused).toBe(true);
    await h.agent.stop();
  });
});
