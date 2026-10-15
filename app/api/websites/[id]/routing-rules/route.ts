import { z } from 'zod';
import { route } from '@/lib/api';
import { getRoutingRules, saveRoutingRules } from '@/lib/websites';

export const GET = route({}, async ({ params }) => ({ rules: await getRoutingRules(params.id) }));

/** Replace the website's writer routing rules (validated, de-duplicated, audited). */
export const PUT = route({ body: z.record(z.string(), z.unknown()) }, async ({ params, body }) => ({ rules: await saveRoutingRules(params.id, body) }));
