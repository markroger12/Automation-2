import { appOrigin } from '../env';
import { log } from '../log';
import { getSettings, getValue, setValue } from '../settings';
import { showToast, type Toast } from '../notify/windows';
import { checkForUpdates, readStatus, type UpdateCheck, type UpdateStatus, type Version } from './service';

/**
 * Owner request (2026-11-05): “tool update ko notification” — the app tells the owner when GitHub has a new version,
 * instead of the owner having to press Check for updates. The worker looks every hour (and right after it starts, so a
 * finished update or a `git pull` is seen at once):
 *  - a Windows notification, once per new version (Settings → Notifications → “A new app version is available”);
 *  - “App update available” under the bell and in the banner, with a link to Settings → App updates, until updated.
 * The look is the same `git fetch` as Check for updates; nothing is installed by itself.
 */
export const AUTO_CHECK_EVERY_MS = 60 * 60_000;
const STATE_KEY = 'update.autoCheck';

export interface AutoCheckState {
  checkedAt: string;
  /** The version that ran when GitHub was looked at. */
  current: string | null;
  latest: Version | null;
  /** Changes on GitHub that this computer does not have. */
  behind: number;
  /** The newest change titles (at most 3). */
  subjects: string[];
  canUpdate: boolean;
  /** Why the Update button cannot start it (null when it can). */
  reason: string | null;
  /** The look failed (no git, GitHub not reached); the rest is then from no look. */
  error: string | null;
  /** The newest version a Windows notification was already shown for (or that the owner saw in Settings). */
  notified: string | null;
}

export const readAutoCheck = () => getValue<AutoCheckState | null>(STATE_KEY, null);

/** What is remembered of a look (pure). */
export function stateFromCheck(check: UpdateCheck, notified: string | null, now = new Date()): AutoCheckState {
  return {
    checkedAt: now.toISOString(),
    current: check.current.sha,
    latest: check.latest,
    behind: check.behind,
    subjects: check.commits.slice(0, 3).map((c) => c.subject),
    canUpdate: check.canUpdate,
    reason: check.reason,
    error: null,
    notified,
  };
}

const changes = (n: number) => `${n} new change${n === 1 ? '' : 's'}`;

/** The Windows notification for a version not notified yet (pure); null when there is nothing new. */
export function updateToast(state: AutoCheckState, origin: string): Toast | null {
  if (state.error || state.behind <= 0 || !state.latest || state.latest.sha === state.notified) return null;
  const first = state.subjects[0] ?? state.latest.subject;
  return {
    title: 'App update available',
    body: `${changes(state.behind)} on GitHub: ${first}${state.behind > 1 ? ' …' : ''}. Open Settings → App updates to install ${state.behind === 1 ? 'it' : 'them'}.`,
    url: `${origin}/settings#app-updates`,
  };
}

/**
 * “App update available” for the bell and the banner (pure). Not shown while an update runs, nor when an update
 * finished after the look (the worker looks again as soon as it restarts).
 */
export function updateNotice(state: AutoCheckState | null, status: UpdateStatus | null): { tone: 'info'; title: string; detail: string; href: string; action: string } | null {
  if (!state || state.error || state.behind <= 0 || !state.latest) return null;
  if (status?.state === 'running') return null;
  if (status?.state === 'done' && (status.to.sha === state.latest.sha || Date.parse(status.finishedAt ?? status.startedAt) >= Date.parse(state.checkedAt))) return null;
  const first = state.subjects[0] ?? state.latest.subject;
  return {
    tone: 'info',
    title: 'App update available',
    detail: `${changes(state.behind)} on GitHub (newest: ${first}).${state.canUpdate ? ' One click installs it; articles and settings stay.' : state.reason ? ` ${state.reason}` : ''}`,
    href: '/settings#app-updates',
    action: 'Update',
  };
}

/** Check for updates in Settings: the bell follows it, and the version the owner saw there is not notified again. */
export async function rememberManualCheck(check: UpdateCheck, now = new Date()): Promise<void> {
  const before = await readAutoCheck();
  await setValue(STATE_KEY, stateFromCheck(check, check.behind > 0 ? check.latest.sha : (before?.notified ?? null), now));
}

let lookedThisRun = false;
let lastError: string | null = null;

/** Tests only: as if the worker had just started. */
export function resetAutoCheckForTests() {
  lookedThisRun = false;
  lastError = null;
}

/** One worker tick (every few minutes): look at GitHub when due, notify a new version once. */
export async function autoCheckTick(
  opts: { now?: Date; check?: () => Promise<UpdateCheck>; show?: (t: Toast) => Promise<{ shown: boolean; error?: string }>; desktop?: boolean } = {},
): Promise<{ looked: boolean; notified: boolean }> {
  const now = opts.now ?? new Date();
  // The desktop app is updated with its own installer; during an update start:all owns git.
  if (opts.desktop ?? process.env.BAS_DESKTOP === '1') return { looked: false, notified: false };
  if (readStatus()?.state === 'running') return { looked: false, notified: false };
  const before = await readAutoCheck();
  const due = !lookedThisRun || !before || now.getTime() - Date.parse(before.checkedAt) >= AUTO_CHECK_EVERY_MS;
  if (!due) return { looked: false, notified: false };
  lookedThisRun = true;
  let state: AutoCheckState;
  try {
    state = stateFromCheck(await (opts.check ?? checkForUpdates)(), before?.notified ?? null, now);
    lastError = null;
  } catch (error) {
    const message = (error as Error).message;
    state = { checkedAt: now.toISOString(), current: null, latest: null, behind: 0, subjects: [], canUpdate: false, reason: null, error: message, notified: before?.notified ?? null };
    // Logged once per kind of failure, not every hour.
    if (message !== lastError) {
      lastError = message;
      await log({ level: 'warn', category: 'worker', message: `Automatic update check failed: ${message}` }).catch(() => undefined);
    }
  }
  const toast = updateToast(state, appOrigin());
  let notified = false;
  if (toast) {
    const settings = (await getSettings()).notifications;
    if (settings.windows && settings.appUpdate) {
      notified = (await (opts.show ?? showToast)(toast)).shown;
      // Once per version, also when Windows did not show it (the bell keeps it until updated).
      state.notified = state.latest!.sha;
    }
  }
  await setValue(STATE_KEY, state);
  return { looked: true, notified };
}
