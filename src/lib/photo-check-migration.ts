import type { PrismaClient } from '@prisma/client';
import { parseJson, toJson } from './json';

/**
 * Owner report (2026-10-21): a designed thumbnail of another site (a photo with a circle drawn around one person) became
 * half of a featured image. The earlier tool asked ChatGPT which photos are collages, on by default; here the check was
 * off by default, so it never ran. This turns the saved global switch on once, and for articles that are not finished
 * yet (their settings were fixed when they started), so a retry of their images runs the check.
 */
export const PHOTO_CHECK_MIGRATION_ID = '2026-10-21-celebrity-photo-check-on';

export async function celebrityPhotoCheckOn(client: PrismaClient): Promise<Record<string, unknown>> {
  const row = await client.setting.findUnique({ where: { key: 'global' } });
  const stored = row ? parseJson<Record<string, Record<string, unknown>>>(row.value, {}) : null;
  const before = stored?.seo?.celebrityPhotoReview;
  if (row && stored && before === false) {
    await client.setting.update({ where: { key: 'global' }, data: { value: toJson({ ...stored, seo: { ...(stored.seo ?? {}), celebrityPhotoReview: true } }) } });
  }
  const open = await client.articleTask.findMany({ where: { moduleKey: 'celebrity-writer', status: { notIn: ['COMPLETED', 'CANCELLED'] } }, select: { id: true, configSnapshot: true } });
  const changed: string[] = [];
  for (const t of open) {
    const snap = parseJson<Record<string, unknown>>(t.configSnapshot, {});
    if (snap.celebrityPhotoReview !== false) continue;
    await client.articleTask.update({ where: { id: t.id }, data: { configSnapshot: JSON.stringify({ ...snap, celebrityPhotoReview: true }) } });
    changed.push(t.id);
  }
  return { globalBefore: before ?? null, globalChanged: before === false, unfinishedArticlesChanged: changed };
}
