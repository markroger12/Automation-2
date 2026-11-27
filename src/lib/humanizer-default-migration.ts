import type { PrismaClient } from '@prisma/client';
import { parseJson, toJson } from './json';

/**
 * Owner decision (2026-10-21): the editorial humanizer is off by default and switched on per website (website
 * settings → Humanizer). Global settings saved earlier hold `humanizerEnabled: true` (the old default), so the new
 * default would not apply: this turns the global switch off once. Websites set to On keep it.
 */
export const HUMANIZER_DEFAULT_MIGRATION_ID = '2026-10-21-humanizer-off-by-default';

export async function humanizerOffByDefault(client: PrismaClient): Promise<Record<string, unknown>> {
  const row = await client.setting.findUnique({ where: { key: 'global' } });
  if (!row) return { changed: false, reason: 'no saved settings (the new default applies)' };
  const stored = parseJson<Record<string, Record<string, unknown>>>(row.value, {});
  const before = stored.content?.humanizerEnabled;
  if (before === false) return { changed: false, before };
  await client.setting.update({ where: { key: 'global' }, data: { value: toJson({ ...stored, content: { ...(stored.content ?? {}), humanizerEnabled: false } }) } });
  const sitesOn = (await client.website.findMany({ select: { settingsOverrides: true } })).filter((s) => parseJson<{ content?: { humanizerEnabled?: boolean } }>(s.settingsOverrides, {}).content?.humanizerEnabled === true).length;
  return { changed: true, before: before ?? null, sitesStillOn: sitesOn };
}
