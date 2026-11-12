import { z } from 'zod';
import { route } from '@/lib/api';
import { setSetupDismissed, setupState } from '@/lib/setup';

/** The first-run checklist (Overview banner, Setup checklist page), read again every few seconds while it is open. */
export const GET = route({}, async () => setupState());

/** Hide the checklist on the Overview, or show it again. */
export const PUT = route({ body: z.object({ dismissed: z.boolean() }) }, async ({ body }) => {
  await setSetupDismissed(body.dismissed);
  return setupState();
});
