import fs from 'node:fs';
import { db } from '@/lib/db';
import { RUNNING_STATUSES } from '@/lib/domain';
import { getExtensionHealth } from '@/lib/health';
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
}

export interface AutostartDeps {
  now?: () => Date;
  settings?: () => Promise<{ open: boolean; close: boolean }>;
  work?: () => Promise<Work>;
  extensionConnected?: () => Promise<boolean>;
  chromeRunning?: () => boolean | null;
  launch?: () => { pid: number | null };
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
  const [queued, running, waitingPrompts, activePrompts, runs] = await Promise.all([
    db.articleTask.count({ where: { status: 'QUEUED', legacy: false } }),
    db.articleTask.count({ where: { status: { in: RUNNING_STATUSES }, legacy: false } }),
    db.queueJob.count({ where: { queue: 'chatgpt', status: 'WAITING', runAt: { lte: now } } }),
    db.queueJob.count({ where: { queue: 'chatgpt', status: { in: ['WAITING', 'ACTIVE'] } } }),
    db.humanizerRun.count({ where: { status: { in: ['QUEUED', 'WAITING'] } } }),
  ]);
  return { needsChrome: queued > 0 || waitingPrompts > 0, busy: queued + running + activePrompts + runs > 0, waitingPrompts };
}

let lastAttempt = 0;

/** For tests: forget the last launch attempt. */
export function resetAutostart(): void {
  lastAttempt = 0;
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
    if (!settings.open || !work.needsChrome) return settings.open ? 'busy' : 'disabled';
    if (await (deps.extensionConnected ?? (async () => (await getExtensionHealth(now)).state === 'connected'))()) return 'connected';
    // Running (or unknown: locked by another host): nothing to open; the extension connects once it is loaded and paired.
    if (running !== false) return 'running';
    if (now.getTime() - lastAttempt < COOLDOWN_MS) return 'cooldown';
    lastAttempt = now.getTime();
    try {
      const result = (deps.launch ?? launchAutomationChrome)();
      store.write({ pid: result.pid, openedAt: now.toISOString(), idleSince: null });
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
