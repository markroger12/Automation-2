import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb } from '../helpers/test-db';
import type { UpdateCheck, UpdateStatus } from '@/lib/update/service';
import type { AutoCheckState } from '@/lib/update/auto-check';
import type { Toast } from '@/lib/notify/windows';

/** Owner request (2026-11-05): “tool update ko notification” — say when GitHub has a new version of the app. */
// The database is set up before the modules load (they open it when imported).
let auto: typeof import('@/lib/update/auto-check');
let settings: typeof import('@/lib/settings');
let health: typeof import('@/lib/health');
let paths: typeof import('@/lib/paths');
beforeAll(async () => {
  await setupTestDb();
  auto = await import('@/lib/update/auto-check');
  settings = await import('@/lib/settings');
  health = await import('@/lib/health');
  paths = await import('@/lib/paths');
});

const O = 'http://127.0.0.1:3000';
const v = (sha: string, subject: string) => ({ sha, date: '2026-11-05T11:00:00Z', subject });
const check = (latest: string, behind: number, over: Partial<UpdateCheck> = {}): UpdateCheck => ({
  checkedAt: '2026-11-05T11:00:00Z',
  branch: 'claude/confident-brown-pwlrz6',
  upstream: 'origin/claude/confident-brown-pwlrz6',
  current: v('aaa1111', 'Installed version'),
  latest: v(latest, 'Allow 30 secondary keywords instead of 20'),
  behind,
  ahead: 0,
  commits: behind ? [v(latest, 'Allow 30 secondary keywords instead of 20'), v('ccc3333', 'A draft changed in WordPress'), v('ddd4444', 'Third'), v('eee5555', 'Fourth')].slice(0, behind) : [],
  changes: { packages: false, extension: false, database: false, files: 3 },
  extension: { now: '3.5.4', next: '3.5.4' },
  localChanges: [],
  running: 0,
  canUpdate: behind > 0,
  reason: null,
  ...over,
});
const state = (over: Partial<AutoCheckState> = {}): AutoCheckState => ({ ...auto.stateFromCheck(check('bbb2222', 2), null, new Date('2026-11-05T11:00:00Z')), ...over });
const statusFile = () => path.join(paths.dataDir(), 'update', 'status.json');
const writeStatus = (s: Partial<UpdateStatus> | null) => {
  fs.mkdirSync(path.dirname(statusFile()), { recursive: true });
  if (s) fs.writeFileSync(statusFile(), JSON.stringify({ steps: [], error: null, rolledBack: false, log: [], from: null, ...s }));
  else fs.rmSync(statusFile(), { force: true });
};

describe('the notification text and the bell (pure)', () => {
  it('a Windows notification for a version not notified yet, opening Settings → App updates', () => {
    expect(auto.updateToast(state(), O)).toEqual({
      title: 'App update available',
      body: '2 new changes on GitHub: Allow 30 secondary keywords instead of 20 …. Open Settings → App updates to install them.',
      url: `${O}/settings#app-updates`,
    });
    expect(auto.updateToast(state({ behind: 1, subjects: ['One fix'] }), O)?.body).toBe('1 new change on GitHub: One fix. Open Settings → App updates to install it.');
    // Nothing new, already notified, or the look failed: no notification.
    expect(auto.updateToast(state({ behind: 0 }), O)).toBeNull();
    expect(auto.updateToast(state({ notified: 'bbb2222' }), O)).toBeNull();
    expect(auto.updateToast(state({ error: 'Could not reach GitHub' }), O)).toBeNull();
  });

  it('“App update available” under the bell until updated; why the button cannot start it, when it cannot', () => {
    expect(auto.updateNotice(state(), null)).toEqual({
      tone: 'info',
      title: 'App update available',
      detail: '2 new changes on GitHub (newest: Allow 30 secondary keywords instead of 20). One click installs it; articles and settings stay.',
      href: '/settings#app-updates',
      action: 'Update',
    });
    // The owner already noticed it in Windows: the bell still shows it until the update.
    expect(auto.updateNotice(state({ notified: 'bbb2222' }), null)).not.toBeNull();
    expect(auto.updateNotice(state({ canUpdate: false, reason: 'The app was not started with `npm run start:all`, so it cannot restart itself.' }), null)?.detail).toMatch(/\(newest: .*\)\. The app was not started with `npm run start:all`/);
    expect(auto.updateNotice(state({ behind: 0 }), null)).toBeNull();
    expect(auto.updateNotice(state({ error: 'no git' }), null)).toBeNull();
    expect(auto.updateNotice(null, null)).toBeNull();
    // While an update runs, and once it finished (before the worker looked again): gone.
    const run = { startedAt: '2026-11-05T11:30:00Z', finishedAt: null, to: { sha: 'bbb2222' } };
    expect(auto.updateNotice(state(), { ...run, state: 'running' } as UpdateStatus)).toBeNull();
    expect(auto.updateNotice(state(), { ...run, state: 'done', finishedAt: '2026-11-05T11:33:00Z' } as UpdateStatus)).toBeNull();
    // A failed update leaves it; so does an older update than the look.
    expect(auto.updateNotice(state(), { ...run, state: 'failed', finishedAt: '2026-11-05T11:33:00Z' } as UpdateStatus)).not.toBeNull();
    expect(auto.updateNotice(state(), { startedAt: '2026-11-04T09:00:00Z', finishedAt: '2026-11-04T09:03:00Z', to: { sha: 'old0000' }, state: 'done' } as UpdateStatus)).not.toBeNull();
  });
});

