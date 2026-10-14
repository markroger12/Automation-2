import { z } from 'zod';
import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { getValue, setValue } from '@/lib/settings';
import { CLAIMS_PAUSED_KEY } from '@/lib/agent/handler';
import { audit } from '@/lib/audit';

export const GET = route({}, async () => ({
  paused: await getValue<boolean>(CLAIMS_PAUSED_KEY, false),
  active: await db.queueJob.count({ where: { queue: 'chatgpt', status: 'ACTIVE' } }),
}));

/** Pause/resume NEW ChatGPT claims (graceful drain before restarting Chrome). Active jobs finish normally. */
export const PUT = route({ body: z.object({ paused: z.boolean() }) }, async ({ body }) => {
  await setValue(CLAIMS_PAUSED_KEY, body.paused);
  await audit(body.paused ? 'extension.claims.pause' : 'extension.claims.resume', 'Setting', CLAIMS_PAUSED_KEY, {});
  return { paused: body.paused, active: await db.queueJob.count({ where: { queue: 'chatgpt', status: 'ACTIVE' } }) };
});
