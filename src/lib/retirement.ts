import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { LEGACY_MODULE_KEYS } from './domain';
import { dataPaths } from './paths';
import { parseJson, toJson } from './json';

/**
 * Celebrity Writer 2.0 retirement (spec §7.2): a versioned, idempotent data
 * migration. It never deletes or rewrites history:
 *  - 2.0 tasks become read-only legacy records (outputs, post IDs, logs kept);
 *  - unfinished 2.0 tasks → NEEDS_REVIEW with an explicit "Retired writer"
 *    action, and their waiting/active queue jobs are cancelled (not deleted);
 *  - stored future-writer preferences (global settings, site overrides) that
 *    point at 2.0 are moved to the Celebrity Article Writer;
 *  - custom 2.0 prompt templates are kept untouched.
 * Before changing anything it writes a backup of every value it will change
 * (data/backups/migrations/), which `rollbackRetirement` restores.
 */

export const RETIREMENT_MIGRATION_ID = '2026-10-14-retire-celebrity-writer-2';
export const RETIRED_MESSAGE = 'Retired writer — choose a supported writer to create a new task.';
const FINISHED = ['COMPLETED', 'FAILED', 'CANCELLED', 'DRAFT_CREATED'];
const LEGACY = [...LEGACY_MODULE_KEYS] as string[];

interface Backup {
  id: string;
  createdAt: string;
  settings: { key: string; value: string }[];
  sites: { id: string; settingsOverrides: string }[];
  tasks: { id: string; status: string; legacy: boolean; message: string | null; nextAction: string | null; reviewReasons: string }[];
  jobs: { id: string; status: string; errorCode: string | null; error: string | null }[];
}

/** Replace 2.0 writer preferences inside any JSON value; returns the new value and whether it changed. */
export function migrateWriterPreferences(value: unknown): { value: unknown; changed: boolean } {
  let changed = false;
  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (LEGACY.includes(v)) {
        changed = true;
        return 'celebrity-writer';
      }
      if (key === 'workflowCelebrityWriter' && v !== '1.0') {
        changed = true;
        return '1.0';
      }
      return v;
    }
    if (Array.isArray(v)) {
      const mapped = v.map((x) => walk(x));
      // A list of writers must not end up with the same writer twice.
      if (mapped.every((x) => typeof x === 'string')) return [...new Set(mapped as string[])];
      return mapped;
    }
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
    return v;
  };
  return { value: walk(value), changed };
}

export async function retireCelebrityWriter2(client: PrismaClient): Promise<Record<string, unknown>> {
  const tasks = await client.articleTask.findMany({ where: { OR: [{ moduleKey: { in: LEGACY } }, { legacy: true }] }, select: { id: true, status: true, legacy: true, message: true, nextAction: true, reviewReasons: true } });
  const taskIds = tasks.map((t) => t.id);
  const jobs = taskIds.length ? await client.queueJob.findMany({ where: { taskId: { in: taskIds }, status: { in: ['WAITING', 'ACTIVE'] } }, select: { id: true, status: true, errorCode: true, error: true } }) : [];
  const settingRows = await client.setting.findMany();
  const settingChanges = settingRows.map((r) => ({ row: r, next: migrateWriterPreferences(parseJson<unknown>(r.value, null)) })).filter((x) => x.next.changed);
  const sites = await client.website.findMany({ select: { id: true, settingsOverrides: true } });
  const siteChanges = sites.map((s) => ({ site: s, next: migrateWriterPreferences(parseJson<unknown>(s.settingsOverrides, {})) })).filter((x) => x.next.changed);
  const unfinished = tasks.filter((t) => !FINISHED.includes(t.status));
  const prompts = await client.promptTemplate.count({ where: { moduleKey: { in: LEGACY } } });

  let backupFile: string | null = null;
  if (tasks.length || settingChanges.length || siteChanges.length) {
    const backup: Backup = {
      id: RETIREMENT_MIGRATION_ID,
      createdAt: new Date().toISOString(),
      settings: settingChanges.map((x) => ({ key: x.row.key, value: x.row.value })),
      sites: siteChanges.map((x) => ({ id: x.site.id, settingsOverrides: x.site.settingsOverrides })),
      tasks,
      jobs,
    };
    const dir = path.join(dataPaths.backups(), 'migrations');
    fs.mkdirSync(dir, { recursive: true });
    backupFile = path.join(dir, `${RETIREMENT_MIGRATION_ID}-${Date.now()}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(backup, null, 2));
  }

  await client.$transaction(async (tx) => {
    if (taskIds.length) await tx.articleTask.updateMany({ where: { id: { in: taskIds } }, data: { legacy: true } });
    for (const t of unfinished) {
      const reasons = parseJson<string[]>(t.reviewReasons, []);
      await tx.articleTask.update({
        where: { id: t.id },
        data: { status: 'NEEDS_REVIEW', message: RETIRED_MESSAGE, nextAction: 'Create a new task with the Celebrity Article Writer or the Tigram Article Writer. This record stays read-only.', reviewReasons: JSON.stringify([...reasons.filter((r) => r !== RETIRED_MESSAGE), RETIRED_MESSAGE]) },
      });
    }
    if (jobs.length) await tx.queueJob.updateMany({ where: { id: { in: jobs.map((j) => j.id) } }, data: { status: 'CANCELLED', errorCode: 'RETIRED_WRITER', error: RETIRED_MESSAGE, lockedBy: null, leaseUntil: null, finishedAt: new Date() } });
    for (const x of settingChanges) await tx.setting.update({ where: { key: x.row.key }, data: { value: toJson(x.next.value) } });
    for (const x of siteChanges) await tx.website.update({ where: { id: x.site.id }, data: { settingsOverrides: toJson(x.next.value) } });
  });

  return { legacyTasks: tasks.length, unfinishedMarkedForReview: unfinished.length, jobsCancelled: jobs.length, settingsMigrated: settingChanges.length, sitesMigrated: siteChanges.length, legacyPromptsKept: prompts, backupFile: backupFile ? path.basename(backupFile) : null };
}

/**
 * Restore every value the retirement changed (from its backup) and forget
 * that it ran. Nothing is deleted. The next setup will apply it again unless
 * the owner investigates first.
 */
export async function rollbackRetirement(client: PrismaClient, backupFile: string): Promise<Record<string, number>> {
  const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8')) as Backup;
  if (backup.id !== RETIREMENT_MIGRATION_ID) throw new Error(`${backupFile} is not a backup of ${RETIREMENT_MIGRATION_ID}.`);
  await client.$transaction(async (tx) => {
    for (const s of backup.settings) await tx.setting.update({ where: { key: s.key }, data: { value: s.value } });
    for (const s of backup.sites) await tx.website.update({ where: { id: s.id }, data: { settingsOverrides: s.settingsOverrides } });
    for (const t of backup.tasks) await tx.articleTask.update({ where: { id: t.id }, data: { status: t.status, legacy: t.legacy, message: t.message, nextAction: t.nextAction, reviewReasons: t.reviewReasons } });
    for (const j of backup.jobs) await tx.queueJob.update({ where: { id: j.id }, data: { status: j.status === 'ACTIVE' ? 'WAITING' : j.status, errorCode: j.errorCode, error: j.error } });
    await tx.dataMigration.deleteMany({ where: { id: RETIREMENT_MIGRATION_ID } });
  });
  return { settings: backup.settings.length, sites: backup.sites.length, tasks: backup.tasks.length, jobs: backup.jobs.length };
}
