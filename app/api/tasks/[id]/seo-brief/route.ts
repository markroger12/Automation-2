import { z } from 'zod';
import { route } from '@/lib/api';
import { getSeoBrief, resetSeoBrief, saveSeoBrief } from '@/lib/tasks/seo-brief';

export const GET = route({}, async ({ params }) => getSeoBrief(params.id));

/** Save the owner's edited brief (validated, audited). It is used by the next writing prompt and the SEO checks. */
export const PUT = route({ body: z.record(z.string(), z.unknown()) }, async ({ params, body }) => saveSeoBrief(params.id, body));

/** Back to the suggestion from the intent rules. */
export const DELETE = route({}, async ({ params }) => resetSeoBrief(params.id));
