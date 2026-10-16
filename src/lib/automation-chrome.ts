import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { chromeExecutable } from './browsers';
import { dataPaths, projectRoot } from './paths';

/**
 * Automation Chrome: the owner's VISIBLE, dedicated Chrome profile for
 * ChatGPT (data/chatgpt-chrome). The app only launches it; the owner signs in
 * to ChatGPT and loads the unpacked extension manually. No automation
 * framework drives this browser (no WebDriver, no CDP), and no security
 * features are disabled — only background throttling flags so an unfocused
 * window keeps rendering.
 */
export const AUTOMATION_CHROME_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
];

export function extensionFolder(): string {
  return path.join(projectRoot(), 'extension');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Best-effort detection of a running Chrome using the dedicated profile. */
export function isAutomationChromeRunning(): { running: boolean | null; detail: string } {
  const dir = dataPaths.chatgptChrome();
  if (process.platform === 'win32') {
    const lock = path.join(dir, 'lockfile');
    if (!fs.existsSync(lock)) return { running: false, detail: 'Profile not in use.' };
    try {
      const fd = fs.openSync(lock, 'r+');
      fs.closeSync(fd);
      return { running: false, detail: 'Stale lock file (Chrome is not running).' };
    } catch {
      return { running: true, detail: 'Profile is in use by Chrome.' };
    }
  }
  const singleton = path.join(dir, 'SingletonLock');
  try {
    const target = fs.readlinkSync(singleton);
    const pid = Number(target.split('-').pop());
    const host = target.slice(0, target.lastIndexOf('-'));
    if (host === os.hostname() && Number.isFinite(pid)) return pidAlive(pid) ? { running: true, detail: `Chrome PID ${pid}` } : { running: false, detail: 'Stale lock.' };
    return { running: null, detail: 'Profile locked by another host.' };
  } catch {
    return { running: false, detail: 'Profile not in use.' };
  }
}

export function launchAutomationChrome(url = 'https://chatgpt.com/'): { pid: number | null; command: string } {
  const exe = chromeExecutable();
  if (!exe) throw new Error('Google Chrome was not found. Install Chrome or set BROWSER_EXECUTABLE_PATH in .env.');
  const state = isAutomationChromeRunning();
  if (state.running) throw new Error('Automation Chrome is already running — switch to its window.');
  const dir = dataPaths.chatgptChrome();
  fs.mkdirSync(dir, { recursive: true });
  const args = [`--user-data-dir=${dir}`, ...AUTOMATION_CHROME_FLAGS, url];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { pid: child.pid ?? null, command: `"${exe}" ${args.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')}` };
}

/** Whether `pid` is still the Automation Chrome browser (a PID can be reused by another program after Chrome exits). */
export function isAutomationChromePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid)) return false;
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      return /"chrome\.exe"/i.test(out);
    }
    if (process.platform === 'linux') return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(dataPaths.chatgptChrome());
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 10_000 }).includes(dataPaths.chatgptChrome());
  } catch {
    return false;
  }
}

/**
 * Ask the Automation Chrome the app opened to close, like its window's close button (never a forced kill: that can
 * lose the ChatGPT sign-in Chrome has not written to disk yet). Waits up to `waitMs` for the profile to be released.
 */
export async function closeAutomationChrome(pid: number, waitMs = 20_000): Promise<{ closed: boolean; detail: string }> {
  if (!isAutomationChromePid(pid)) return { closed: isAutomationChromeRunning().running === false, detail: `PID ${pid} is not the Automation Chrome (already closed?).` };
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid)], { windowsHide: true, timeout: 10_000, stdio: 'ignore' });
    else process.kill(pid, 'SIGTERM');
  } catch (error) {
    return { closed: false, detail: `Close request failed: ${(error as Error).message.split('\n')[0]}` };
  }
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (!pidAlive(pid)) return { closed: true, detail: `Chrome PID ${pid} closed.` };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { closed: false, detail: `Chrome PID ${pid} did not close within ${Math.round(waitMs / 1000)} s (left open; it was not forced).` };
}
