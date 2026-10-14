import { db, type Tx } from './db';
import { parseJson, toJson } from './json';
import {
  SETTINGS_SCHEMA_VERSION,
  defaultSettings,
  settingsSchema,
  siteOverridesSchema,
  type Settings,
  type SiteOverrides,
} from './settings-schema';

const GLOBAL_KEY = 'global';

function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return (patch === undefined ? base : (patch as T));
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return out as T;
}

/** Read global settings, filling any missing keys with defaults. */
export async function getSettings(client: Tx = db): Promise<Settings> {
  const row = await client.setting.findUnique({ where: { key: GLOBAL_KEY } });
  const stored = parseJson<unknown>(row?.value, {});
  const merged = deepMerge(defaultSettings(), stored);
  const parsed = settingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaultSettings();
}

/** Validate and persist a partial settings patch. Returns the saved value. */
export async function updateSettings(patch: unknown, client: Tx = db): Promise<Settings> {
  const current = await getSettings(client);
  const next = settingsSchema.parse(deepMerge(current, patch));
  await client.setting.upsert({
    where: { key: GLOBAL_KEY },
    create: { key: GLOBAL_KEY, value: toJson(next), schemaVersion: SETTINGS_SCHEMA_VERSION },
    update: { value: toJson(next), schemaVersion: SETTINGS_SCHEMA_VERSION },
  });
  return next;
}

/** Seed defaults only when no settings row exists (never overwrites). */
export async function seedSettings(client: Tx = db): Promise<boolean> {
  const existing = await client.setting.findUnique({ where: { key: GLOBAL_KEY } });
  if (existing) return false;
  await client.setting.create({
    data: { key: GLOBAL_KEY, value: toJson(defaultSettings()), schemaVersion: SETTINGS_SCHEMA_VERSION },
  });
  return true;
}

export function parseSiteOverrides(raw: string | null | undefined): SiteOverrides {
  const parsed = siteOverridesSchema.safeParse(parseJson<unknown>(raw, {}));
  return parsed.success ? parsed.data : siteOverridesSchema.parse({});
}

/** Generic small key/value store for typed JSON values (secrets hashes, flags). */
export async function getValue<T>(key: string, fallback: T, client: Tx = db): Promise<T> {
  const row = await client.setting.findUnique({ where: { key } });
  return parseJson<T>(row?.value, fallback);
}

export async function setValue(key: string, value: unknown, client: Tx = db): Promise<void> {
  await client.setting.upsert({ where: { key }, create: { key, value: toJson(value) }, update: { value: toJson(value) } });
}
