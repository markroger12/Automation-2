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
  onMessage: (msg: unknown, tabId?: string) => Promise<unknown>;
  onPortOpen: (id: string, name: string, tabId?: string) => void;
  onPortMessage: (id: string, msg: unknown, tabId?: string) => void;
  status: () => { connected: boolean; paused: boolean };
  capabilities: () => string[];
  isIdle: (tabId: string, ms?: number) => boolean;
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

/** Several tabs (owner report 2026-11-08: the app ran one prompt at a time): a fake pool of ChatGPT pages. */
function poolHarness(opts: { config?: Record<string, unknown>; jobs?: string[]; pageState?: string } = {}) {
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  const queue = [...(opts.jobs ?? [])];
  let config: Record<string, unknown> = { pollIdleSec: 30, pollBusySec: 3, maxTabs: 3, wantedTabs: 3, waitingJobs: queue.length, ...(opts.config ?? {}) };
  let pageState = opts.pageState ?? 'ready';
  let stored: Record<string, unknown> = {};
  const open: string[] = ['app-1'];
  const urls: Record<string, string> = { 'app-1': 'https://chatgpt.com/' };
  const runs: { id: string; jobId: string }[] = [];
  const posts: { id: string; portId: string; msg: unknown }[] = [];
  const closed: string[] = [];
  const reloads: string[] = [];
  let next = 2;
  const agent = createChatGPTAgent({
    origin: () => 'http://127.0.0.1:3999',
    key: 'k'.repeat(43),
    version: '3.5.5',
    pool: {
      ids: () => [...open],
      open: (url: string) => {
        const id = `app-${next++}`;
        open.push(id);
        urls[id] = url;
        return id;
      },
      close: (id: string) => {
        open.splice(open.indexOf(id), 1);
        closed.push(id);
      },
      load: (id: string, url: string) => void (urls[id] = url),
      reload: (id: string) => void reloads.push(id),
      url: (id: string) => urls[id] ?? '',
      send: async (id: string, msg: { type: string; job?: { id: string } }) => {
        if (msg.type === 'ping') return { ok: true, state: pageState };
        if (msg.type === 'run') runs.push({ id, jobId: msg.job!.id });
        return { ok: true };
      },
      post: (id: string, portId: string, msg: unknown) => posts.push({ id, portId, msg }),
      front: () => {},
    },
    fetchImage: async () => ({ ok: false, status: 404, mime: '', bytes: Buffer.alloc(0) }),
    store: { read: () => stored, write: (st: Record<string, unknown>) => void (stored = JSON.parse(JSON.stringify(st))) },
    notify: () => {},
    fetch: async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      calls.push({ action: String(body.action), body });
      let answer: unknown = { ok: true };
      if (body.action === 'hello') answer = { ok: true, versionOk: true, config: { ...config, waitingJobs: queue.length } };
      if (body.action === 'claim') {
        const jobId = queue.shift();
        answer = jobId ? { job: { id: jobId, operationId: `op-${jobId}`, newChat: true, prompt: `Prompt ${jobId}` } } : { job: null, reason: 'empty' };
      }
      return new Response(JSON.stringify(answer), { status: 200 });
    },
  }) as Agent & { onTabGone: (id: string) => Promise<void>; status: () => { busyTabs: number; tabs: number; busy: boolean } };
  /** A tab's page has loaded and its scripts announced themselves. */
  const ready = (id: string) => agent.onMessage({ type: 'content-ready', url: urls[id] ?? 'https://chatgpt.com/' }, id);
  return { agent, calls, open, runs, posts, closed, reloads, ready, setConfig: (c: Record<string, unknown>) => void (config = { ...config, ...c }), setPage: (st: string) => void (pageState = st), store: () => stored, add: (...jobs: string[]) => queue.push(...jobs) };
}

