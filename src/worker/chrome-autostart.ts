import fs from 'node:fs';
import { db } from '@/lib/db';
import { RUNNING_STATUSES } from '@/lib/domain';
import { getExtensionHealth } from '@/lib/health';
import { inBackoff } from '@/lib/chatgpt/rate';
import { getSettings } from '@/lib/settings';
import { log } from '@/lib/log';
import { dataPaths } from '@/lib/paths';
import { closeAutomationChrome, isAutomationChromeRunning, launchAutomationChrome } from '@/lib/automation-chrome';

/**
 * Automation Chrome (the owner's ChatGPT window with the extension) follows the queue (owner request):
 * - it is opened by itself when an article is queued or a ChatGPT prompt waits and the extension is not connected
 *   (the same launch as the “Open Automation Chrome” button), at most once per COOLDOWN_MS, never while it runs;
 * - the Chrome the worker opened is closed again, normally (never forced), once no queued or running article, no
 *   Humanizer run and no ChatGPT prompt is left for IDLE_CLOSE_MS. A Chrome the owner opened is never closed.
 * The PID of the Chrome it opened is kept in data/chatgpt-chrome-auto.json, so a worker restart still closes it.
 */
export const COOLDOWN_MS = 3 * 60_000;
export const IDLE_CLOSE_MS = 2 * 60_000;
/** The extension counts as connected only with a heartbeat this fresh (it polls every 30 s). */
export const CONNECTED_MS = 75_000;
/** A due prompt nobody claimed for this long (nothing else running, no usage-limit wait) is stuck. */
export const STALLED_MS = 90_000;

export interface AutoChromeState {
  pid: number | null;
  openedAt: string;
  idleSince?: string | null;
}

export interface Work {
  /** An article is queued or a ChatGPT prompt waits: Chrome is needed now. */
  needsChrome: boolean;
  /** Anything that may still send a ChatGPT prompt (queued/running articles, Humanizer runs, open prompts). */
  busy: boolean;
  waitingPrompts: number;
  /**
   * Oldest due prompt that nobody claimed for STALLED_MS while no prompt runs and no usage-limit wait holds them:
   * Chrome is running without a ChatGPT window (closed window, background Chrome), so a window is opened for it.
   */
  stalledPromptId?: string | null;
}

export interface AutostartDeps {
  now?: () => Date;
  settings?: () => Promise<{ open: boolean; close: boolean }>;
  work?: () => Promise<Work>;
  extensionConnected?: () => Promise<boolean>;
  chromeRunning?: () => boolean | null;
  launch?: (opts?: { allowRunning?: boolean }) => { pid: number | null };
  close?: (pid: number) => Promise<{ closed: boolean; detail: string }>;
  store?: { read: () => AutoChromeState | null; write: (s: AutoChromeState | null) => void };
}

const fileStore = {
  read(): AutoChromeState | null {
    try {
      const s = JSON.parse(fs.readFileSync(dataPaths.chatgptChromeAuto(), 'utf8')) as AutoChromeState | Record<string, never>;
      return 'openedAt' in s ? (s as AutoChromeState) : null;
    } catch {
      return null;
    }
  },
  write(s: AutoChromeState | null): void {
    // Overwritten (never deleted): an empty object means “no Chrome opened by the worker”.
    fs.writeFileSync(dataPaths.chatgptChromeAuto(), JSON.stringify(s ?? {}));
  },
};

export async function currentWork(now = new Date()): Promise<Work> {
  const [queued, running, waitingPrompts, openPrompts, claimed, runs, stalled, backoff, indexing] = await Promise.all([
    db.articleTask.count({ where: { status: 'QUEUED', legacy: false } }),
    db.articleTask.count({ where: { status: { in: RUNNING_STATUSES }, legacy: false } }),
    db.queueJob.count({ where: { queue: 'chatgpt', status: 'WAITING', runAt: { lte: now } } }),
    db.queueJob.count({ where: { queue: 'chatgpt', status: { in: ['WAITING', 'ACTIVE'] } } }),
    db.queueJob.count({ where: { queue: 'chatgpt', status: 'ACTIVE' } }),
    db.humanizerRun.count({ where: { status: { in: ['QUEUED', 'WAITING'] } } }),
    db.queueJob.findFirst({ where: { queue: 'chatgpt', status: 'WAITING', runAt: { lte: new Date(now.getTime() - STALLED_MS) } }, orderBy: { runAt: 'asc' }, select: { id: true } }),
    inBackoff(db, now),
    // Search Console “Request indexing” is made in Automation Chrome too (owner request).
    db.queueJob.count({ where: { queue: 'gsc', OR: [{ status: 'WAITING', runAt: { lte: now } }, { status: 'ACTIVE' }] } }),
  ]);
  return {
    needsChrome: queued > 0 || waitingPrompts > 0 || indexing > 0,
    busy: queued + running + openPrompts + runs + indexing > 0,
    waitingPrompts,
    stalledPromptId: stalled && !claimed && !backoff ? stalled.id : null,
  };
}