describe('the worker looks every hour and notifies each new version once', () => {
  beforeEach(async () => {
    auto.resetAutoCheckForTests();
    writeStatus(null);
    await settings.setValue('update.autoCheck', null);
    await settings.updateSettings({ notifications: { windows: true, appUpdate: true } });
  });

  const recorder = () => {
    const shown: Toast[] = [];
    const show = async (t: Toast) => {
      shown.push(t);
      return { shown: true };
    };
    return { shown, show };
  };

  it('at start and then hourly; one notification per new version; the bell shows it', async () => {
    const { shown, show } = recorder();
    let gh = check('bbb2222', 2);
    let looks = 0;
    const look = async () => {
      looks++;
      return gh;
    };
    const t0 = new Date('2026-11-05T12:00:00Z');
    expect(await auto.autoCheckTick({ now: t0, check: look, show, desktop: false })).toEqual({ looked: true, notified: true });
    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('App update available');
    expect(shown[0].url).toMatch(/\/settings#app-updates$/);
    const warnings = await health.getHealthWarnings();
    expect(warnings.at(-1)).toMatchObject({ title: 'App update available', href: '/settings#app-updates', action: 'Update' });

    // Within the hour: no look. After it, the same version: looked, not notified again.
    expect(await auto.autoCheckTick({ now: new Date(t0.getTime() + 30 * 60_000), check: look, show, desktop: false })).toEqual({ looked: false, notified: false });
    expect(await auto.autoCheckTick({ now: new Date(t0.getTime() + 61 * 60_000), check: look, show, desktop: false })).toEqual({ looked: true, notified: false });
    expect(looks).toBe(2);
    expect(shown).toHaveLength(1);

    // An even newer version: notified again.
    gh = check('fff6666', 3);
    expect(await auto.autoCheckTick({ now: new Date(t0.getTime() + 122 * 60_000), check: look, show, desktop: false })).toEqual({ looked: true, notified: true });
    expect(shown).toHaveLength(2);
    expect(shown[1].body).toMatch(/^3 new changes on GitHub/);

    // Updated (newest now): nothing under the bell, nothing notified.
    gh = check('fff6666', 0, { current: v('fff6666', 'Installed') });
    auto.resetAutoCheckForTests(); // the worker restarts after an update and looks at once
    expect(await auto.autoCheckTick({ now: new Date(t0.getTime() + 130 * 60_000), check: look, show, desktop: false })).toEqual({ looked: true, notified: false });
    expect((await health.getHealthWarnings()).some((w) => w.title === 'App update available')).toBe(false);
  });

  it('switched off in Settings → Notifications: no Windows notification, the bell still shows it', async () => {
    await settings.updateSettings({ notifications: { appUpdate: false } });
    const { shown, show } = recorder();
    expect(await auto.autoCheckTick({ now: new Date('2026-11-05T12:00:00Z'), check: async () => check('bbb2222', 2), show, desktop: false })).toEqual({ looked: true, notified: false });
    expect(shown).toEqual([]);
    expect((await health.getHealthWarnings()).some((w) => w.title === 'App update available')).toBe(true);
    expect((await settings.getSettings()).notifications.appUpdate).toBe(false);
  });

  it('a version the owner already saw with Check for updates is not notified again', async () => {
    const { shown, show } = recorder();
    await auto.rememberManualCheck(check('bbb2222', 2));
    expect((await auto.readAutoCheck())?.notified).toBe('bbb2222');
    expect(await auto.autoCheckTick({ now: new Date('2026-11-05T12:00:00Z'), check: async () => check('bbb2222', 2), show, desktop: false })).toEqual({ looked: true, notified: false });
    expect(shown).toEqual([]);
  });

  it('GitHub not reached: remembered as an error, nothing notified, nothing under the bell', async () => {
    const { shown, show } = recorder();
    const r = await auto.autoCheckTick({
      now: new Date('2026-11-05T12:00:00Z'),
      check: async () => {
        throw new Error('Could not reach GitHub: network');
      },
      show,
      desktop: false,
    });
    expect(r).toEqual({ looked: true, notified: false });
    expect(shown).toEqual([]);
    expect((await auto.readAutoCheck())?.error).toBe('Could not reach GitHub: network');
    expect((await health.getHealthWarnings()).some((w) => w.title === 'App update available')).toBe(false);
  });

  it('never looks in the desktop app or while an update runs', async () => {
    const { shown, show } = recorder();
    let looks = 0;
    const look = async () => {
      looks++;
      return check('bbb2222', 2);
    };
    expect(await auto.autoCheckTick({ now: new Date('2026-11-05T12:00:00Z'), check: look, show, desktop: true })).toEqual({ looked: false, notified: false });
    writeStatus({ state: 'running', startedAt: '2026-11-05T11:59:00Z', finishedAt: null, to: { sha: 'bbb2222' } });
    expect(await auto.autoCheckTick({ now: new Date('2026-11-05T12:00:00Z'), check: look, show, desktop: false })).toEqual({ looked: false, notified: false });
    expect(looks).toBe(0);
    expect(shown).toEqual([]);
    writeStatus(null);
  });

  it('is a setting under Notifications, on by default', async () => {
    const { settingsSchema } = await import('@/lib/settings-schema');
    expect(settingsSchema.parse({}).notifications.appUpdate).toBe(true);
    const { SETTING_GROUPS } = await import('@/lib/settings-fields');
    expect(SETTING_GROUPS.find((g) => g.id === 'notifications')?.fields.map((f) => f.key)).toContain('appUpdate');
  });
});