describe("the desktop app's ChatGPT tabs: several prompts at once", () => {
  it('three prompts wait: app-2 and app-3 open one per round, and each tab runs its own prompt at the same time', async () => {
    const h = poolHarness({ jobs: ['job-1', 'job-2', 'job-3'] });
    await h.agent.start();
    await h.ready('app-1');
    await h.agent.tick();
    // One new tab per round, and the first tab takes the first prompt.
    expect(h.open).toEqual(['app-1', 'app-2']);
    expect(h.calls.filter((c) => c.action === 'claim').map((c) => c.body.tabId)).toEqual(['app-1']);
    await h.ready('app-1'); // the page is at the new chat
    await vi.waitFor(() => expect(h.runs).toEqual([{ id: 'app-1', jobId: 'job-1' }]));
    await h.ready('app-2');
    await h.agent.tick();
    expect(h.open).toEqual(['app-1', 'app-2', 'app-3']);
    await h.ready('app-2');
    await h.ready('app-3');
    await h.agent.tick();
    await h.ready('app-3');
    await vi.waitFor(() => expect(h.runs).toEqual([{ id: 'app-1', jobId: 'job-1' }, { id: 'app-2', jobId: 'job-2' }, { id: 'app-3', jobId: 'job-3' }]));
    expect(h.agent.status()).toMatchObject({ busy: true, busyTabs: 3, tabs: 3 });
    // The dashboard sees every tab with its prompt.
    await h.agent.tick();
    const hello = h.calls.filter((c) => c.action === 'hello').at(-1)!;
    expect(hello.body.tabs).toEqual([
      { tabId: 'app-1', url: 'https://chatgpt.com/', state: 'busy', jobId: 'job-1' },
      { tabId: 'app-2', url: 'https://chatgpt.com/', state: 'busy', jobId: 'job-2' },
      { tabId: 'app-3', url: 'https://chatgpt.com/', state: 'busy', jobId: 'job-3' },
    ]);
    // The pages' channels are told apart by tab, also with the same channel name.
    h.agent.onPortOpen('p1', 'bas-job:job-1', 'app-1');
    h.agent.onPortOpen('p1', 'bas-job:job-2', 'app-2');
    h.agent.onPortMessage('p1', { type: 'complete', text: 'Answer two' }, 'app-2');
    await vi.waitFor(() => expect(h.calls.find((c) => c.action === 'complete')?.body).toMatchObject({ tabId: 'app-2', jobId: 'job-2', text: 'Answer two' }));
    expect(h.agent.status()).toMatchObject({ busyTabs: 2 });
    h.agent.onPortMessage('p1', { type: 'progress', step: 'typing' }, 'app-1');
    await vi.waitFor(() => expect(h.calls.find((c) => c.action === 'progress')?.body).toMatchObject({ tabId: 'app-1', jobId: 'job-1' }));
    // Quit: every prompt in progress goes back to the queue with its own tab (also after the window closed the tabs).
    h.open.splice(0);
    await h.agent.stop();
    expect(h.calls.filter((c) => c.action === 'release').map((c) => [c.body.tabId, c.body.jobId])).toEqual([
      ['app-1', 'job-1'],
      ['app-3', 'job-3'],
    ]);
  });

  it('never more tabs than the dashboard allows; none while ChatGPT asks to sign in or shows a check', async () => {
    const h = poolHarness({ jobs: ['a', 'b', 'c', 'd', 'e', 'f'], config: { maxTabs: 2, wantedTabs: 2 } });
    h.setPage('login');
    await h.agent.start();
    await h.ready('app-1');
    await h.agent.tick();
    expect(h.open).toEqual(['app-1']); // signed out: the owner signs in in app-1 first
    h.setPage('challenge');
    await h.agent.tick();
    expect(h.open).toEqual(['app-1']);
    // Signed in: app-1's page is ready again (its prompt runs), then more tabs, up to what is allowed.
    h.setPage('ready');
    await h.ready('app-1');
    await h.agent.tick();
    expect(h.open).toEqual(['app-1', 'app-2']);
    await h.ready('app-2');
    await h.agent.tick();
    await h.ready('app-2');
    await h.agent.tick();
    expect(h.open).toEqual(['app-1', 'app-2']); // Settings → ChatGPT tabs (and the slots) allow 2
    expect(h.agent.status()).toMatchObject({ busyTabs: 2, tabs: 2 });
    // The tab bar marks each working ChatGPT tab (owner request 2026-11-12: tabs as in Chrome).
    expect((h.agent.status() as unknown as { busyIds: string[] }).busyIds).toEqual(['app-1', 'app-2']);
    await h.agent.stop();
  });

  it('owner report (2026-11-12): a stuck tab — no progress for 3 minutes → loaded again; still none → its prompt goes back to the queue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = poolHarness({ jobs: ['job-s'], config: { maxTabs: 1, wantedTabs: 1 } });
    await h.agent.start();
    await h.ready('app-1');
    await h.agent.tick();
    await h.ready('app-1');
    await vi.waitFor(() => expect(h.runs).toEqual([{ id: 'app-1', jobId: 'job-s' }]));
    const minutes = (n: number) => vi.setSystemTime(Date.now() + n * 60_000);
    // Progress keeps it alive (the prompt was sent: its checkpoint says so).
    minutes(2);
    await h.agent.onMessage({ type: 'checkpoint', jobId: 'job-s', step: 'sent', sentAt: new Date().toISOString(), userTurnsBefore: 0 }, 'app-1');
    h.agent.onPortOpen('p1', 'bas-job:job-s', 'app-1');
    h.agent.onPortMessage('p1', { type: 'progress', step: 'generating (120 chars so far)' }, 'app-1');
    minutes(2);
    await h.agent.tick();
    expect(h.reloads).toEqual([]);
    // 3 minutes without a word: the page is loaded again (the prompt is looked for there, never sent twice).
    minutes(1.5);
    await h.agent.tick();
    expect(h.reloads).toEqual(['app-1']);
    expect(h.agent.status()).toMatchObject({ busyTabs: 1 });
    // Still nothing: the prompt, maybe sent, is held as uncertain (checked before any resend), the tab is free.
    minutes(3.5);
    await h.agent.tick();
    await vi.waitFor(() => expect(h.calls.find((c) => c.action === 'fail')?.body).toMatchObject({ tabId: 'app-1', jobId: 'job-s', uncertain: true }));
    expect(h.reloads).toEqual(['app-1', 'app-1']);
    expect(h.agent.status()).toMatchObject({ busyTabs: 0 });
    await h.agent.stop();
  });

  it('a stuck prompt that was never sent goes back to the queue (not held for a check)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = poolHarness({ jobs: ['job-n'], config: { maxTabs: 1, wantedTabs: 1 } });
    await h.agent.start();
    await h.ready('app-1');
    await h.agent.tick();
    await h.ready('app-1');
    await vi.waitFor(() => expect(h.runs).toEqual([{ id: 'app-1', jobId: 'job-n' }]));
    vi.setSystemTime(Date.now() + 3.5 * 60_000);
    await h.agent.tick();
    expect(h.reloads).toEqual(['app-1']);
    vi.setSystemTime(Date.now() + 3.5 * 60_000);
    await h.agent.tick();
    await vi.waitFor(() => expect(h.calls.find((c) => c.action === 'fail')?.body).toMatchObject({ tabId: 'app-1', jobId: 'job-n', uncertain: false }));
    expect(h.agent.status()).toMatchObject({ busyTabs: 0 });
    await h.agent.stop();
  });

  it('memory saver: a tab counts as idle only with no prompt, no job channel and nothing waiting', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = poolHarness({ jobs: ['job-i'], config: { maxTabs: 1, wantedTabs: 1 } });
    await h.agent.start();
    await h.ready('app-1');
    await h.agent.tick();
    await h.ready('app-1');
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect(h.agent.isIdle('app-1', 0)).toBe(false); // working on its prompt
    expect(h.agent.isIdle('app-9', 0)).toBe(false); // no such tab
    await h.agent.stop();
    const fresh = poolHarness({ jobs: [], config: { maxTabs: 1, wantedTabs: 1 } });
    await fresh.agent.start();
    await fresh.ready('app-1');
    await fresh.agent.tick();
    expect(fresh.agent.isIdle('app-1', 5 * 60_000)).toBe(false); // not long enough
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(fresh.agent.isIdle('app-1', 5 * 60_000)).toBe(true);
    await fresh.agent.stop();
  });

  it('never while ChatGPT waits for the owner (sign-in or check)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = poolHarness({ jobs: ['job-h'], config: { maxTabs: 1, wantedTabs: 1 } });
    await h.agent.start();
    await h.ready('app-1');
    await h.agent.tick();
    await h.ready('app-1');
    await vi.waitFor(() => expect(h.runs).toHaveLength(1));
    h.agent.onPortOpen('p1', 'bas-job:job-h', 'app-1');
    const hellos = h.calls.filter((c) => c.action === 'hello').length;
    h.agent.onPortMessage('p1', { type: 'needs-human', kind: 'challenge', message: 'ChatGPT shows a check.' }, 'app-1');
    // The owner is told (the agent says hello at once): from now on the tab waits for them.
    await vi.waitFor(() => expect(h.calls.filter((c) => c.action === 'hello').length).toBeGreaterThan(hellos));
    vi.setSystemTime(Date.now() + 20 * 60_000);
    await h.agent.tick();
    expect(h.reloads).toEqual([]);
    expect(h.calls.some((c) => c.action === 'fail')).toBe(false);
    await h.agent.stop();
  });

  it('an extra tab with nothing to do closes after 10 minutes (app-1 never); at once when the setting is lowered', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = poolHarness({ jobs: ['x'] });
    await h.agent.start();
    await h.ready('app-1');
    await h.agent.tick();
    expect(h.open).toEqual(['app-1', 'app-2']);
    await h.ready('app-2');
    vi.setSystemTime(Date.now() + 4 * 60_000);
    await h.agent.tick();
    expect(h.closed).toEqual([]);
    // Owner request (2026-11-12, less RAM): an extra tab with nothing to do closes after 5 minutes.
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await h.agent.tick();
    expect(h.closed).toEqual(['app-2']);
    expect(h.open).toEqual(['app-1']);
    // More prompts: tabs again; the owner lowers Settings → ChatGPT tabs to 1: the idle extra tab closes at once.
    h.add('y1', 'y2', 'y3');
    await h.agent.tick();
    expect(h.open).toEqual(['app-1', 'app-3']);
    await h.ready('app-3');
    h.setConfig({ maxTabs: 1, wantedTabs: 1 });
    await h.agent.tick();
    await h.agent.tick();
    expect(h.closed).toEqual(['app-2', 'app-3']);
    await h.agent.stop();
  });
});

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