const defaultLaunch = (opts?: { allowRunning?: boolean }) => launchAutomationChrome(undefined, opts);

let lastAttempt = 0;
let windowOpenedFor: string | null = null;
let lastReason: string | null = null;

/** For tests: forget the last launch attempt. */
export function resetAutostart(): void {
  lastAttempt = 0;
  windowOpenedFor = null;
  lastReason = null;
}

/** Say once in Logs why Chrome was not opened for waiting work (not again until the reason changes). */
async function noteNotOpened(reason: string): Promise<void> {
  if (reason === lastReason) return;
  lastReason = reason;
  await log({ category: 'extension', message: `Automation Chrome not opened automatically: ${reason}.` });
}

export type AutostartOutcome = 'disabled' | 'busy' | 'connected' | 'running' | 'cooldown' | 'launched' | 'failed' | 'idle' | 'waiting-to-close' | 'closed' | 'close-failed';

export async function chromeAutostartTick(deps: AutostartDeps = {}): Promise<AutostartOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const settings = await (deps.settings ?? (async () => {
    const b = (await getSettings()).browser;
    return { open: b.autoLaunchChatGPTChrome, close: b.autoCloseChatGPTChrome };
  }))();
  const store = deps.store ?? fileStore;
  const running = (deps.chromeRunning ?? (() => isAutomationChromeRunning().running))();
  let opened = store.read();
  if (opened && running === false) {
    // Closed already (by the owner or by us): forget it.
    store.write(null);
    opened = null;
  }
  const work = await (deps.work ?? (() => currentWork(now)))();

  if (work.busy) {
    if (opened?.idleSince) store.write({ ...opened, idleSince: null });
    if (!settings.open || !work.needsChrome) {
      if (!settings.open && work.needsChrome) await noteNotOpened('switched off in Settings → Browser');
      return settings.open ? 'busy' : 'disabled';
    }
    const connected = await (deps.extensionConnected ?? (async () => {
      const health = await getExtensionHealth(now);
      return Boolean(health.lastSeenAt && now.getTime() - health.lastSeenAt.getTime() <= CONNECTED_MS);
    }))();
    // A prompt nobody claims although Chrome runs (owner report: Retry did not bring Chrome back): the ChatGPT
    // window is gone (closed window, Chrome left running in the background). Opening the profile again opens a
    // window in the running Chrome. Once per stuck prompt, and not within the cooldown.
    if (work.stalledPromptId && running !== false && windowOpenedFor !== work.stalledPromptId) {
      if (now.getTime() - lastAttempt < COOLDOWN_MS) return 'cooldown';
      lastAttempt = now.getTime();
      windowOpenedFor = work.stalledPromptId;
      try {
        (deps.launch ?? defaultLaunch)({ allowRunning: true });
        await log({ category: 'extension', message: `A ChatGPT prompt waited ${Math.round(STALLED_MS / 1000)} s+ without being picked up although Automation Chrome runs${connected ? ' and the extension is connected' : ''}: a ChatGPT window was opened in it.` });
        return 'launched';
      } catch (error) {
        await log({ level: 'warn', category: 'extension', message: `A ChatGPT window could not be opened in Automation Chrome: ${(error as Error).message}` });
        return 'failed';
      }
    }
    if (connected) return 'connected';
    // Running (or unknown: locked by another host): nothing to open; the extension connects once it is loaded and paired.
    if (running !== false) {
      await noteNotOpened(running === null ? 'its profile is locked by another computer' : 'it is already running (waiting for the extension to connect)');
      return 'running';
    }
    if (now.getTime() - lastAttempt < COOLDOWN_MS) return 'cooldown';
    lastAttempt = now.getTime();
    try {
      const result = (deps.launch ?? defaultLaunch)();
      store.write({ pid: result.pid, openedAt: now.toISOString(), idleSince: null });
      lastReason = null;
      await log({ category: 'extension', message: `Automation Chrome opened automatically for queued work (${work.waitingPrompts} ChatGPT prompt(s) waiting; PID ${result.pid ?? '?'}). It closes again when the queue is done.` });
      return 'launched';
    } catch (error) {
      await log({ level: 'warn', category: 'extension', message: `Automation Chrome could not be opened automatically: ${(error as Error).message}` });
      return 'failed';
    }
  }

  // Nothing left to do: close the Chrome the worker opened, after IDLE_CLOSE_MS without work.
  if (!opened || !settings.close || !opened.pid) return 'idle';
  if (!opened.idleSince) {
    store.write({ ...opened, idleSince: now.toISOString() });
    return 'waiting-to-close';
  }
  if (now.getTime() - Date.parse(opened.idleSince) < IDLE_CLOSE_MS) return 'waiting-to-close';
  const result = await (deps.close ?? ((pid) => closeAutomationChrome(pid)))(opened.pid);
  store.write(null);
  await log({ level: result.closed ? 'info' : 'warn', category: 'extension', message: result.closed ? `Automation Chrome closed automatically: the queue is done. ${result.detail}` : `Automation Chrome was not closed automatically: ${result.detail}` });
  return result.closed ? 'closed' : 'close-failed';
}
