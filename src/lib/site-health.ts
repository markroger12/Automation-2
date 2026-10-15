import { db } from '@/lib/db';
import { log } from '@/lib/log';

/**
 * Per-site WordPress health (upgrade 09). Every observation is a measured
 * result (a session test, a draft save, an upload); the summary only reads
 * them back. Observations older than 30 days are pruned.
 */

import { HEALTH_KINDS, HEALTH_KIND_LABEL, type HealthEntry, type HealthKind, type HealthStatus, type OverallHealth, type SiteHealthSummary } from './site-health-types';

export { HEALTH_KINDS, HEALTH_KIND_LABEL };
export type { HealthEntry, HealthKind, HealthStatus, OverallHealth, SiteHealthSummary };

const KEEP_MS = 30 * 24 * 3600_000;
const DAY_MS = 24 * 3600_000;

export async function observe(websiteId: string, kind: HealthKind, status: HealthStatus, message: string, extra: { durationMs?: number | null; taskId?: string | null; details?: Record<string, unknown> } = {}): Promise<void> {
  try {
    await db.siteHealthObservation.create({
      data: {
        websiteId,
        kind,
        status,
        message: message.slice(0, 500),
        durationMs: extra.durationMs == null ? null : Math.max(0, Math.round(extra.durationMs)),
        taskId: extra.taskId ?? null,
        details: JSON.stringify(extra.details ?? {}),
      },
    });
    await db.siteHealthObservation.deleteMany({ where: { websiteId, createdAt: { lt: new Date(Date.now() - KEEP_MS) } } });
  } catch (error) {
    // Health evidence must never break the work it describes.
    await log({ level: 'warn', category: 'wordpress', message: `Could not record a site health observation (${kind}): ${(error as Error).message}` }).catch(() => {});
  }
}

function entry(o: { kind: string; status: string; message: string; durationMs: number | null; taskId: string | null; createdAt: Date }): HealthEntry {
  return { kind: o.kind as HealthKind, status: o.status as HealthStatus, message: o.message, durationMs: o.durationMs, taskId: o.taskId, at: o.createdAt.toISOString() };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export async function siteHealth(websiteId: string, now = new Date()): Promise<SiteHealthSummary> {
  const site = await db.website.findUnique({ where: { id: websiteId }, select: { wordpressProfile: { select: { sessionState: true } } } });
  const sessionState = site?.wordpressProfile?.sessionState ?? null;
  const latestRows = await Promise.all(HEALTH_KINDS.map((kind) => db.siteHealthObservation.findFirst({ where: { websiteId, kind }, orderBy: { createdAt: 'desc' } })));
  const latest: SiteHealthSummary['latest'] = {};
  for (const r of latestRows) if (r) latest[r.kind as HealthKind] = entry(r);
  const since = new Date(now.getTime() - DAY_MS);
  const day = await db.siteHealthObservation.findMany({ where: { websiteId, kind: { in: ['DRAFT_SAVE', 'MEDIA_UPLOAD'] }, createdAt: { gte: since } }, select: { kind: true, status: true, durationMs: true } });
  const saves = day.filter((d) => d.kind === 'DRAFT_SAVE');
  const uploads = day.filter((d) => d.kind === 'MEDIA_UPLOAD');
  const last24h = {
    draftSaves: saves.length,
    draftFailures: saves.filter((d) => d.status === 'FAIL').length,
    uploads: uploads.length,
    uploadFailures: uploads.filter((d) => d.status === 'FAIL').length,
    medianDraftSaveMs: median(saves.filter((d) => d.status !== 'FAIL' && d.durationMs != null).map((d) => d.durationMs!)),
  };
  const recentRows = await db.siteHealthObservation.findMany({ where: { websiteId }, orderBy: { createdAt: 'desc' }, take: 25 });
  const recent = recentRows.map(entry);

  const lastSaves = await db.siteHealthObservation.findMany({ where: { websiteId, kind: 'DRAFT_SAVE' }, orderBy: { createdAt: 'desc' }, take: 3, select: { status: true } });
  const reasons: string[] = [];
  let failing = false;
  let warning = false;
  if (sessionState === 'LOGIN_REQUIRED') {
    failing = true;
    reasons.push('Logged out of WordPress: use “Log in” on the website page.');
  }
  for (const kind of ['SESSION', 'REST', 'PERMISSIONS'] as const) {
    const l = latest[kind];
    // A later successful draft save proves the session, REST and the right to create posts work again;
    // it proves nothing about a warning such as “may not upload images”, which stays.
    const supersededBySave = l && latest.DRAFT_SAVE?.status === 'OK' && latest.DRAFT_SAVE.at > l.at;
    if (l?.status === 'FAIL' && !supersededBySave) {
      if (!(kind === 'SESSION' && sessionState === 'LOGIN_REQUIRED')) reasons.push(`${HEALTH_KIND_LABEL[kind]}: ${l.message}`);
      failing = true;
    } else if (l?.status === 'WARN') {
      warning = true;
      reasons.push(`${HEALTH_KIND_LABEL[kind]}: ${l.message}`);
    }
  }
  for (const kind of ['EDITOR', 'RANK_MATH'] as const) {
    const l = latest[kind];
    if (l && l.status !== 'OK') {
      warning = true;
      reasons.push(`${HEALTH_KIND_LABEL[kind]}: ${l.message}`);
    }
  }
  if (lastSaves.length === 3 && lastSaves.every((s) => s.status === 'FAIL')) {
    failing = true;
    reasons.push('The last 3 draft saves failed.');
  } else if (last24h.draftFailures) {
    warning = true;
    reasons.push(`${last24h.draftFailures} of ${last24h.draftSaves} draft save(s) failed in the last 24 hours.`);
  }
  if (last24h.uploadFailures) {
    warning = true;
    reasons.push(`${last24h.uploadFailures} media upload(s) failed in the last 24 hours.`);
  }
  const any = recent.length > 0 || sessionState === 'LOGIN_REQUIRED';
  const overall: OverallHealth = !any ? 'UNKNOWN' : failing ? 'FAIL' : warning ? 'WARN' : 'OK';
  return { websiteId, overall, reasons: overall === 'OK' ? [] : reasons, latest, last24h, sessionState, recent };
}
