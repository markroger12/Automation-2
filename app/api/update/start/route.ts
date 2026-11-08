import { z } from 'zod';
import { route } from '@/lib/api';
import { audit } from '@/lib/audit';
import { startUpdate } from '@/lib/update/service';

export const dynamic = 'force-dynamic';

/** Start the update to the version the owner was shown (its commit); npm run start:all does the rest. */
export const POST = route({ body: z.object({ target: z.string().regex(/^[0-9a-f]{40}$/) }) }, async ({ body }) => {
  const { target } = await startUpdate(body.target);
  await audit('app.update', 'App', target.slice(0, 12), {});
  return { ok: true, target };
});
