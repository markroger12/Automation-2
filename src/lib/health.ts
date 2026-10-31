import { db } from './db';
import { parseJson } from './json';

export const WORKER_HEARTBEAT_MS = 10_000;
/** A worker is considered alive only if its heartbeat is fresh. */
export const WORKER_STALE_MS = 45_000;
export const EXTENSION_STALE_MS = 120_000;

export interface WorkerHealth {
  state: 'online' | 'stale' | 'offline';
  lastSeenAt: Date | null;
  pid: number | null;
  version: string | null;
  diagnostics: Record<string, unknown>;
}

export interface ExtensionHealth {
  state: 'connected' | 'stale' | 'never';
  lastSeenAt: Date | null;
  version: string | null;
  installs: number;
  tabs: number;
  diagnostics: Record<string, unknown>;
}

export async function getWorkerHealth(now = new Date()): Promise<WorkerHealth> {
  const row = await db.workerStatus.findUnique({ where: { id: 'worker' } });
  if (!row) return { state: 'offline', lastSeenAt: null, pid: null, version: null, diagnostics: {} };
  const age = now.getTime() - row.lastSeenAt.getTime();
  const state = row.status === 'STOPPED' ? 'offline' : age <= WORKER_STALE_MS ? 'online' : 'stale';
  return {
    state,
    lastSeenAt: row.lastSeenAt,
    pid: row.pid,
    version: row.version,
    diagnostics: parseJson<Record<string, unknown>>(row.diagnostics, {}),
  };
}

export async function getExtensionHealth(now = new Date()): Promise<ExtensionHealth> {
  const rows = await db.workerStatus.findMany({ where: { kind: 'EXTENSION' }, orderBy: { lastSeenAt: 'desc' } });
  if (rows.length === 0) return { state: 'never', lastSeenAt: null, version: null, installs: 0, tabs: 0, diagnostics: {} };
  const latest = rows[0];
  const fresh = rows.filter((r) => now.getTime() - r.lastSeenAt.getTime() <= EXTENSION_STALE_MS);
  const tabs = fresh.reduce((sum, r) => sum + Number(parseJson<Record<string, unknown>>(r.diagnostics, {}).tabs ?? 0), 0);
  return {
    state: fresh.length > 0 ? 'connected' : 'stale',
    lastSeenAt: latest.lastSeenAt,
    version: latest.version,
    installs: rows.length,
    tabs,
    diagnostics: parseJson<Record<string, unknown>>(latest.diagnostics, {}),
  };
}

export interface HealthWarning {
  tone: 'warning' | 'danger' | 'info';
  title: string;
  detail: string;
  href?: string;
  action?: string;
}

/** Actionable warnings shown on every page. Never invents state. */
export async function getHealthWarnings(): Promise<HealthWarning[]> {
  const [worker, extension, loginSites, loginTasks, siteCount] = await Promise.all([
    getWorkerHealth(),
    getExtensionHealth(),
    db.website.findMany({
      where: { active: true, wordpressProfile: { sessionState: 'LOGIN_REQUIRED' } },
      select: { id: true, name: true },
      take: 5,
    }),
    db.articleTask.count({ where: { status: 'LOGIN_REQUIRED' } }),
    db.website.count({ where: { active: true } }),
  ]);
  const warnings: HealthWarning[] = [];
  if (worker.state !== 'online') {
    warnings.push({
      tone: 'danger',
      title: worker.state === 'stale' ? 'Worker heartbeat is stale' : 'Worker is not running',
      detail:
        worker.state === 'stale'
          ? `Last heartbeat ${worker.lastSeenAt?.toLocaleTimeString() ?? 'unknown'}. Queued work will not progress until the worker is back.`
          : 'Start it with `npm run dev:all` (or `npm run worker`). Tasks stay safely queued meanwhile.',
      href: '/diagnostics',
      action: 'Diagnostics',
    });
  }
  if (extension.state !== 'connected') {
    warnings.push({
      tone: 'warning',
      title: extension.state === 'never' ? 'ChatGPT extension not connected yet' : 'ChatGPT extension is not responding',
      detail: 'Open Automation Chrome with the extension loaded and paired. ChatGPT stages wait until it connects.',
      href: '/automation-chrome',
      action: 'Set up',
    });
  }
  if (siteCount === 0) {
    warnings.push({ tone: 'info', title: 'No WordPress website yet', detail: 'Add a website and log in once to create drafts.', href: '/websites', action: 'Add website' });
  }
  for (const site of loginSites) {
    warnings.push({ tone: 'warning', title: `WordPress login required: ${site.name}`, detail: 'Log in on the website page (with a saved sign-in the app does it by itself); paused tasks resume automatically.', href: `/websites/${site.id}`, action: 'Log in' });
  }
  if (loginTasks > 0 && loginSites.length === 0) {
    warnings.push({ tone: 'warning', title: `${loginTasks} task(s) waiting for a login`, detail: 'ChatGPT or WordPress asked for sign-in or a human check.', href: '/queue?group=paused', action: 'Open queue' });
  }
  return warnings;
}
