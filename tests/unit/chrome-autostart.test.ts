import { spawn } from 'node:child_process';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { setupTestDb } from '../helpers/test-db';

/** Automation Chrome follows the queue (owner request): opened when an article is queued, closed when it is done. */
let client: PrismaClient;
let auto: typeof import('@/worker/chrome-autostart');
type Deps = import('@/worker/chrome-autostart').AutostartDeps;
type State = import('@/worker/chrome-autostart').AutoChromeState;

beforeAll(async () => {
  ({ client } = await setupTestDb());
  auto = await import('@/worker/chrome-autostart');
});
beforeEach(() => auto.resetAutostart());

const at = (min: number) => () => new Date(Date.parse('2026-10-16T10:00:00Z') + min * 60_000);

function harness(over: Partial<Deps> = {}) {
  const calls = { launched: 0, closed: [] as number[] };
  let state: State | null = null;
  let running = false;
  const work = { needsChrome: true, busy: true, waitingPrompts: 1 };
  const deps: Deps = {
    now: at(0),
    settings: async () => ({ open: true, close: true }),
    work: async () => ({ ...work }),
    extensionConnected: async () => false,
    chromeRunning: () => running,
    launch: () => {
      calls.launched++;
      running = true;
      return { pid: 4242 };
    },
    close: async (pid) => {
      calls.closed.push(pid);
      running = false;
      return { closed: true, detail: `Chrome PID ${pid} closed.` };
    },
    store: { read: () => state, write: (s) => void (state = s) },
    ...over,
  };
  return { deps, calls, work, setRunning: (r: boolean) => void (running = r), state: () => state };
}

