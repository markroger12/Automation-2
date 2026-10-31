import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db';
import { AppError } from '../errors';
import { dataDir, projectRoot } from '../paths';
import { EXPECTED_EXTENSION_VERSION } from '../agent/version';

/**
 * Settings → App updates (owner request: one click instead of `git pull`, `npm run start:all` and reloading the
 * extension by hand). This side looks at git: which version runs, what GitHub has on the same branch, and whether a
 * plain fast-forward can bring it here. The update itself runs in scripts/start-all.mjs, which owns the dashboard and
 * worker processes; it is asked over IPC and writes its progress to data/update/status.json.
 */

export interface UpdateStep {
  key: string;
  label: string;
  state: 'waiting' | 'running' | 'done' | 'skipped' | 'failed';
  startedAt: string | null;
  finishedAt: string | null;
  note: string | null;
}

export interface UpdateStatus {
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  from: { sha: string; subject?: string } | null;
  to: { sha: string; subject?: string };
  steps: UpdateStep[];
  error: string | null;
  rolledBack: boolean;
  log: string[];
}

export interface Version {
  sha: string;
  date: string;
  subject: string;
}

export interface UpdateCheck {
  checkedAt: string;
  branch: string;
  upstream: string;
  current: Version;
  latest: Version;
  behind: number;
  ahead: number;
  /** The newest changes first (at most 30). */
  commits: Version[];
  changes: { packages: boolean; extension: boolean; database: boolean; files: number };
  extension: { now: string; next: string | null };
  /** Tracked files changed on this computer (an update would overwrite them, so it does not start). */
  localChanges: string[];
  /** Steps of articles running now; they are stopped and continue after the restart. */
  running: number;
  canUpdate: boolean;
  reason: string | null;
}

export interface UpdateInfo {
  /** Started by `npm run start:all`, which can stop, update and restart the app. */
  supervised: boolean;
  desktop: boolean;
  current: (Version & { branch: string }) | null;
  status: UpdateStatus | null;
}

const statusFile = () => path.join(dataDir(), 'update', 'status.json');
const supervised = () => process.env.BAS_SUPERVISED === '1' && typeof process.send === 'function';
const desktop = () => process.env.BAS_DESKTOP === '1';

/** Run git in the project folder; never asks for a password in a terminal (GitHub sign-in comes from Git's own store). */
export function git(args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: projectRoot(), env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      err += `\ngit ${args[0]} took longer than ${Math.round(timeoutMs / 1000)} s.`;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: '', err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim(), err: err.trim() });
    });
  });
}

const SEP = '\x1f';
export function parseLog(out: string): Version[] {
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, date, ...subject] = line.split(SEP);
      return { sha, date, subject: subject.join(SEP) };
    });
}

/** What changed between two versions, from `git diff --name-only`. */
export function changeKinds(files: string[]): UpdateCheck['changes'] {
  return {
    packages: files.some((f) => f === 'package.json' || f === 'package-lock.json'),
    extension: files.some((f) => f.startsWith('extension/')),
    database: files.some((f) => f.startsWith('prisma/migrations/')),
    files: files.length,
  };
}

/** Why the update cannot start, in the owner's words; null when it can. */
export function updateBlocker(c: { supervised: boolean; desktop: boolean; behind: number; ahead: number; localChanges: string[]; updating: boolean }): string | null {
  if (c.desktop) return 'The desktop app is updated with its own installer.';
  if (!c.supervised) return 'The app was not started with `npm run start:all`, so it cannot restart itself. Update in a terminal: git pull, then npm run start:all.';
  if (c.updating) return 'An update is running.';
  if (c.behind === 0) return null;
  if (c.ahead > 0) return `This computer has ${c.ahead} change${c.ahead === 1 ? '' : 's'} (commits) that GitHub does not have, so the new version cannot simply be added. Update in a terminal with git.`;
  if (c.localChanges.length) return `${c.localChanges.length} file${c.localChanges.length === 1 ? ' was' : 's were'} changed on this computer; the update would overwrite ${c.localChanges.length === 1 ? 'it' : 'them'}. Undo or commit ${c.localChanges.length === 1 ? 'that change' : 'those changes'} first (git status shows them).`;
  return null;
}