/** Owner (2026-11-12): signed in to Google in the app's Search Console tab — the app makes the indexing requests. */
describe("the desktop app's Search Console tab: indexing requests", () => {
  function gscHarness(opts: { job?: Record<string, unknown> | null } = {}) {
    const calls: { action: string; body: Record<string, unknown>; path: string }[] = [];
    let stored: Record<string, unknown> = {};
    const loads: string[] = [];
    const sent: Record<string, unknown>[] = [];
    let fronts = 0;
    const notes: string[] = [];
    let job = opts.job === undefined ? { id: 'gsc-1', url: 'https://site.example/post/', property: 'sc-domain:site.example', inspectUrl: 'https://search.google.com/search-console?resource_id=sc-domain%3Asite.example', altUrl: null } : opts.job;
    const agent = createChatGPTAgent({
      origin: () => 'http://127.0.0.1:3999',
      key: 'k'.repeat(43),
      version: '3.5.5',
      tab: { load: () => {}, reload: () => {}, url: () => 'https://chatgpt.com/', send: async () => ({ ok: true, state: 'ready' }), post: () => {}, front: () => {} },
      gsc: {
        load: (u: string) => loads.push(u),
        send: async (msg: Record<string, unknown>) => (sent.push(msg), { ok: true }),
        url: () => loads.at(-1) ?? '',
        saveProof: async () => Buffer.from('From: <Saved by Blink>\r\nMIME-Version: 1.0\r\n').toString('base64'),
      },
      gscFront: () => void fronts++,
      fetchImage: async () => ({ ok: false, status: 404, mime: '', bytes: Buffer.alloc(0) }),
      store: { read: () => stored, write: (st: Record<string, unknown>) => void (stored = JSON.parse(JSON.stringify(st))) },
      notify: (title: string) => notes.push(title),
      fetch: async (url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        calls.push({ action: String(body.action), body, path: new URL(url).pathname });
        let answer: unknown = { ok: true };
        if (body.action === 'hello') answer = { ok: true, versionOk: true, config: { pollIdleSec: 30, pollBusySec: 3, gscWaiting: job ? 1 : 0, humanCheckPauseMinutes: 10 } };
        if (body.action === 'claim') answer = { job: null, reason: 'empty' };
        if (body.action === 'gsc-claim') {
          answer = { job };
          job = null;
        }
        return new Response(JSON.stringify(answer), { status: 200 });
      },
    }) as Agent & { onGscMessage: (m: unknown) => Promise<unknown>; onGscNavigate: (u: string) => void };
    return { agent, calls, loads, sent, notes, fronts: () => fronts };
  }

  it('says it makes the requests; claims one, opens the property, hands the job to the page, saves the proof first, reports', async () => {
    const h = gscHarness();
    await h.agent.start();
    const hello = h.calls.find((c) => c.action === 'hello')!;
    expect(hello.body.capabilities).toContain('gsc-request-indexing');
    expect(h.agent.capabilities()).toEqual(hello.body.capabilities);
    expect(hello.body.diagnostics).toMatchObject({ searchConsole: true });
    await vi.waitFor(() => expect(h.loads).toEqual(['https://search.google.com/search-console?resource_id=sc-domain%3Asite.example']));
    // The page's script announces itself: it gets the job (the URL to type).
    await h.agent.onGscMessage({ type: 'gsc-ready', url: h.loads[0] });
    await vi.waitFor(() => expect(h.sent).toEqual([{ type: 'gsc-run', jobId: 'gsc-1', typeUrl: 'https://site.example/post/', altUrl: null, attempt: 1, humanWaitMs: 600000 }]));
    await h.agent.onGscMessage({ type: 'gsc-done', jobId: 'gsc-1', outcome: 'REQUESTED', message: 'Indexing requested', shown: 'shown', pageCopy: '{"kind":"search-console"}' });
    await vi.waitFor(() => expect(h.calls.some((c) => c.action === 'gsc-result')).toBe(true));
    const proof = h.calls.findIndex((c) => c.action === 'gsc-proof');
    const result = h.calls.findIndex((c) => c.action === 'gsc-result');
    expect(proof).toBeGreaterThan(-1);
    expect(proof).toBeLessThan(result);
    expect(h.calls[proof]).toMatchObject({ path: '/api/extension/gsc-proof', body: { jobId: 'gsc-1', installId: 'desktop-app' } });
    expect(h.calls[result].body).toMatchObject({ jobId: 'gsc-1', outcome: 'REQUESTED', message: 'Indexing requested', pageCopy: '{"kind":"search-console"}' });
    await h.agent.stop();
  });

  it("a sign-in page ends the request as NOT_SIGNED_IN; Google's check brings the tab to the front and tells the owner", async () => {
    const h = gscHarness();
    await h.agent.start();
    await vi.waitFor(() => expect(h.loads).toHaveLength(1));
    await h.agent.onGscMessage({ type: 'gsc-check', jobId: 'gsc-1' });
    expect(h.fronts()).toBe(1);
    expect(h.notes).toEqual(['Search Console wants a check']);
    h.agent.onGscNavigate('https://accounts.google.com/v3/signin/identifier?continue=x');
    await vi.waitFor(() => expect(h.calls.find((c) => c.action === 'gsc-result')?.body).toMatchObject({ jobId: 'gsc-1', outcome: 'NOT_SIGNED_IN' }));
    expect(h.calls.some((c) => c.action === 'gsc-proof')).toBe(false); // no proof without a request
    await h.agent.stop();
  });

  it('without the Search Console tab the app does not say it makes requests and never claims one', async () => {
    const h = harness();
    await h.agent.start();
    await vi.waitFor(() => expect(h.calls.some((c) => c.action === 'hello')).toBe(true));
    expect(h.calls[0].body.capabilities).not.toContain('gsc-request-indexing');
    expect(h.agent.capabilities()).not.toContain('gsc-request-indexing');
    expect(h.calls.some((c) => c.action === 'gsc-claim')).toBe(false);
    await h.agent.stop();
  });
});