describe('Automation Chrome follows the queue', () => {
  it('opens when an article is queued, stays open while work runs, and closes 2 minutes after the queue is done', async () => {
    const h = harness();
    expect(await auto.chromeAutostartTick(h.deps)).toBe('launched');
    expect(h.state()).toMatchObject({ pid: 4242 });
    // The extension connects and the article runs.
    expect(await auto.chromeAutostartTick({ ...h.deps, now: at(1), extensionConnected: async () => true })).toBe('connected');
    // Article done: nothing queued, nothing running.
    Object.assign(h.work, { needsChrome: false, busy: false, waitingPrompts: 0 });
    expect(await auto.chromeAutostartTick({ ...h.deps, now: at(10) })).toBe('waiting-to-close');
    expect(await auto.chromeAutostartTick({ ...h.deps, now: at(11) })).toBe('waiting-to-close');
    expect(h.calls.closed).toEqual([]);
    expect(await auto.chromeAutostartTick({ ...h.deps, now: at(12) })).toBe('closed');
    expect(h.calls.closed).toEqual([4242]);
    expect(h.state()).toBeNull();
    expect(await client.log.count({ where: { message: { startsWith: 'Automation Chrome closed automatically: the queue is done' } } })).toBe(1);
  });

  it('a new article during the 2 idle minutes keeps it open', async () => {
    const h = harness();
    await auto.chromeAutostartTick(h.deps);
    Object.assign(h.work, { needsChrome: false, busy: false });
    expect(await auto.chromeAutostartTick({ ...h.deps, now: at(5) })).toBe('waiting-to-close');
    Object.assign(h.work, { needsChrome: true, busy: true });
    expect(await auto.chromeAutostartTick({ ...h.deps, now: at(6), extensionConnected: async () => true })).toBe('connected');
    Object.assign(h.work, { needsChrome: false, busy: false });
    expect(await auto.chromeAutostartTick({ ...h.deps, now: at(7) })).toBe('waiting-to-close'); // the idle clock starts again
    expect(await auto.chromeAutostartTick({ ...h.deps, now: at(8) })).toBe('waiting-to-close');
    expect(h.calls.closed).toEqual([]);
  });

  it('never closes a Chrome the owner opened, and forgets one the owner closed', async () => {
    const h = harness();
    h.setRunning(true); // opened by the owner (button or by hand)
    expect(await auto.chromeAutostartTick(h.deps)).toBe('running');
    Object.assign(h.work, { needsChrome: false, busy: false });
    expect(await auto.chromeAutostartTick({ ...h.deps, now: at(10) })).toBe('idle');
    expect(await auto.chromeAutostartTick({ ...h.deps, now: at(20) })).toBe('idle');
    expect(h.calls.closed).toEqual([]);
    // Opened by the worker, then closed by the owner while work remains: forgotten, reopened after the cooldown.
    const g = harness();
    await auto.chromeAutostartTick(g.deps);
    g.setRunning(false);
    expect(await auto.chromeAutostartTick({ ...g.deps, now: at(1) })).toBe('cooldown');
    expect(g.state()).toBeNull();
    expect(await auto.chromeAutostartTick({ ...g.deps, now: at(4) })).toBe('launched');
  });

  it('a prompt stuck although Chrome runs (closed window, Chrome in the background): opens a ChatGPT window in it, once per prompt', async () => {
    const opened: (boolean | undefined)[] = [];
    const h = harness({ launch: (o) => (opened.push(o?.allowRunning), { pid: null }), extensionConnected: async () => true });
    h.setRunning(true);
    Object.assign(h.work, { stalledPromptId: 'job-1' });
    expect(await auto.chromeAutostartTick(h.deps)).toBe('launched');
    expect(opened).toEqual([true]);
    expect(await auto.chromeAutostartTick({ ...h.deps, now: at(5) })).toBe('connected'); // not again for the same prompt
    Object.assign(h.work, { stalledPromptId: 'job-2' });
    expect(await auto.chromeAutostartTick({ ...h.deps, now: at(6) })).toBe('launched');
    expect(opened).toEqual([true, true]);
    expect(await client.log.count({ where: { message: { contains: 'a ChatGPT window was opened in it' } } })).toBe(2);
  });

  it('says once in Logs why Chrome was not opened for waiting work', async () => {
    const count = () => client.log.count({ where: { message: { startsWith: 'Automation Chrome not opened automatically: it is already running' } } });
    const before = await count();
    const h = harness();
    h.setRunning(true);
    expect(await auto.chromeAutostartTick(h.deps)).toBe('running');
    expect(await auto.chromeAutostartTick({ ...h.deps, now: at(1) })).toBe('running');
    expect((await count()) - before).toBe(1);
  });

  it('does nothing when switched off, without work, or with a connected extension; a failing launch waits for the cooldown', async () => {
    const off = harness({ settings: async () => ({ open: false, close: false }) });
    expect(await auto.chromeAutostartTick(off.deps)).toBe('disabled');
    const idle = harness();
    Object.assign(idle.work, { needsChrome: false, busy: false });
    expect(await auto.chromeAutostartTick(idle.deps)).toBe('idle');
    const connected = harness({ extensionConnected: async () => true });
    expect(await auto.chromeAutostartTick(connected.deps)).toBe('connected');
    expect(off.calls.launched + idle.calls.launched + connected.calls.launched).toBe(0);
    const broken = harness({ launch: () => { throw new Error('Google Chrome was not found.'); } });
    expect(await auto.chromeAutostartTick(broken.deps)).toBe('failed');
    expect(await auto.chromeAutostartTick(broken.deps)).toBe('cooldown');
    expect(await client.log.count({ where: { message: { contains: 'could not be opened automatically: Google Chrome was not found' } } })).toBe(1);
  });

  it('reads the real queue: a queued article needs Chrome; both switches are on by default', async () => {
    const { getSettings } = await import('@/lib/settings');
    const b = (await getSettings()).browser;
    expect([b.autoLaunchChatGPTChrome, b.autoCloseChatGPTChrome]).toEqual([true, true]);
    expect(await auto.currentWork()).toEqual({ needsChrome: false, busy: false, waitingPrompts: 0, stalledPromptId: null, stalledRequestId: null });
    const job = await client.queueJob.create({ data: { queue: 'chatgpt', kind: 'chatgpt.prompt', idempotencyKey: 'autostart:1', payload: '{}', status: 'WAITING', runAt: new Date(Date.now() - 1000) } });
    expect(await auto.currentWork()).toEqual({ needsChrome: true, busy: true, waitingPrompts: 1, stalledPromptId: null, stalledRequestId: null });
    // Nobody picked it up for 2 minutes, nothing else runs, no usage-limit wait: stuck.
    await client.queueJob.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 120_000) } });
    expect((await auto.currentWork()).stalledPromptId).toBe(job.id);
    const { recordRateLimit, clearBackoff } = await import('@/lib/chatgpt/rate');
    await recordRateLimit({ reason: 'test limit' });
    expect((await auto.currentWork()).stalledPromptId).toBeNull(); // a usage-limit wait is not “stuck”
    await clearBackoff();
    await client.queueJob.updateMany({ where: { idempotencyKey: 'autostart:1' }, data: { status: 'ACTIVE' } });
    expect(await auto.currentWork()).toEqual({ needsChrome: false, busy: true, waitingPrompts: 0, stalledPromptId: null, stalledRequestId: null }); // answering: keep it open
  });
});

