import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
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
