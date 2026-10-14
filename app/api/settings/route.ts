import { z } from 'zod';
import { route } from '@/lib/api';
import { getSettings, updateSettings } from '@/lib/settings';
import { settingsSchema } from '@/lib/settings-schema';
import { audit } from '@/lib/audit';

export const GET = route({}, async () => ({ settings: await getSettings() }));

const patchSchema = z.object({ settings: z.record(z.string(), z.unknown()) });

export const PUT = route({ body: patchSchema }, async ({ body }) => {
  // Validate the merged result against the full schema (field errors surface to the form).
  const before = await getSettings();
  const merged = { ...before, ...body.settings };
  settingsSchema.parse(merged);
  const saved = await updateSettings(body.settings);
  await audit('settings.update', 'Setting', 'global', { groups: Object.keys(body.settings) });
  return { settings: saved };
});