describe('owner report: indexing waited until the owner opened Automation Chrome', () => {
  it('a due Search Console request nobody picks up for 90 s while none runs is stuck; one being made is not', async () => {
    await client.queueJob.deleteMany({});
    const job = await client.queueJob.create({ data: { queue: 'gsc', kind: 'gsc.request-indexing', idempotencyKey: 'autostart:gsc-1', payload: '{}', status: 'WAITING', runAt: new Date(Date.now() - 1000) } });
    expect(await auto.currentWork()).toMatchObject({ needsChrome: true, busy: true, stalledRequestId: null });
    await client.queueJob.update({ where: { id: job.id }, data: { runAt: new Date(Date.now() - 120_000) } });
    expect((await auto.currentWork()).stalledRequestId).toBe(job.id);
    // Another request is being made (one at a time): the waiting one is not stuck.
    await client.queueJob.create({ data: { queue: 'gsc', kind: 'gsc.request-indexing', idempotencyKey: 'autostart:gsc-2', payload: '{}', status: 'ACTIVE', runAt: new Date(Date.now() - 200_000) } });
    expect((await auto.currentWork()).stalledRequestId).toBeNull();
    await client.queueJob.deleteMany({});
  });

  it('Chrome runs in the background without a window: a window is opened for the stuck request, once', async () => {
    const opened: (boolean | undefined)[] = [];
    const h = harness({ launch: (o) => (opened.push(o?.allowRunning), { pid: null }) });
    h.setRunning(true);
    Object.assign(h.work, { waitingPrompts: 0, stalledRequestId: 'gsc-job-1' });
    expect(await auto.chromeAutostartTick(h.deps)).toBe('launched');
    expect(opened).toEqual([true]);
    expect(await auto.chromeAutostartTick({ ...h.deps, now: at(5) })).toBe('running'); // not again for the same request
    expect(await client.log.count({ where: { message: { contains: 'A Search Console indexing request waited 90 s+' } } })).toBe(1);
  });
});