export function readStatus(): UpdateStatus | null {
  try {
    return JSON.parse(fs.readFileSync(statusFile(), 'utf8')) as UpdateStatus;
  } catch {
    return null;
  }
}

async function version(ref: string): Promise<Version | null> {
  const r = await git(['log', '-1', `--format=%H${SEP}%cI${SEP}%s`, ref]);
  return r.ok ? (parseLog(r.out)[0] ?? null) : null;
}

export async function updateInfo(): Promise<UpdateInfo> {
  const [current, branch] = await Promise.all([version('HEAD'), git(['rev-parse', '--abbrev-ref', 'HEAD'])]);
  return { supervised: supervised(), desktop: desktop(), current: current ? { ...current, branch: branch.ok ? branch.out : '' } : null, status: readStatus() };
}

export async function checkForUpdates(): Promise<UpdateCheck> {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!branch.ok) throw new AppError(409, 'NO_GIT', `This folder is not a git copy of the project (${branch.err || 'git not found'}). Updates need the folder that git clone made.`);
  if (branch.out === 'HEAD') throw new AppError(409, 'DETACHED', 'git is not on a branch here (detached HEAD). Check out the branch again in a terminal.');
  const upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) throw new AppError(409, 'NO_UPSTREAM', `The branch ${branch.out} is not linked to GitHub here, so there is nothing to compare with.`);
  const slash = upstream.out.indexOf('/');
  const fetched = await git(['fetch', '--quiet', '--no-tags', upstream.out.slice(0, slash), upstream.out.slice(slash + 1)], 120_000);
  if (!fetched.ok) throw new AppError(502, 'FETCH_FAILED', `Could not reach GitHub: ${fetched.err || 'git fetch failed'}`);
  const [current, latest, counts, log, diff, dirty, manifest, running] = await Promise.all([
    version('HEAD'),
    version('@{u}'),
    git(['rev-list', '--left-right', '--count', 'HEAD...@{u}']),
    git(['log', '-30', `--format=%H${SEP}%cI${SEP}%s`, 'HEAD..@{u}']),
    git(['diff', '--name-only', 'HEAD', '@{u}']),
    git(['status', '--porcelain', '--untracked-files=no']),
    git(['show', '@{u}:extension/manifest.json']),
    db.queueJob.count({ where: { status: 'ACTIVE' } }),
  ]);
  if (!current || !latest || !counts.ok) throw new AppError(500, 'GIT_FAILED', 'git could not compare this version with GitHub.');
  const [ahead, behind] = counts.out.split(/\s+/).map(Number);
  const localChanges = dirty.out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => l.slice(3));
  let next: string | null = null;
  try {
    next = manifest.ok ? (JSON.parse(manifest.out) as { version?: string }).version ?? null : null;
  } catch {
    next = null;
  }
  const changes = changeKinds(behind > 0 ? diff.out.split(/\r?\n/).filter(Boolean) : []);
  const reason = updateBlocker({ supervised: supervised(), desktop: desktop(), behind, ahead, localChanges, updating: readStatus()?.state === 'running' });
  return {
    checkedAt: new Date().toISOString(),
    branch: branch.out,
    upstream: upstream.out,
    current,
    latest,
    behind,
    ahead,
    commits: parseLog(log.out),
    changes,
    extension: { now: EXPECTED_EXTENSION_VERSION, next },
    localChanges,
    running,
    canUpdate: behind > 0 && reason === null,
    reason,
  };
}

/** Check again (the version must still be the one the owner saw), then ask start:all to update. */
export async function startUpdate(expected: string): Promise<{ target: string }> {
  const check = await checkForUpdates();
  if (!check.canUpdate) throw new AppError(409, 'CANNOT_UPDATE', check.reason ?? 'This is already the newest version.');
  if (check.latest.sha !== expected) throw new AppError(409, 'CHANGED', 'GitHub has an even newer version since you checked. Check again to see it.');
  process.send!({ type: 'bas:update', target: check.latest.sha });
  return { target: check.latest.sha };
}
