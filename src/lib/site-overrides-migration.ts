import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { dataPaths } from './paths';
import { parseJson, toJson } from './json';
import { defaultSettings, SITE_OVERRIDE_KEYS } from './settings-schema';

/**
 * Before M9 a website's override groups were saved with every shipped default
 * filled in (a schema bug), which silently pinned each site to the defaults
 * and hid later global changes. This migration clears a group ONLY when it
 * holds exactly the full set of shipped defaults — that bug's signature, not
 * something an owner would type. Any group where a value differs is kept
 * untouched and counted. A backup of every changed site is written first.
 */
export const SITE_OVERRIDES_MIGRATION_ID = '2026-10-14-unpin-default-site-overrides';

/** Keys added to the override groups after this migration was written: not part of the bug's signature. */
const LATER_KEYS = new Set(['holdForReview']);

export async function unpinDefaultSiteOverrides(client: PrismaClient): Promise<Record<string, unknown>> {
  const defaults = defaultSettings() as unknown as Record<string, Record<string, unknown>>;
  const sites = await client.website.findMany({ select: { id: true, settingsOverrides: true } });
  const changes: { id: string; before: string; after: string; groups: string[] }[] = [];
  let kept = 0;
  for (const site of sites) {
    const stored = parseJson<Record<string, Record<string, unknown>>>(site.settingsOverrides, {});
    const next = { ...stored };
    const groups: string[] = [];
    for (const [group, allKeys] of Object.entries(SITE_OVERRIDE_KEYS)) {
      const keys = (allKeys as readonly string[]).filter((k) => !LATER_KEYS.has(k));
      const values = stored[group];
      if (!values || typeof values !== 'object') continue;
      const pinned = keys.every((k) => k in values && JSON.stringify(values[k]) === JSON.stringify(defaults[group][k]));
      if (pinned) {
        next[group] = Object.fromEntries(Object.entries(values).filter(([k]) => !(keys as readonly string[]).includes(k)));
        groups.push(group);
      } else if (keys.some((k) => k in values)) kept++;
    }
    if (groups.length) changes.push({ id: site.id, before: site.settingsOverrides, after: toJson(next), groups });
  }
  let backupFile: string | null = null;
  if (changes.length) {
    const dir = path.join(dataPaths.backups(), 'migrations');
    fs.mkdirSync(dir, { recursive: true });
    backupFile = path.join(dir, `${SITE_OVERRIDES_MIGRATION_ID}-${Date.now()}.json`);
    fs.writeFileSync(backupFile, JSON.stringify({ id: SITE_OVERRIDES_MIGRATION_ID, createdAt: new Date().toISOString(), sites: changes.map((c) => ({ id: c.id, settingsOverrides: c.before })) }, null, 2));
    await client.$transaction(changes.map((c) => client.website.update({ where: { id: c.id }, data: { settingsOverrides: c.after } })));
  }
  return { sitesUnpinned: changes.length, groupsCleared: changes.reduce((n, c) => n + c.groups.length, 0), groupsWithOwnerValuesKept: kept, backupFile: backupFile ? path.basename(backupFile) : null };
}