describe("the desktop app's own ChatGPT tab is connected (owner request: the browser inside the app)", () => {
  it('ChatGPT work needs no Chrome; a due Search Console request opens it as a Search Console app window', async () => {
    await client.queueJob.deleteMany({});
    await client.workerStatus.upsert({ where: { id: 'extension:desktop-app' }, create: { id: 'extension:desktop-app', kind: 'EXTENSION', version: '3.5.0', status: 'CONNECTED', lastSeenAt: new Date() }, update: { status: 'CONNECTED', lastSeenAt: new Date() } });
    try {
      await client.queueJob.create({ data: { queue: 'chatgpt', kind: 'chatgpt.prompt', idempotencyKey: 'autostart:app-1', payload: '{}', status: 'WAITING', runAt: new Date(Date.now() - 120_000) } });
      expect(await auto.currentWork()).toEqual({ needsChrome: false, busy: false, waitingPrompts: 0, stalledPromptId: null, stalledRequestId: null, chatgptInApp: true });
      const gsc = await client.queueJob.create({ data: { queue: 'gsc', kind: 'gsc.request-indexing', idempotencyKey: 'autostart:app-gsc', payload: '{}', status: 'WAITING', runAt: new Date(Date.now() - 120_000) } });
      const work = await auto.currentWork();
      expect(work).toMatchObject({ needsChrome: true, busy: true, stalledRequestId: gsc.id, chatgptInApp: true });
      // The app's agent is not Automation Chrome's extension: Chrome is still opened, as a Search Console window.
      const opens: unknown[] = [];
      const h = harness({ work: async () => work, extensionConnected: undefined, launch: (o) => (opens.push(o), { pid: 77 }) });
      expect(await auto.chromeAutostartTick(h.deps)).toBe('launched');
      expect(opens).toEqual([{ searchConsole: true }]);
      expect(await client.log.count({ where: { message: { contains: 'opened automatically for Search Console (ChatGPT runs in the desktop app' } } })).toBe(1);
      // Running without a window: a Search Console window is opened in it for the stuck request.
      auto.resetAutostart();
      const again: unknown[] = [];
      const r = harness({ work: async () => work, extensionConnected: undefined, launch: (o) => (again.push(o), { pid: null }) });
      r.setRunning(true);
      expect(await auto.chromeAutostartTick(r.deps)).toBe('launched');
      expect(again).toEqual([{ allowRunning: true, searchConsole: true }]);
    } finally {
      await client.workerStatus.delete({ where: { id: 'extension:desktop-app' } });
      await client.queueJob.deleteMany({});
    }
  });

  it('the Search Console window is Chrome itself, as an app window (--app), with the Automation Chrome profile', async () => {
    const { SEARCH_CONSOLE_URL, launchAutomationChrome } = await import('@/lib/automation-chrome');
    const before = process.env.BROWSER_EXECUTABLE_PATH;
    // A harmless program in place of Chrome: only the command line is checked.
    process.env.BROWSER_EXECUTABLE_PATH = process.execPath;
    try {
      const { command } = launchAutomationChrome(SEARCH_CONSOLE_URL, { app: true });
      expect(command).toContain('--app=https://search.google.com/search-console');
      expect(command).toMatch(/--user-data-dir=\S*chatgpt-chrome/);
      expect(command).not.toMatch(/remote-debugging|enable-automation|user-agent/);
    } finally {
      if (before === undefined) delete process.env.BROWSER_EXECUTABLE_PATH;
      else process.env.BROWSER_EXECUTABLE_PATH = before;
    }
  });
});

describe('closing the Automation Chrome', () => {
  it('asks only that browser process to close (normal shutdown signal), never another program with a reused PID', async () => {
    const { closeAutomationChrome, isAutomationChromePid } = await import('@/lib/automation-chrome');
    const { dataPaths } = await import('@/lib/paths');
    if (process.platform !== 'linux') return; // the Windows path (taskkill without /F) is not exercised here
    const fakeChrome = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', `--user-data-dir=${dataPaths.chatgptChrome()}`]);
    const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(isAutomationChromePid(fakeChrome.pid!)).toBe(true);
      expect(isAutomationChromePid(other.pid!)).toBe(false);
      expect(await closeAutomationChrome(other.pid!, 2000)).toMatchObject({ detail: expect.stringMatching(/is not the Automation Chrome/) });
      expect(other.exitCode).toBeNull(); // left alone
      const done = new Promise((r) => fakeChrome.once('exit', (_code, signal) => r(signal)));
      expect(await closeAutomationChrome(fakeChrome.pid!, 5000)).toMatchObject({ closed: true });
      expect(await done).toBe('SIGTERM');
    } finally {
      other.kill('SIGKILL');
      fakeChrome.kill('SIGKILL');
    }
  });
});
