import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Owner request (2026-11-12): “app me bhi update vala feature”. desktop/updates.cjs with a fake updater in place of
 * electron-updater: what the app shows at each step, and that it installs only a downloaded version, only when asked.
 */
const require = createRequire(import.meta.url);
const { createUpdates } = require(path.resolve(__dirname, '..', '..', 'desktop', 'updates.cjs')) as {
  createUpdates: (o: Record<string, unknown>) => { state: () => Record<string, unknown>; check: () => Promise<Record<string, unknown>>; ready: () => boolean; install: () => void; start: () => void; stop: () => void };
};

function fakeUpdater() {
  const u = Object.assign(new EventEmitter(), {
    checks: 0,
    installs: [] as unknown[][],
    autoDownload: false,
    autoInstallOnAppQuit: true,
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
    expect(u).toMatchObject({ autoDownload: true, autoInstallOnAppQuit: false, allowPrerelease: false });
    expect(up.state()).toMatchObject({ state: 'idle', current: '3.3.10' });
    await up.check();
    expect(u.checks).toBe(1);
    u.emit('checking-for-update');
    u.emit('update-available', { version: '3.3.12' });
    u.emit('download-progress', { percent: 41.6 });
    expect(up.state()).toMatchObject({ state: 'downloading', version: '3.3.12', percent: 42 });
    // Not installed before it is downloaded; no second check while downloading.
    up.install();
    expect(u.installs).toEqual([]);
    await up.check();
    expect(u.checks).toBe(1);
    u.emit('update-downloaded', { version: '3.3.12' });
    expect(up.ready()).toBe(true);
    expect(notes).toEqual(['App update ready']);
    up.install();
    expect(u.installs).toEqual([[true, true]]); // silent install, then the new version starts
    expect(states.map((s) => s.state)).toEqual(['checking', 'downloading', 'downloading', 'ready']);
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
