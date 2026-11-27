import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Owner request (2026-11-12): “app me bhi update vala feature”. desktop/updates.cjs with a fake updater in place of
 * electron-updater: what the app shows at each step, and that it installs only a downloaded version, only when asked.
 */
const require = createRequire(import.meta.url);
const { createUpdates } = require(path.resolve(__dirname, '..', '..', 'desktop', 'updates.cjs')) as {
  createUpdates: (o: Record<string, unknown>) => { state: () => Record<string, unknown>; check: () => Promise<Record<string, unknown>>; ready: () => boolean; install: () => boolean; start: () => void; stop: () => void };
};

const { createLogFile } = require(path.resolve(__dirname, '..', '..', 'desktop', 'log-file.cjs')) as {
  createLogFile: (file: string) => { write: (text: string) => void; end: () => void };
};

function fakeUpdater() {
  const u = Object.assign(new EventEmitter(), {
    checks: 0,
    installs: [] as unknown[][],
    autoDownload: false,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: false,
    allowPrerelease: true,
    logger: null as unknown,
    checkForUpdates: async () => {
      u.checks++;
    },
    quitAndInstall: (...args: unknown[]) => void u.installs.push(args),
  });
  return u;
}

describe("the desktop app's updates", () => {
  it('a newer version: downloaded in the background, then “Restart to update”; installs only then', async () => {
    const u = fakeUpdater();
    const states: Record<string, unknown>[] = [];
    const notes: string[] = [];
    const up = createUpdates({ enabled: true, updater: u, version: '3.3.10', log: () => {}, onState: (s: Record<string, unknown>) => states.push(s), notify: (t: string) => notes.push(t) });
    expect(u).toMatchObject({ autoDownload: true, autoInstallOnAppQuit: false, autoRunAppAfterInstall: true, allowPrerelease: false });
    expect(up.state()).toMatchObject({ state: 'idle', current: '3.3.10' });
    await up.check();
    expect(u.checks).toBe(1);
    u.emit('checking-for-update');
    u.emit('update-available', { version: '3.3.12' });
    u.emit('download-progress', { percent: 41.6 });
    expect(up.state()).toMatchObject({ state: 'downloading', version: '3.3.12', percent: 42 });
    // Not installed before it is downloaded; no second check while downloading.
    expect(up.install()).toBe(false);
    expect(u.installs).toEqual([]);
    await up.check();
    expect(u.checks).toBe(1);
    u.emit('update-downloaded', { version: '3.3.12' });
    expect(up.ready()).toBe(true);
    expect(notes).toEqual(['App update ready']);
    expect(up.install()).toBe(true);
    // Owner request 2026-11-13: the installer's window shows the progress (not silent), then the new version starts.
    expect(u.installs).toEqual([[false, true]]);
    expect(states.map((s) => s.state)).toEqual(['checking', 'downloading', 'downloading', 'ready']);
  });

  it('an installer that cannot start is reported, so the app opens again as it was', () => {
    const u = fakeUpdater();
    u.quitAndInstall = () => void u.emit('error', new Error("No update filepath provided, can't quit and install"));
    const up = createUpdates({ enabled: true, updater: u, version: '3.3.46', log: () => {}, onState: () => {}, notify: () => {} });
    u.emit('update-downloaded', { version: '3.3.47' });
    expect(up.install()).toBe(false);
    expect(up.state()).toMatchObject({ state: 'error', message: "No update filepath provided, can't quit and install" });
    const throws = fakeUpdater();
    throws.quitAndInstall = () => {
      throw new Error('spawn EACCES');
    };
    const up2 = createUpdates({ enabled: true, updater: throws, version: '3.3.46', log: () => {}, onState: () => {}, notify: () => {} });
    throws.emit('update-downloaded', { version: '3.3.47' });
    expect(up2.install()).toBe(false);
    expect(up2.state()).toMatchObject({ state: 'error', message: 'spawn EACCES' });
  });

  it('no update, an error, and a copy that does not update itself', async () => {
    const u = fakeUpdater();
    const up = createUpdates({ enabled: true, updater: u, version: '3.3.12', log: () => {}, onState: () => {}, notify: () => {} });
    u.emit('update-not-available', {});
    expect(up.state()).toMatchObject({ state: 'current' });
    u.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED\n  at stack'));
    expect(up.state()).toMatchObject({ state: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' });
    // The smoke test and a copy run from the repository: nothing is looked for.
    const off = createUpdates({ enabled: false, updater: fakeUpdater(), version: '3.2.0', log: () => {}, onState: () => {}, notify: () => {} });
    expect(off.state()).toMatchObject({ state: 'unavailable' });
    expect((await off.check()).state).toBe('unavailable');
  });
});

/**
 * Owner report 2026-11-13: “Restart to update” showed “A JavaScript error occurred in the main process … write after
 * end” (the app closed its log, then the updater logged “Install on explicit quitAndInstall”).
 */
describe("the desktop app's log file", () => {
  it('a line logged after the log is closed is still added, with no error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-log-'));
    try {
      const file = path.join(dir, 'desktop.log');
      // What the app did before: a plain stream written after end() fails (uncaught in the main process).
      const plain = fs.createWriteStream(path.join(dir, 'old.log'), { flags: 'a' });
      plain.end();
      const failure = await new Promise<NodeJS.ErrnoException>((resolve) => {
        plain.on('error', resolve);
        plain.write('x\n');
      });
      expect(failure.code).toBe('ERR_STREAM_WRITE_AFTER_END');

      const log = createLogFile(file);
      log.write('[update] The work is stopped.\n');
      log.end();
      log.write('[update] Install on explicit quitAndInstall\n');
      log.end();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const text = fs.readFileSync(file, 'utf8');
      expect(text).toContain('[update] The work is stopped.');
      expect(text).toContain('[update] Install on explicit quitAndInstall');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a log that cannot be written never stops the app', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bas-log-'));
    try {
      // A folder where the file should be: every write fails.
      const log = createLogFile(dir);
      expect(() => log.write('a line\n')).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(() => log.write('another line\n')).not.toThrow();
      expect(() => log.end()).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
